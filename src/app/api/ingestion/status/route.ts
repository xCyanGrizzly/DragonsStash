import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { getIngestionStatus } from "@/lib/telegram/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const accounts = await getIngestionStatus();
  return NextResponse.json({ accounts });
}
