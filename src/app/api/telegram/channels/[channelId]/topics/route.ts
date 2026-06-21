import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { listChannelTopics } from "@/lib/telegram/admin-queries";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const authResult = await authenticateApiRequest(request, true);
  if ("error" in authResult) return authResult.error;

  const { channelId } = await params;
  const topics = await listChannelTopics(channelId);
  return NextResponse.json(topics);
}
