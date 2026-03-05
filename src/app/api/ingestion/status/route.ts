import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { getIngestionStatus } from "@/lib/telegram/queries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if ("error" in authResult) return authResult.error;

  const accounts = await getIngestionStatus();
  const workerIntervalMinutes = parseInt(
    process.env.WORKER_INTERVAL_MINUTES ?? "60",
    10
  );
  return NextResponse.json({ accounts, workerIntervalMinutes });
}
