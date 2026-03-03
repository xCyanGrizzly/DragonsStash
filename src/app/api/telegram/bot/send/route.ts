import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/telegram/bot/send
 * Queue a package to be sent to a user's linked Telegram account via the bot.
 *
 * Body: { packageId: string, targetUserId?: string }
 * - targetUserId: optional, admin-only — send to another user's linked TG
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { packageId?: string; targetUserId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.packageId) {
    return NextResponse.json({ error: "packageId is required" }, { status: 400 });
  }

  // Determine whose TelegramLink to use
  const targetUserId = body.targetUserId ?? session.user.id;

  // Only admins can send to other users
  if (body.targetUserId && body.targetUserId !== session.user.id) {
    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "Only admins can send to other users" },
        { status: 403 }
      );
    }
  }

  // Verify the target user has a linked Telegram account
  const telegramLink = await prisma.telegramLink.findUnique({
    where: { userId: targetUserId },
  });

  if (!telegramLink) {
    return NextResponse.json(
      { error: "Target user has no linked Telegram account. Link one in Settings → Telegram." },
      { status: 400 }
    );
  }

  // Verify the package exists and has a destination message
  const pkg = await prisma.package.findUnique({
    where: { id: body.packageId },
    select: { id: true, fileName: true, destChannelId: true, destMessageId: true },
  });

  if (!pkg) {
    return NextResponse.json({ error: "Package not found" }, { status: 404 });
  }

  if (!pkg.destChannelId || !pkg.destMessageId) {
    return NextResponse.json(
      { error: "Package has not been uploaded to a destination channel yet" },
      { status: 400 }
    );
  }

  // Create the send request
  const sendRequest = await prisma.botSendRequest.create({
    data: {
      packageId: body.packageId,
      telegramLinkId: telegramLink.id,
      requestedByUserId: session.user.id,
      status: "PENDING",
    },
  });

  // Notify the bot via pg_notify
  try {
    await prisma.$queryRawUnsafe(
      `SELECT pg_notify('bot_send', $1)`,
      sendRequest.id
    );
  } catch {
    // Best-effort — the bot also polls periodically
  }

  return NextResponse.json({
    requestId: sendRequest.id,
    status: "PENDING",
    message: `Queued "${pkg.fileName}" for delivery to Telegram`,
  });
}
