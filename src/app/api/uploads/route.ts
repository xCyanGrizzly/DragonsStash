import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/data/uploads";
const MAX_FILE_SIZE = 4 * 1024 * 1024 * 1024; // 4GB per file

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    const groupName = formData.get("groupName") as string | null;

    if (!files.length) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    // Create the upload record
    const upload = await prisma.manualUpload.create({
      data: {
        userId: session.user.id,
        groupName: groupName || (files.length > 1 ? files[0].name.replace(/\.[^.]+$/, "") : null),
        status: "PENDING",
      },
    });

    // Save files to shared volume
    const uploadDir = path.join(UPLOAD_DIR, upload.id);
    await mkdir(uploadDir, { recursive: true });

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File "${file.name}" exceeds 4GB limit` },
          { status: 400 }
        );
      }

      const filePath = path.join(uploadDir, file.name);
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(filePath, buffer);

      await prisma.manualUploadFile.create({
        data: {
          uploadId: upload.id,
          fileName: file.name,
          filePath,
          fileSize: BigInt(file.size),
        },
      });
    }

    // Notify worker
    try {
      await prisma.$queryRawUnsafe(
        `SELECT pg_notify('manual_upload', $1)`,
        upload.id
      );
    } catch {
      // Best-effort
    }

    return NextResponse.json({
      uploadId: upload.id,
      fileCount: files.length,
      status: "PENDING",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 500 }
    );
  }
}
