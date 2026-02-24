import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { triggerIngestionSchema } from "@/schemas/telegram";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authResult = await authenticateApiRequest(request, true);
  if ("error" in authResult) return authResult.error;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is fine — triggers all accounts
  }

  const parsed = triggerIngestionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Find accounts to trigger
  const where: { isActive: boolean; authState: "AUTHENTICATED"; id?: string } = {
    isActive: true,
    authState: "AUTHENTICATED",
  };
  if (parsed.data.accountId) {
    where.id = parsed.data.accountId;
  }

  const accounts = await prisma.telegramAccount.findMany({
    where,
    select: { id: true },
  });

  if (accounts.length === 0) {
    return NextResponse.json(
      { triggered: false, message: "No eligible accounts found" },
      { status: 404 }
    );
  }

  // Create ingestion runs marked as RUNNING — the worker will pick these up
  // when it next polls, or we use pg_notify for immediate pickup
  for (const account of accounts) {
    // Only create if no run is already RUNNING for this account
    const existing = await prisma.ingestionRun.findFirst({
      where: { accountId: account.id, status: "RUNNING" },
    });
    if (!existing) {
      await prisma.ingestionRun.create({
        data: { accountId: account.id, status: "RUNNING" },
      });
    }
  }

  // Send pg_notify for immediate worker pickup
  try {
    await prisma.$queryRawUnsafe(
      `SELECT pg_notify('ingestion_trigger', $1)`,
      accounts.map((a) => a.id).join(",")
    );
  } catch {
    // pg_notify is best-effort — worker will pick up on next cycle anyway
  }

  return NextResponse.json({
    triggered: true,
    accountIds: accounts.map((a) => a.id),
    message: `Ingestion queued for ${accounts.length} account(s)`,
  });
}
