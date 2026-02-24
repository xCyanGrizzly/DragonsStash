"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/types/api.types";
import {
  telegramAccountSchema,
  telegramChannelSchema,
  linkChannelSchema,
  submitAuthCodeSchema,
} from "@/schemas/telegram";

const REVALIDATE_PATH = "/telegram";

async function requireAdmin(): Promise<
  { success: true; userId: string } | { success: false; error: string }
> {
  const session = await auth();
  if (!session?.user?.id) return { success: false, error: "Unauthorized" };
  if (session.user.role !== "ADMIN")
    return { success: false, error: "Admin access required" };
  return { success: true, userId: session.user.id };
}

// ── Account actions ──

export async function createAccount(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const parsed = telegramAccountSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    const account = await prisma.telegramAccount.create({
      data: {
        phone: parsed.data.phone.replace(/[\s\-]/g, ""),
        displayName: parsed.data.displayName || null,
      },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: account.id } };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint failed")
    ) {
      return { success: false, error: "Phone number already registered" };
    }
    return { success: false, error: "Failed to create account" };
  }
}

export async function updateAccount(
  id: string,
  input: unknown
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const parsed = telegramAccountSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.telegramAccount.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Account not found" };

  try {
    await prisma.telegramAccount.update({
      where: { id },
      data: {
        phone: parsed.data.phone.replace(/[\s\-]/g, ""),
        displayName: parsed.data.displayName || null,
      },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint failed")
    ) {
      return { success: false, error: "Phone number already registered" };
    }
    return { success: false, error: "Failed to update account" };
  }
}

export async function toggleAccountActive(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const existing = await prisma.telegramAccount.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Account not found" };

  try {
    await prisma.telegramAccount.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to toggle account" };
  }
}

export async function deleteAccount(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const existing = await prisma.telegramAccount.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Account not found" };

  try {
    await prisma.telegramAccount.delete({ where: { id } });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete account" };
  }
}

export async function submitAuthCode(
  accountId: string,
  input: unknown
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const parsed = submitAuthCodeSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.telegramAccount.findUnique({
    where: { id: accountId },
  });
  if (!existing) return { success: false, error: "Account not found" };
  if (
    existing.authState !== "AWAITING_CODE" &&
    existing.authState !== "AWAITING_PASSWORD"
  ) {
    return { success: false, error: "Account is not waiting for a code" };
  }

  try {
    await prisma.telegramAccount.update({
      where: { id: accountId },
      data: { authCode: parsed.data.code },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to submit code" };
  }
}

// ── Channel actions ──

export async function createChannel(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const parsed = telegramChannelSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    const channel = await prisma.telegramChannel.create({
      data: {
        telegramId: BigInt(parsed.data.telegramId),
        title: parsed.data.title,
        type: parsed.data.type,
      },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: channel.id } };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint failed")
    ) {
      return { success: false, error: "Channel with this Telegram ID already exists" };
    }
    return { success: false, error: "Failed to create channel" };
  }
}

export async function updateChannel(
  id: string,
  input: unknown
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const parsed = telegramChannelSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  const existing = await prisma.telegramChannel.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Channel not found" };

  try {
    await prisma.telegramChannel.update({
      where: { id },
      data: {
        telegramId: BigInt(parsed.data.telegramId),
        title: parsed.data.title,
        type: parsed.data.type,
      },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint failed")
    ) {
      return { success: false, error: "Channel with this Telegram ID already exists" };
    }
    return { success: false, error: "Failed to update channel" };
  }
}

export async function toggleChannelActive(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const existing = await prisma.telegramChannel.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Channel not found" };

  try {
    await prisma.telegramChannel.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to toggle channel" };
  }
}

export async function deleteChannel(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const existing = await prisma.telegramChannel.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Channel not found" };

  try {
    await prisma.telegramChannel.delete({ where: { id } });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to delete channel" };
  }
}

// ── Account-Channel link actions ──

export async function linkChannel(
  input: unknown
): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const parsed = linkChannelSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Validation failed" };

  try {
    const link = await prisma.accountChannelMap.create({
      data: {
        accountId: parsed.data.accountId,
        channelId: parsed.data.channelId,
        role: parsed.data.role,
      },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: link.id } };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint failed")
    ) {
      return { success: false, error: "This channel is already linked to this account" };
    }
    return { success: false, error: "Failed to link channel" };
  }
}

export async function unlinkChannel(id: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const existing = await prisma.accountChannelMap.findUnique({
    where: { id },
  });
  if (!existing) return { success: false, error: "Link not found" };

  try {
    await prisma.accountChannelMap.delete({ where: { id } });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to unlink channel" };
  }
}

// ── Ingestion trigger ──

export async function triggerIngestion(
  accountId?: string
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/ingestion/trigger`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": process.env.INGESTION_API_KEY || "",
        },
        body: JSON.stringify({ accountId }),
      }
    );

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        success: false,
        error: (data as { error?: string }).error || "Failed to trigger ingestion",
      };
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to trigger ingestion" };
  }
}
