import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const upload = await prisma.manualUpload.findUnique({
    where: { id },
    include: {
      files: {
        select: { id: true, fileName: true, fileSize: true, packageId: true },
      },
    },
  });

  if (!upload || upload.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: upload.id,
    status: upload.status,
    groupName: upload.groupName,
    errorMessage: upload.errorMessage,
    files: upload.files.map((f) => ({
      ...f,
      fileSize: f.fileSize.toString(),
    })),
    createdAt: upload.createdAt.toISOString(),
    completedAt: upload.completedAt?.toISOString() ?? null,
  });
}
