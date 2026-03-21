import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/zips/:id/extract/:requestId
 * Get the status and/or image data for an extraction request.
 * Query param: ?image=true returns the raw image bytes if completed.
 * Otherwise returns status JSON.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> }
) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const { requestId } = await params;
  const url = new URL(request.url);
  const wantImage = url.searchParams.get("image") === "true";

  if (wantImage) {
    // Return the raw image bytes
    const req = await prisma.archiveExtractRequest.findUnique({
      where: { id: requestId },
      select: { status: true, imageData: true, contentType: true, error: true },
    });

    if (!req) {
      return new NextResponse(null, { status: 404 });
    }

    if (req.status !== "COMPLETED" || !req.imageData) {
      return NextResponse.json(
        { status: req.status, error: req.error },
        { status: req.status === "FAILED" ? 400 : 202 }
      );
    }

    const buffer =
      req.imageData instanceof Buffer
        ? req.imageData
        : Buffer.from(req.imageData);

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": req.contentType || "image/jpeg",
        "Content-Length": String(buffer.length),
        "Cache-Control": "public, max-age=3600, immutable",
      },
    });
  }

  // Return status JSON (without image data to avoid large payloads)
  const req = await prisma.archiveExtractRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, error: true, contentType: true },
  });

  if (!req) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  return NextResponse.json({
    requestId: req.id,
    status: req.status,
    error: req.error,
    contentType: req.contentType,
  });
}
