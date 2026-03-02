import { prisma } from "@/lib/prisma";

// ── Account queries ──

export async function listAccounts() {
  const accounts = await prisma.telegramAccount.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { channelMaps: true, ingestionRuns: true } },
    },
  });

  return accounts.map((a) => ({
    id: a.id,
    phone: a.phone,
    displayName: a.displayName,
    isActive: a.isActive,
    authState: a.authState,
    authCode: a.authCode,
    lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    channelCount: a._count.channelMaps,
    runCount: a._count.ingestionRuns,
  }));
}

export type AccountRow = Awaited<ReturnType<typeof listAccounts>>[number];

// ── Channel queries ──

export async function listChannels() {
  const channels = await prisma.telegramChannel.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { accountMaps: true, packages: true } },
    },
  });

  return channels.map((c) => ({
    id: c.id,
    telegramId: c.telegramId.toString(),
    title: c.title,
    type: c.type,
    isActive: c.isActive,
    createdAt: c.createdAt.toISOString(),
    accountCount: c._count.accountMaps,
    packageCount: c._count.packages,
  }));
}

export type ChannelRow = Awaited<ReturnType<typeof listChannels>>[number];

// ── Account-Channel link queries ──

export async function listAccountChannelLinks(accountId: string) {
  const links = await prisma.accountChannelMap.findMany({
    where: { accountId },
    include: {
      channel: { select: { id: true, title: true, type: true, telegramId: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return links.map((l) => ({
    id: l.id,
    accountId: l.accountId,
    channelId: l.channelId,
    role: l.role,
    lastProcessedMessageId: l.lastProcessedMessageId?.toString() ?? null,
    channel: {
      id: l.channel.id,
      title: l.channel.title,
      type: l.channel.type,
      telegramId: l.channel.telegramId.toString(),
    },
  }));
}

export type AccountChannelLinkRow = Awaited<
  ReturnType<typeof listAccountChannelLinks>
>[number];

// ── Global destination ──

export async function getGlobalDestination() {
  try {
    const setting = await prisma.globalSetting.findUnique({
      where: { key: "destination_channel_id" },
    });
    if (!setting) return null;

    const channel = await prisma.telegramChannel.findUnique({
      where: { id: setting.value },
      select: { id: true, title: true, telegramId: true, isActive: true },
    });

    if (!channel) return null;

    // Also get the invite link if it exists
    const inviteSetting = await prisma.globalSetting.findUnique({
      where: { key: "destination_invite_link" },
    });

    return {
      id: channel.id,
      title: channel.title,
      telegramId: channel.telegramId.toString(),
      isActive: channel.isActive,
      inviteLink: inviteSetting?.value ?? null,
    };
  } catch (error) {
    console.error("Failed to fetch global destination (restart dev server if schema changed):", error);
    return null;
  }
}

export type GlobalDestination = Awaited<ReturnType<typeof getGlobalDestination>>;

export async function getUnlinkedChannels(accountId: string) {
  const linked = await prisma.accountChannelMap.findMany({
    where: { accountId },
    select: { channelId: true },
  });
  const linkedIds = linked.map((l) => l.channelId);

  const unlinked = await prisma.telegramChannel.findMany({
    where: {
      id: { notIn: linkedIds },
      isActive: true,
    },
    orderBy: { title: "asc" },
    select: { id: true, title: true, type: true, telegramId: true },
  });

  return unlinked.map((c) => ({
    id: c.id,
    title: c.title,
    type: c.type,
    telegramId: c.telegramId.toString(),
  }));
}
