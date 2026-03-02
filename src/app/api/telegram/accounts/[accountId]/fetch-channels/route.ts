import { NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/telegram/api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST: Create a channel fetch request for this account.
 * Signals the worker via pg_notify to fetch channels from Telegram.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const authResult = await authenticateApiRequest(request, true);
  if ("error" in authResult) return authResult.error;

  const { accountId } = await params;

  try {
    // Verify account exists and is authenticated
    const account = await prisma.telegramAccount.findUnique({
      where: { id: accountId },
      select: { id: true, authState: true },
    });

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    if (account.authState !== "AUTHENTICATED") {
      return NextResponse.json(
        { error: "Account must be authenticated to fetch channels" },
        { status: 400 }
      );
    }

    // Check for an existing recent request that's still pending/in-progress
    const existing = await prisma.channelFetchRequest.findFirst({
      where: {
        accountId,
        status: { in: ["PENDING", "IN_PROGRESS"] },
      },
    });

    if (existing) {
      return NextResponse.json({ requestId: existing.id }, { status: 202 });
    }

    // Also check for a recently completed request (within last 30 seconds)
    const recent = await prisma.channelFetchRequest.findFirst({
      where: {
        accountId,
        status: "COMPLETED",
        updatedAt: { gte: new Date(Date.now() - 30_000) },
      },
      orderBy: { createdAt: "desc" },
    });

    if (recent) {
      return NextResponse.json({ requestId: recent.id }, { status: 200 });
    }

    // Create a new fetch request
    const fetchRequest = await prisma.channelFetchRequest.create({
      data: { accountId, status: "PENDING" },
    });

    // Signal the worker via pg_notify
    try {
      await prisma.$queryRawUnsafe(
        `SELECT pg_notify('channel_fetch', $1)`,
        fetchRequest.id
      );
    } catch {
      // Best-effort — worker will also pick it up on next poll
    }

    return NextResponse.json({ requestId: fetchRequest.id }, { status: 202 });
  } catch (err) {
    console.error("fetch-channels POST error:", err);
    return NextResponse.json(
      { error: "Server error — try restarting the dev server if the schema changed" },
      { status: 500 }
    );
  }
}

/**
 * GET: Poll for the result of a channel fetch request.
 * Query param: ?requestId=xxx
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const authResult = await authenticateApiRequest(request, true);
  if ("error" in authResult) return authResult.error;

  const { accountId } = await params;
  const url = new URL(request.url);
  const requestId = url.searchParams.get("requestId");

  try {
    if (!requestId) {
      // Return the most recent completed fetch request for this account
      const latest = await prisma.channelFetchRequest.findFirst({
        where: { accountId, status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
      });

      if (!latest) {
        return NextResponse.json(
          { status: "NOT_FOUND", channels: [] },
          { status: 200 }
        );
      }

      return NextResponse.json({
        requestId: latest.id,
        status: latest.status,
        channels: latest.resultJson ? JSON.parse(latest.resultJson) : [],
      });
    }

    const fetchRequest = await prisma.channelFetchRequest.findUnique({
      where: { id: requestId },
    });

    if (!fetchRequest || fetchRequest.accountId !== accountId) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }

    return NextResponse.json({
      requestId: fetchRequest.id,
      status: fetchRequest.status,
      error: fetchRequest.error,
      channels: fetchRequest.status === "COMPLETED" && fetchRequest.resultJson
        ? JSON.parse(fetchRequest.resultJson)
        : [],
    });
  } catch (err) {
    console.error("fetch-channels GET error:", err);
    return NextResponse.json(
      { error: "Server error — try restarting the dev server if the schema changed" },
      { status: 500 }
    );
  }
}
