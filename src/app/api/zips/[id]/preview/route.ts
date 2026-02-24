import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";

/**
 * GET /api/zips/:id/preview
 * Returns the preview thumbnail image as JPEG binary.
 * Cached for 1 hour (immutable once set).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { id } = await params;

  const pkg = await prisma.package.findUnique({
    where: { id },
    select: { previewData: true },
  });

  if (!pkg || !pkg.previewData) {
    return new NextResponse(null, { status: 404 });
  }

  // previewData is stored as Bytes (Buffer) from Prisma
  const buffer =
    pkg.previewData instanceof Buffer
      ? pkg.previewData
      : Buffer.from(pkg.previewData);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=3600, immutable",
    },
  });
}
