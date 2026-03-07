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
        isActive: false,
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

export async function setChannelType(
  id: string,
  type: "SOURCE" | "DESTINATION"
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const existing = await prisma.telegramChannel.findUnique({ where: { id } });
  if (!existing) return { success: false, error: "Channel not found" };

  try {
    if (type === "DESTINATION") {
      // Setting as destination: use the full global destination logic
      // so it updates the global settings key, creates WRITER links, etc.
      return await setGlobalDestination(id);
    }

    // Setting as SOURCE — just change the type
    await prisma.telegramChannel.update({
      where: { id },
      data: { type },
    });
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to update channel type" };
  }
}

export async function triggerChannelSync(): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  try {
    // Signal the worker to do a channel sync via pg_notify
    await prisma.$queryRawUnsafe(
      `SELECT pg_notify('channel_sync', 'requested')`
    );
    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to trigger channel sync" };
  }
}

/**
 * Reset all scan progress for a channel so the worker will re-process it
 * from the very beginning on the next ingestion cycle.
 *
 * This clears:
 *   - `lastProcessedMessageId` on every AccountChannelMap linked to this channel
 *   - All TopicProgress records for those maps (for forum channels)
 */
export async function rescanChannel(channelId: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const channel = await prisma.telegramChannel.findUnique({
    where: { id: channelId },
  });
  if (!channel) return { success: false, error: "Channel not found" };

  try {
    // Find all account-channel maps for this channel
    const maps = await prisma.accountChannelMap.findMany({
      where: { channelId },
      select: { id: true },
    });

    const mapIds = maps.map((m) => m.id);

    // Delete all topic progress records for these maps (forum channels)
    if (mapIds.length > 0) {
      await prisma.topicProgress.deleteMany({
        where: { accountChannelMapId: { in: mapIds } },
      });
    }

    // Reset the scan cursor so the worker re-processes from the start
    await prisma.accountChannelMap.updateMany({
      where: { channelId },
      data: { lastProcessedMessageId: null },
    });

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to reset channel scan progress" };
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
    // Find eligible accounts
    const where: { isActive: boolean; authState: "AUTHENTICATED"; id?: string } = {
      isActive: true,
      authState: "AUTHENTICATED",
    };
    if (accountId) where.id = accountId;

    const accounts = await prisma.telegramAccount.findMany({
      where,
      select: { id: true },
    });

    if (accounts.length === 0) {
      return { success: false, error: "No eligible accounts found" };
    }

    // Signal the worker to run an immediate ingestion cycle via pg_notify.
    // The worker will create its own IngestionRun records with proper activity tracking.
    try {
      await prisma.$queryRawUnsafe(
        `SELECT pg_notify('ingestion_trigger', $1)`,
        accounts.map((a: { id: string }) => a.id).join(",")
      );
    } catch {
      // Best-effort
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to trigger ingestion" };
  }
}

// ── Channel selection (from fetch results) ──

export async function saveChannelSelections(
  accountId: string,
  channels: { telegramId: string; title: string; isForum: boolean }[]
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const existing = await prisma.telegramAccount.findUnique({
    where: { id: accountId },
  });
  if (!existing) return { success: false, error: "Account not found" };

  try {
    let linked = 0;
    for (const ch of channels) {
      // Upsert the channel record and activate it (user explicitly selected it)
      const channel = await prisma.telegramChannel.upsert({
        where: { telegramId: BigInt(ch.telegramId) },
        create: {
          telegramId: BigInt(ch.telegramId),
          title: ch.title,
          type: "SOURCE",
          isForum: ch.isForum,
          isActive: true,
        },
        update: {
          title: ch.title,
          isForum: ch.isForum,
          isActive: true,
        },
      });

      // Create READER link (idempotent)
      try {
        await prisma.accountChannelMap.create({
          data: { accountId, channelId: channel.id, role: "READER" },
        });
        linked++;
      } catch (err: unknown) {
        // Unique constraint = already linked, that's fine
        if (!(err instanceof Error && err.message.includes("Unique constraint"))) {
          throw err;
        }
      }
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to save channel selections" };
  }
}

// ── Global destination channel ──

export async function setGlobalDestination(
  channelId: string
): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  const channel = await prisma.telegramChannel.findUnique({
    where: { id: channelId },
  });
  if (!channel) return { success: false, error: "Channel not found" };

  try {
    // Set the channel type to DESTINATION and ensure it's active
    await prisma.telegramChannel.update({
      where: { id: channelId },
      data: { type: "DESTINATION", isActive: true },
    });

    // Save as global destination
    await prisma.globalSetting.upsert({
      where: { key: "destination_channel_id" },
      create: { key: "destination_channel_id", value: channelId },
      update: { value: channelId },
    });

    // Auto-create WRITER links for all active authenticated accounts
    const accounts = await prisma.telegramAccount.findMany({
      where: { isActive: true, authState: "AUTHENTICATED" },
      select: { id: true },
    });

    for (const account of accounts) {
      try {
        await prisma.accountChannelMap.create({
          data: { accountId: account.id, channelId, role: "WRITER" },
        });
      } catch {
        // Already linked — ignore
      }
    }

    // Signal worker to generate invite link
    try {
      await prisma.$queryRawUnsafe(
        `SELECT pg_notify('generate_invite', $1)`,
        channelId
      );
    } catch {
      // Best-effort
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: undefined };
  } catch {
    return { success: false, error: "Failed to set global destination" };
  }
}

export async function createDestinationChannel(
  telegramId: string,
  title: string
): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  try {
    // Create the channel as DESTINATION (active by default — needed for uploads)
    const channel = await prisma.telegramChannel.upsert({
      where: { telegramId: BigInt(telegramId) },
      create: {
        telegramId: BigInt(telegramId),
        title,
        type: "DESTINATION",
        isActive: true,
      },
      update: {
        title,
        type: "DESTINATION",
        isActive: true,
      },
    });

    // Set as global destination
    await prisma.globalSetting.upsert({
      where: { key: "destination_channel_id" },
      create: { key: "destination_channel_id", value: channel.id },
      update: { value: channel.id },
    });

    // Auto-create WRITER links for all active authenticated accounts
    const accounts = await prisma.telegramAccount.findMany({
      where: { isActive: true, authState: "AUTHENTICATED" },
      select: { id: true },
    });

    for (const account of accounts) {
      try {
        await prisma.accountChannelMap.create({
          data: { accountId: account.id, channelId: channel.id, role: "WRITER" },
        });
      } catch {
        // Already linked
      }
    }

    // Signal worker to generate invite link
    try {
      await prisma.$queryRawUnsafe(
        `SELECT pg_notify('generate_invite', $1)`,
        channel.id
      );
    } catch {
      // Best-effort
    }

    revalidatePath(REVALIDATE_PATH);
    return { success: true, data: { id: channel.id } };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint failed")
    ) {
      return { success: false, error: "A channel with this Telegram ID already exists" };
    }
    return { success: false, error: "Failed to create destination channel" };
  }
}

/**
 * Request the worker to create a new Telegram supergroup as the destination.
 * Uses ChannelFetchRequest as a generic DB-mediated request with pg_notify.
 * Returns the requestId so the UI can poll for completion.
 */
export async function createDestinationViaWorker(
  title: string
): Promise<ActionResult<{ requestId: string }>> {
  const admin = await requireAdmin();
  if (!admin.success) return admin;

  if (!title.trim()) return { success: false, error: "Title is required" };

  try {
    // Need at least one authenticated account for TDLib
    const hasAccount = await prisma.telegramAccount.findFirst({
      where: { isActive: true, authState: "AUTHENTICATED" },
      select: { id: true },
    });
    if (!hasAccount) {
      return { success: false, error: "At least one authenticated account is needed to create a Telegram group" };
    }

    // Create a fetch request to track progress (reusing the model as a generic worker request)
    const fetchRequest = await prisma.channelFetchRequest.create({
      data: {
        accountId: hasAccount.id,
        status: "PENDING",
      },
    });

    // Signal worker via pg_notify
    await prisma.$queryRawUnsafe(
      `SELECT pg_notify('create_destination', $1)`,
      JSON.stringify({ requestId: fetchRequest.id, title: title.trim() })
    );

    return { success: true, data: { requestId: fetchRequest.id } };
  } catch {
    return { success: false, error: "Failed to request destination creation" };
  }
}
