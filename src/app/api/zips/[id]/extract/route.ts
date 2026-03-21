import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/zips/:id/extract
 * Request extraction of an image from a package archive.
 * Body: { filePath: string }
 * Returns: { requestId: string, status: string }
 *
 * If a completed extraction already exists for this package+filePath,
 * returns it immediately.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { id } = await params;
  const body = await request.json();
  const filePath = body?.filePath;

  if (!filePath || typeof filePath !== "string") {
    return NextResponse.json(
      { error: "filePath is required" },
      { status: 400 }
    );
  }

  // Verify package exists
  const pkg = await prisma.package.findUnique({
    where: { id },
    select: { id: true, destChannelId: true, destMessageId: true, archiveType: true, isMultipart: true, partCount: true },
  });

  if (!pkg) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }

  if (!pkg.destChannelId || !pkg.destMessageId) {
    return NextResponse.json(
      { error: "Package has not been uploaded to destination channel" },
      { status: 400 }
    );
  }

  if (pkg.archiveType === "DOCUMENT") {
    return NextResponse.json(
      { error: "Cannot extract images from standalone documents" },
      { status: 400 }
    );
  }

  if (pkg.isMultipart && pkg.partCount > 1) {
    return NextResponse.json(
      { error: "Image extraction is not supported for multipart archives" },
      { status: 400 }
    );
  }

  // Check for an existing completed extraction
  const existing = await prisma.archiveExtractRequest.findFirst({
    where: {
      packageId: id,
      filePath,
      status: "COMPLETED",
      imageData: { not: null },
    },
    select: { id: true, status: true },
  });

  if (existing) {
    return NextResponse.json({
      requestId: existing.id,
      status: "COMPLETED",
    });
  }

  // Check for an in-progress request
  const pending = await prisma.archiveExtractRequest.findFirst({
    where: {
      packageId: id,
      filePath,
      status: { in: ["PENDING", "IN_PROGRESS"] },
    },
    select: { id: true, status: true },
  });

  if (pending) {
    return NextResponse.json({
      requestId: pending.id,
      status: pending.status,
    });
  }

  // Create a new extraction request
  const extractRequest = await prisma.archiveExtractRequest.create({
    data: {
      packageId: id,
      filePath,
    },
  });

  // Notify the worker via pg_notify
  await prisma.$queryRawUnsafe(
    `SELECT pg_notify('archive_extract', $1)`,
    extractRequest.id
  );

  return NextResponse.json({
    requestId: extractRequest.id,
    status: "PENDING",
  });
}
