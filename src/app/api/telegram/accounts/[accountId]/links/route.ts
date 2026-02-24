import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { listAccountChannelLinks } from "@/lib/telegram/admin-queries";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const authResult = await authenticateApiRequest(request, true);
  if ("error" in authResult) return authResult.error;

  const { accountId } = await params;
  const links = await listAccountChannelLinks(accountId);
  return NextResponse.json(links);
}
