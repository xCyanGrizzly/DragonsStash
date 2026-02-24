import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { getUnlinkedChannels } from "@/lib/telegram/admin-queries";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const authResult = await authenticateApiRequest(request, true);
  if ("error" in authResult) return authResult.error;

  const { accountId } = await params;
  const channels = await getUnlinkedChannels(accountId);
  return NextResponse.json(channels);
}
