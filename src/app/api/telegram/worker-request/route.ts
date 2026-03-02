import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET: Poll for the result of a worker request (ChannelFetchRequest used as generic request).
 * Query param: ?requestId=xxx
 */
export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request, true);
  if ("error" in authResult) return authResult.error;

  const url = new URL(request.url);
  const requestId = url.searchParams.get("requestId");

  if (!requestId) {
    return NextResponse.json(
      { error: "requestId is required" },
      { status: 400 }
    );
  }

  const fetchRequest = await prisma.channelFetchRequest.findUnique({
    where: { id: requestId },
  });

  if (!fetchRequest) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  return NextResponse.json({
    requestId: fetchRequest.id,
    status: fetchRequest.status,
    error: fetchRequest.error,
    result: fetchRequest.status === "COMPLETED" && fetchRequest.resultJson
      ? JSON.parse(fetchRequest.resultJson)
      : null,
  });
}
