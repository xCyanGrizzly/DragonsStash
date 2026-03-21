import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

/**
 * GET /api/zips/:id/images
 * Lists image files inside a package's archive (from PackageFile records).
 * Returns a list of image file paths that can be used as preview candidates.
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
    select: { id: true, archiveType: true },
  });

  if (!pkg) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }

  const images = await prisma.packageFile.findMany({
    where: {
      packageId: id,
      extension: { in: IMAGE_EXTENSIONS },
    },
    orderBy: { path: "asc" },
    select: {
      id: true,
      path: true,
      fileName: true,
      extension: true,
      uncompressedSize: true,
    },
  });

  const mapped = images.map((img) => ({
    id: img.id,
    path: img.path,
    fileName: img.fileName,
    extension: img.extension,
    size: img.uncompressedSize.toString(),
  }));

  return NextResponse.json({ images: mapped });
}
