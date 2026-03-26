import { db } from "./client.js";

// ── Link management ──

export async function findLinkByTelegramUserId(telegramUserId: bigint) {
  return db.telegramLink.findUnique({
    where: { telegramUserId },
  });
}

export async function findLinkByUserId(userId: string) {
  return db.telegramLink.findUnique({
    where: { userId },
  });
}

/**
 * Validate a link code stored in global_settings as `link_code:<code>`.
 * Returns the userId if the code is valid, null otherwise.
 */
export async function validateLinkCode(code: string): Promise<string | null> {
  const key = `link_code:${code}`;
  const setting = await db.globalSetting.findUnique({ where: { key } });
  if (!setting) return null;

  try {
    const parsed = JSON.parse(setting.value);
    if (parsed.expiresAt && new Date(parsed.expiresAt) < new Date()) return null;
    return parsed.userId ?? null;
  } catch {
    // Legacy format: value is the userId directly
    return setting.value;
  }
}

export async function deleteLinkCode(code: string): Promise<void> {
  const key = `link_code:${code}`;
  await db.globalSetting.delete({ where: { key } }).catch(() => {});
}

export async function createTelegramLink(
  userId: string,
  telegramUserId: bigint,
  telegramName: string | null
) {
  return db.telegramLink.upsert({
    where: { userId },
    create: { userId, telegramUserId, telegramName },
    update: { telegramUserId, telegramName },
  });
}

// ── Package search ──

export async function searchPackages(query: string, limit = 10) {
  const packages = await db.package.findMany({
    where: {
      OR: [
        { fileName: { contains: query, mode: "insensitive" } },
        { creator: { contains: query, mode: "insensitive" } },
      ],
    },
    orderBy: { indexedAt: "desc" },
    take: limit,
    select: {
      id: true,
      fileName: true,
      fileSize: true,
      archiveType: true,
      fileCount: true,
      creator: true,
      indexedAt: true,
      destChannelId: true,
      destMessageId: true,
    },
  });
  return packages;
}

export async function getLatestPackages(limit = 5) {
  return db.package.findMany({
    orderBy: { indexedAt: "desc" },
    take: limit,
    select: {
      id: true,
      fileName: true,
      fileSize: true,
      archiveType: true,
      fileCount: true,
      creator: true,
      indexedAt: true,
      destChannelId: true,
      destMessageId: true,
    },
  });
}

export async function getPackageById(id: string) {
  return db.package.findUnique({
    where: { id },
    include: {
      files: { take: 20, orderBy: { path: "asc" } },
      sourceChannel: { select: { title: true } },
    },
  });
}

// ── Send requests ──

export async function getPendingSendRequest(requestId: string) {
  return db.botSendRequest.findUnique({
    where: { id: requestId },
    include: {
      package: {
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          fileCount: true,
          creator: true,
          tags: true,
          archiveType: true,
          destChannelId: true,
          destMessageId: true,
          destMessageIds: true,
          isMultipart: true,
          partCount: true,
          previewData: true,
          sourceChannel: { select: { title: true, telegramId: true } },
        },
      },
      telegramLink: true,
    },
  });
}

export async function updateSendRequest(
  requestId: string,
  status: "SENDING" | "SENT" | "FAILED",
  error?: string
) {
  return db.botSendRequest.update({
    where: { id: requestId },
    data: {
      status,
      error: error ?? undefined,
      completedAt: status === "SENT" || status === "FAILED" ? new Date() : undefined,
    },
  });
}

// ── Subscriptions ──

export async function getSubscriptions(telegramUserId: bigint) {
  return db.botSubscription.findMany({
    where: { telegramUserId },
    orderBy: { createdAt: "desc" },
  });
}

export async function addSubscription(telegramUserId: bigint, pattern: string) {
  return db.botSubscription.upsert({
    where: {
      telegramUserId_pattern: { telegramUserId, pattern },
    },
    create: { telegramUserId, pattern },
    update: {},
  });
}

export async function removeSubscription(telegramUserId: bigint, pattern: string) {
  return db.botSubscription.deleteMany({
    where: { telegramUserId, pattern },
  });
}

export async function findMatchingSubscriptions(fileName: string, creator: string | null) {
  // Get all subscriptions and filter in-memory (simpler for pattern matching)
  const subs = await db.botSubscription.findMany();
  return subs.filter((sub) => {
    const p = sub.pattern.toLowerCase();
    if (fileName.toLowerCase().includes(p)) return true;
    if (creator && creator.toLowerCase().includes(p)) return true;
    return false;
  });
}

// ── Destination channel ──

export async function getGlobalDestinationChannel() {
  const setting = await db.globalSetting.findUnique({
    where: { key: "destination_channel_id" },
  });
  if (!setting) return null;
  return db.telegramChannel.findFirst({
    where: { id: setting.value, type: "DESTINATION", isActive: true },
  });
}
