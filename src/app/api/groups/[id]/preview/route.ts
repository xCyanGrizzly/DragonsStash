import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { id } = await params;

  const group = await prisma.packageGroup.findUnique({
    where: { id },
    select: { previewData: true },
  });

  if (!group || !group.previewData) {
    return new NextResponse(null, { status: 404 });
  }

  const buffer =
    group.previewData instanceof Buffer
      ? group.previewData
      : Buffer.from(group.previewData);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=3600, immutable",
    },
  });
}
