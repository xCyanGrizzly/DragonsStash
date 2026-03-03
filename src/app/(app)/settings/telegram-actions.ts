"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";
import { randomBytes } from "crypto";

/**
 * Generate a one-time link code for the current user.
 * The user sends `/link <code>` to the bot to complete the link.
 * Code is stored in GlobalSetting as `link_code:<code>` → userId.
 * Codes expire after 10 minutes (checked by the bot).
 */
export async function generateTelegramLinkCode(): Promise<
  ActionResult<{ code: string; expiresAt: string }>
> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  // Check if user already has a link
  const existing = await prisma.telegramLink.findUnique({
    where: { userId: session.user.id },
  });
  if (existing) {
    return {
      success: false,
      error: "You already have a linked Telegram account. Unlink first to generate a new code.",
    };
  }

  // Generate a short random code
  const code = randomBytes(4).toString("hex"); // 8 hex chars
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Store in GlobalSetting — overwrites any previous code for this user
  // First, clean up any previous codes for this user
  const existingCodes = await prisma.globalSetting.findMany({
    where: { key: { startsWith: "link_code:" } },
  });
  for (const setting of existingCodes) {
    try {
      const parsed = JSON.parse(setting.value);
      if (parsed.userId === session.user.id) {
        await prisma.globalSetting.delete({ where: { key: setting.key } });
      }
    } catch {
      // Skip malformed entries
    }
  }

  // Store the new code
  await prisma.globalSetting.upsert({
    where: { key: `link_code:${code}` },
    update: {
      value: JSON.stringify({
        userId: session.user.id,
        expiresAt: expiresAt.toISOString(),
      }),
    },
    create: {
      key: `link_code:${code}`,
      value: JSON.stringify({
        userId: session.user.id,
        expiresAt: expiresAt.toISOString(),
      }),
    },
  });

  return {
    success: true,
    data: { code, expiresAt: expiresAt.toISOString() },
  };
}

/**
 * Get the current user's Telegram link status.
 */
export async function getTelegramLinkStatus(): Promise<
  ActionResult<{
    linked: boolean;
    telegramName: string | null;
    telegramUserId: string | null;
    linkedAt: string | null;
  }>
> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const link = await prisma.telegramLink.findUnique({
    where: { userId: session.user.id },
  });

  return {
    success: true,
    data: {
      linked: !!link,
      telegramName: link?.telegramName ?? null,
      telegramUserId: link?.telegramUserId?.toString() ?? null,
      linkedAt: link?.createdAt?.toISOString() ?? null,
    },
  };
}

/**
 * Unlink the current user's Telegram account.
 */
export async function unlinkTelegram(): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const link = await prisma.telegramLink.findUnique({
    where: { userId: session.user.id },
  });

  if (!link) {
    return { success: false, error: "No linked Telegram account found" };
  }

  await prisma.telegramLink.delete({ where: { id: link.id } });

  revalidatePath("/settings");
  return { success: true, data: undefined };
}

/**
 * Get recent bot send requests for the current user (or all for admins).
 */
export async function getBotSendHistory(
  limit = 20
): Promise<
  ActionResult<
    Array<{
      id: string;
      packageName: string;
      recipientName: string | null;
      status: string;
      error: string | null;
      createdAt: string;
      completedAt: string | null;
    }>
  >
> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };

  const isAdmin = session.user.role === "ADMIN";

  const requests = await prisma.botSendRequest.findMany({
    where: isAdmin ? {} : { requestedByUserId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      package: { select: { fileName: true } },
      telegramLink: { select: { telegramName: true } },
    },
  });

  return {
    success: true,
    data: requests.map((r: typeof requests[number]) => ({
      id: r.id,
      packageName: r.package.fileName,
      recipientName: r.telegramLink.telegramName,
      status: r.status,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
    })),
  };
}
