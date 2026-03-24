import { prisma } from "@/lib/prisma";
import type {
  PackageListItem,
  PackageDetail,
  PackageFileItem,
  IngestionAccountStatus,
} from "./types";

export async function listPackages(options: {
  page: number;
  limit: number;
  channelId?: string;
  creator?: string;
  tag?: string;
  sortBy: "indexedAt" | "fileName" | "fileSize";
  order: "asc" | "desc";
}) {
  const where: Record<string, unknown> = {};
  if (options.channelId) where.sourceChannelId = options.channelId;
  if (options.creator) where.creator = options.creator;
  if (options.tag) where.tags = { has: options.tag };

  const [items, total] = await Promise.all([
    prisma.package.findMany({
      where,
      orderBy: { [options.sortBy]: options.order },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
      select: {
        id: true,
        fileName: true,
        fileSize: true,
        contentHash: true,
        archiveType: true,
        fileCount: true,
        isMultipart: true,
        indexedAt: true,
        creator: true,
        tags: true,
        previewData: true, // check actual image data, not previewMsgId proxy
        sourceChannel: { select: { id: true, title: true } },
      },
    }),
    prisma.package.count({ where }),
  ]);

  const mapped: PackageListItem[] = items.map((pkg) => ({
    id: pkg.id,
    fileName: pkg.fileName,
    fileSize: pkg.fileSize.toString(),
    contentHash: pkg.contentHash,
    archiveType: pkg.archiveType,
    fileCount: pkg.fileCount,
    isMultipart: pkg.isMultipart,
    hasPreview: pkg.previewData !== null,
    creator: pkg.creator,
    tags: pkg.tags,
    indexedAt: pkg.indexedAt.toISOString(),
    sourceChannel: pkg.sourceChannel,
    matchedFileCount: 0,
    matchedByContent: false,
  }));

  return {
    items: mapped,
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.ceil(total / options.limit),
    },
  };
}

export async function getPackageById(
  id: string
): Promise<PackageDetail | null> {
  const pkg = await prisma.package.findUnique({
    where: { id },
    include: {
      sourceChannel: { select: { id: true, title: true } },
      ingestionRun: { select: { id: true, startedAt: true } },
    },
  });

  if (!pkg) return null;

  let destChannel: { id: string; title: string } | null = null;
  if (pkg.destChannelId) {
    const ch = await prisma.telegramChannel.findUnique({
      where: { id: pkg.destChannelId },
      select: { id: true, title: true },
    });
    destChannel = ch;
  }

  return {
    id: pkg.id,
    fileName: pkg.fileName,
    fileSize: pkg.fileSize.toString(),
    contentHash: pkg.contentHash,
    archiveType: pkg.archiveType,
    fileCount: pkg.fileCount,
    isMultipart: pkg.isMultipart,
    hasPreview: pkg.previewData !== null,
    creator: pkg.creator,
    tags: pkg.tags,
    partCount: pkg.partCount,
    indexedAt: pkg.indexedAt.toISOString(),
    sourceChannel: pkg.sourceChannel,
    destChannel,
    destMessageId: pkg.destMessageId?.toString() ?? null,
    sourceMessageId: pkg.sourceMessageId.toString(),
    ingestionRun: pkg.ingestionRun
      ? {
          id: pkg.ingestionRun.id,
          startedAt: pkg.ingestionRun.startedAt.toISOString(),
        }
      : null,
  };
}

export async function listPackageFiles(options: {
  packageId: string;
  page: number;
  limit: number;
  extension?: string;
}) {
  const where: { packageId: string; extension?: string } = {
    packageId: options.packageId,
  };
  if (options.extension) {
    where.extension = options.extension;
  }

  const [items, total] = await Promise.all([
    prisma.packageFile.findMany({
      where,
      orderBy: { path: "asc" },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
    }),
    prisma.packageFile.count({ where }),
  ]);

  const mapped: PackageFileItem[] = items.map((f) => ({
    id: f.id,
    path: f.path,
    fileName: f.fileName,
    extension: f.extension,
    compressedSize: f.compressedSize.toString(),
    uncompressedSize: f.uncompressedSize.toString(),
    crc32: f.crc32,
  }));

  return {
    items: mapped,
    pagination: {
      page: options.page,
      limit: options.limit,
      total,
      totalPages: Math.ceil(total / options.limit),
    },
  };
}

export async function searchPackages(options: {
  query: string;
  page: number;
  limit: number;
  searchIn: "packages" | "files" | "both";
}) {
  const q = options.query;

  if (options.searchIn === "files" || options.searchIn === "both") {
    // Get per-package file match counts
    const fileMatches = await prisma.packageFile.groupBy({
      by: ["packageId"],
      where: {
        OR: [
          { fileName: { contains: q, mode: "insensitive" } },
          { path: { contains: q, mode: "insensitive" } },
        ],
      },
      _count: { _all: true },
    });

    const fileMatchMap = new Map(
      fileMatches.map((m) => [m.packageId, m._count._all])
    );
    const fileMatchedIds = fileMatches.map((f) => f.packageId);

    const packageNameIds =
      options.searchIn === "both"
        ? (
            await prisma.package.findMany({
              where: { fileName: { contains: q, mode: "insensitive" } },
              select: { id: true },
            })
          ).map((p) => p.id)
        : [];

    const allIds = [...new Set([...fileMatchedIds, ...packageNameIds])];

    const [items, total] = await Promise.all([
      prisma.package.findMany({
        where: { id: { in: allIds } },
        orderBy: { indexedAt: "desc" },
        skip: (options.page - 1) * options.limit,
        take: options.limit,
        select: {
          id: true,
          fileName: true,
          fileSize: true,
          contentHash: true,
          archiveType: true,
          fileCount: true,
          isMultipart: true,
          indexedAt: true,
          creator: true,
          tags: true,
          previewData: true,
          sourceChannel: { select: { id: true, title: true } },
        },
      }),
      Promise.resolve(allIds.length),
    ]);

    const mapped: PackageListItem[] = items.map((pkg) => ({
      id: pkg.id,
      fileName: pkg.fileName,
      fileSize: pkg.fileSize.toString(),
      contentHash: pkg.contentHash,
      archiveType: pkg.archiveType,
      fileCount: pkg.fileCount,
      isMultipart: pkg.isMultipart,
      hasPreview: pkg.previewData !== null,
      creator: pkg.creator,
      tags: pkg.tags,
      indexedAt: pkg.indexedAt.toISOString(),
      sourceChannel: pkg.sourceChannel,
      matchedFileCount: fileMatchMap.get(pkg.id) ?? 0,
      matchedByContent: fileMatchMap.has(pkg.id),
    }));

    return {
      items: mapped,
      pagination: {
        page: options.page,
        limit: options.limit,
        total,
        totalPages: Math.ceil(total / options.limit),
      },
    };
  }

  // Search packages only
  return listPackages({
    page: options.page,
    limit: options.limit,
    sortBy: "indexedAt",
    order: "desc",
  });
}

/**
 * Get all distinct tags across all packages (for filter dropdowns).
 */
export async function getAllPackageTags(): Promise<string[]> {
  const result = await prisma.$queryRaw<{ tag: string }[]>`
    SELECT DISTINCT unnest(tags) AS tag FROM packages ORDER BY tag
  `;
  return result.map((r) => r.tag);
}

export async function getIngestionStatus(): Promise<IngestionAccountStatus[]> {
  const accounts = await prisma.telegramAccount.findMany({
    orderBy: { createdAt: "asc" },
  });

  const statuses: IngestionAccountStatus[] = [];

  for (const account of accounts) {
    const lastRun = await prisma.ingestionRun.findFirst({
      where: { accountId: account.id, status: { not: "RUNNING" } },
      orderBy: { startedAt: "desc" },
    });

    const currentRun = await prisma.ingestionRun.findFirst({
      where: { accountId: account.id, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });

    statuses.push({
      id: account.id,
      displayName: account.displayName,
      phone: account.phone,
      isActive: account.isActive,
      authState: account.authState,
      lastSeenAt: account.lastSeenAt?.toISOString() ?? null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            startedAt: lastRun.startedAt.toISOString(),
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
            messagesScanned: lastRun.messagesScanned,
            zipsFound: lastRun.zipsFound,
            zipsDuplicate: lastRun.zipsDuplicate,
            zipsIngested: lastRun.zipsIngested,
          }
        : null,
      currentRun: currentRun
        ? {
            id: currentRun.id,
            startedAt: currentRun.startedAt.toISOString(),
            messagesScanned: currentRun.messagesScanned,
            zipsFound: currentRun.zipsFound,
            zipsDuplicate: currentRun.zipsDuplicate,
            zipsIngested: currentRun.zipsIngested,
            // Live activity tracking
            currentActivity: currentRun.currentActivity,
            currentStep: currentRun.currentStep,
            currentChannel: currentRun.currentChannel,
            currentFile: currentRun.currentFile,
            currentFileNum: currentRun.currentFileNum,
            totalFiles: currentRun.totalFiles,
            downloadedBytes: currentRun.downloadedBytes?.toString() ?? null,
            totalBytes: currentRun.totalBytes?.toString() ?? null,
            downloadPercent: currentRun.downloadPercent,
            lastActivityAt: currentRun.lastActivityAt?.toISOString() ?? null,
          }
        : null,
    });
  }

  return statuses;
}
