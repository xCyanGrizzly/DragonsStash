import { prisma } from "@/lib/prisma";
import type {
  PackageListItem,
  PackageDetail,
  PackageFileItem,
  IngestionAccountStatus,
  SkippedPackageItem,
  DisplayItem,
  PackageGroupRow,
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

export async function listDisplayItems(options: {
  page: number;
  limit: number;
  channelId?: string;
  creator?: string;
  tag?: string;
  sortBy: "indexedAt" | "fileName" | "fileSize";
  order: "asc" | "desc";
}): Promise<{ items: DisplayItem[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const { page, limit, channelId, creator, tag, sortBy, order } = options;

  // Build WHERE clause fragments for raw SQL
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (channelId) {
    conditions.push(`p."sourceChannelId" = $${paramIdx++}`);
    params.push(channelId);
  }
  if (creator) {
    conditions.push(`p."creator" = $${paramIdx++}`);
    params.push(creator);
  }
  if (tag) {
    conditions.push(`$${paramIdx++} = ANY(p."tags")`);
    params.push(tag);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sortCol = sortBy === "fileName" ? `"fileName"` : sortBy === "fileSize" ? `"fileSize"` : `"indexedAt"`;
  const sortDir = order === "asc" ? "ASC" : "DESC";

  // Step 1: Count display items
  const countResult = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
    `SELECT COUNT(*) AS count FROM (
      SELECT DISTINCT COALESCE(p."packageGroupId", p."id") AS display_id
      FROM packages p
      ${whereClause}
    ) AS display_items`,
    ...params
  );
  const total = Number(countResult[0].count);

  // Step 2: Get display item IDs for this page
  const limitParam = paramIdx++;
  const offsetParam = paramIdx++;
  const displayRows = await prisma.$queryRawUnsafe<
    { display_id: string; display_type: string }[]
  >(
    `SELECT
      COALESCE(p."packageGroupId", p."id") AS display_id,
      CASE WHEN p."packageGroupId" IS NOT NULL THEN 'group' ELSE 'package' END AS display_type,
      MAX(p.${sortCol}) AS sort_value
    FROM packages p
    ${whereClause}
    GROUP BY COALESCE(p."packageGroupId", p."id"),
             CASE WHEN p."packageGroupId" IS NOT NULL THEN 'group' ELSE 'package' END
    ORDER BY sort_value ${sortDir}
    LIMIT $${limitParam} OFFSET $${offsetParam}`,
    ...params, limit, (page - 1) * limit
  );

  // Step 3: Fetch full data
  const groupIds = displayRows.filter((r) => r.display_type === "group").map((r) => r.display_id);
  const packageIds = displayRows.filter((r) => r.display_type === "package").map((r) => r.display_id);

  const standalonePackages = packageIds.length > 0
    ? await prisma.package.findMany({
        where: { id: { in: packageIds } },
        select: {
          id: true, fileName: true, fileSize: true, contentHash: true,
          archiveType: true, fileCount: true, isMultipart: true,
          indexedAt: true, creator: true, tags: true, previewData: true,
          sourceChannel: { select: { id: true, title: true } },
        },
      })
    : [];

  const groups = groupIds.length > 0
    ? await prisma.packageGroup.findMany({
        where: { id: { in: groupIds } },
        select: {
          id: true, name: true, previewData: true,
          sourceChannel: { select: { id: true, title: true } },
          packages: {
            select: {
              id: true, fileName: true, fileSize: true, contentHash: true,
              archiveType: true, fileCount: true, isMultipart: true,
              indexedAt: true, creator: true, tags: true, previewData: true,
              sourceChannel: { select: { id: true, title: true } },
            },
            orderBy: { indexedAt: "desc" },
          },
        },
      })
    : [];

  // Build DisplayItem array in the original sort order
  const packageMap = new Map(standalonePackages.map((p) => [p.id, p]));
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  const items: DisplayItem[] = displayRows.map((row) => {
    if (row.display_type === "package") {
      const pkg = packageMap.get(row.display_id)!;
      return {
        type: "package" as const,
        data: {
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
        },
      };
    } else {
      const grp = groupMap.get(row.display_id)!;
      const allTags = [...new Set(grp.packages.flatMap((p) => p.tags))];
      const archiveTypes = [...new Set(grp.packages.map((p) => p.archiveType))] as PackageGroupRow["archiveTypes"];
      return {
        type: "group" as const,
        data: {
          id: grp.id,
          name: grp.name,
          hasPreview: grp.previewData !== null,
          totalFileSize: grp.packages.reduce((sum, p) => sum + p.fileSize, BigInt(0)).toString(),
          totalFileCount: grp.packages.reduce((sum, p) => sum + p.fileCount, 0),
          packageCount: grp.packages.length,
          combinedTags: allTags,
          archiveTypes,
          latestIndexedAt: grp.packages.length > 0
            ? grp.packages[0].indexedAt.toISOString()
            : new Date().toISOString(),
          sourceChannel: grp.sourceChannel,
          packages: grp.packages.map((pkg) => ({
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
          })),
        },
      };
    }
  });

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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
    matchedFileCount: 0,
    matchedByContent: false,
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

    // Also match by group name
    const groupNameMatches = await prisma.package.findMany({
      where: {
        packageGroup: { name: { contains: q, mode: "insensitive" } },
      },
      select: { id: true },
    });
    const groupMatchedIds = groupNameMatches.map((p) => p.id);

    const allIds = [...new Set([...fileMatchedIds, ...packageNameIds, ...groupMatchedIds])];

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

export async function listSkippedPackages(options: {
  page: number;
  limit: number;
  reason?: "SIZE_LIMIT" | "DOWNLOAD_FAILED" | "EXTRACT_FAILED" | "UPLOAD_FAILED";
}) {
  const where: Record<string, unknown> = {};
  if (options.reason) where.reason = options.reason;

  const [items, total] = await Promise.all([
    prisma.skippedPackage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (options.page - 1) * options.limit,
      take: options.limit,
      include: {
        sourceChannel: { select: { id: true, title: true } },
      },
    }),
    prisma.skippedPackage.count({ where }),
  ]);

  const mapped: SkippedPackageItem[] = items.map((s) => ({
    id: s.id,
    fileName: s.fileName,
    fileSize: s.fileSize.toString(),
    reason: s.reason,
    errorMessage: s.errorMessage,
    sourceChannel: s.sourceChannel,
    sourceMessageId: s.sourceMessageId.toString(),
    isMultipart: s.isMultipart,
    partCount: s.partCount,
    createdAt: s.createdAt.toISOString(),
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

export async function countSkippedPackages(): Promise<number> {
  return prisma.skippedPackage.count();
}

export async function getPackageGroup(groupId: string) {
  return prisma.packageGroup.findUnique({
    where: { id: groupId },
    select: {
      id: true, name: true, previewData: true, mediaAlbumId: true,
      sourceChannelId: true, createdAt: true,
      sourceChannel: { select: { id: true, title: true } },
      packages: {
        select: {
          id: true, fileName: true, fileSize: true, archiveType: true,
          fileCount: true, creator: true, tags: true,
        },
        orderBy: { indexedAt: "desc" },
      },
    },
  });
}

export async function updatePackageGroupName(groupId: string, name: string) {
  return prisma.packageGroup.update({
    where: { id: groupId },
    data: { name: name.trim() },
  });
}

export async function updatePackageGroupPreview(groupId: string, previewData: Buffer) {
  return prisma.packageGroup.update({
    where: { id: groupId },
    data: { previewData: new Uint8Array(previewData) },
  });
}

export async function createManualGroup(name: string, packageIds: string[]) {
  // Verify all packages belong to the same channel
  const pkgs = await prisma.package.findMany({
    where: { id: { in: packageIds } },
    select: { sourceChannelId: true },
  });
  if (pkgs.length === 0) {
    throw new Error("No matching packages found");
  }
  const channelIds = new Set(pkgs.map((p) => p.sourceChannelId));
  if (channelIds.size > 1) {
    throw new Error("Cannot group packages from different channels");
  }

  const firstPkg = pkgs[0];
  const group = await prisma.packageGroup.create({
    data: {
      name: name.trim(),
      sourceChannelId: firstPkg.sourceChannelId,
    },
  });

  await prisma.package.updateMany({
    where: { id: { in: packageIds } },
    data: { packageGroupId: group.id },
  });

  // Clean up empty groups left behind
  await prisma.packageGroup.deleteMany({
    where: { packages: { none: {} }, id: { not: group.id } },
  });

  return group;
}

export async function addPackagesToGroup(packageIds: string[], groupId: string) {
  await prisma.package.updateMany({
    where: { id: { in: packageIds } },
    data: { packageGroupId: groupId },
  });
  await prisma.packageGroup.deleteMany({
    where: { packages: { none: {} } },
  });
}

export async function removePackageFromGroup(packageId: string) {
  const pkg = await prisma.package.findUniqueOrThrow({
    where: { id: packageId },
    select: { packageGroupId: true },
  });
  if (!pkg.packageGroupId) return;
  await prisma.package.update({
    where: { id: packageId },
    data: { packageGroupId: null },
  });
  await prisma.packageGroup.deleteMany({
    where: { id: pkg.packageGroupId, packages: { none: {} } },
  });
}

export async function dissolveGroup(groupId: string) {
  await prisma.package.updateMany({
    where: { packageGroupId: groupId },
    data: { packageGroupId: null },
  });
  await prisma.packageGroup.delete({ where: { id: groupId } });
}
