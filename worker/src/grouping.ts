import type { Client } from "tdl";
import type { TelegramPhoto } from "./preview/match.js";
import { downloadPhotoThumbnail } from "./tdlib/download.js";
import { createOrFindPackageGroup, linkPackagesToGroup, createTimeWindowGroup, createAutoGroup } from "./db/queries.js";
import { config } from "./util/config.js";
import { childLogger } from "./util/logger.js";
import { db } from "./db/client.js";

const log = childLogger("grouping");

export interface IndexedPackageRef {
  packageId: string;
  sourceMessageId: bigint;
  mediaAlbumId?: string;
}

/**
 * After a scan cycle's packages are individually indexed, detect album groups
 * and create PackageGroup records linking the members.
 */
export async function processAlbumGroups(
  client: Client,
  sourceChannelId: string,
  indexedPackages: IndexedPackageRef[],
  photos: TelegramPhoto[]
): Promise<void> {
  // Group indexed packages by mediaAlbumId
  const albumMap = new Map<string, IndexedPackageRef[]>();
  for (const pkg of indexedPackages) {
    if (!pkg.mediaAlbumId || pkg.mediaAlbumId === "0") continue;
    const group = albumMap.get(pkg.mediaAlbumId) ?? [];
    group.push(pkg);
    albumMap.set(pkg.mediaAlbumId, group);
  }

  if (albumMap.size === 0) return;

  log.info({ albumCount: albumMap.size }, "Detected album groups to process");

  for (const [albumId, members] of albumMap) {
    if (members.length < 2) continue;

    try {
      // Find the first package's fileName for the group name fallback
      const firstPkg = await db.package.findFirst({
        where: { id: { in: members.map((m) => m.packageId) } },
        orderBy: { sourceMessageId: "asc" },
        select: { id: true, fileName: true },
      });

      // Try to find a caption from the album's photo message
      const albumPhoto = photos.find((p) => p.mediaAlbumId === albumId);
      const groupName = albumPhoto?.caption || firstPkg?.fileName || "Unnamed Group";

      // Download preview from album photo if available
      let previewData: Buffer | null = null;
      if (albumPhoto) {
        previewData = await downloadPhotoThumbnail(client, albumPhoto.fileId);
      }

      const groupId = await createOrFindPackageGroup({
        mediaAlbumId: albumId,
        sourceChannelId,
        name: groupName,
        previewData,
      });

      // Idempotent link — safe to re-run if some packages were indexed in prior scans
      const packageIds = members.map((m) => m.packageId);
      await linkPackagesToGroup(packageIds, groupId);

      log.info(
        { albumId, groupId, groupName, memberCount: packageIds.length },
        "Linked packages to album group"
      );
    } catch (err) {
      log.warn({ albumId, err }, "Failed to create album group — packages still indexed individually");
    }
  }
}

/**
 * After album grouping, cluster remaining ungrouped packages from the same channel
 * that were posted within a configurable time window.
 * Only groups packages that were just indexed in this scan cycle (the `indexedPackages` list).
 */
export async function processTimeWindowGroups(
  sourceChannelId: string,
  indexedPackages: IndexedPackageRef[]
): Promise<void> {
  if (config.autoGroupTimeWindowMinutes <= 0) return;

  // Find which of the just-indexed packages are still ungrouped
  const ungrouped = await db.package.findMany({
    where: {
      id: { in: indexedPackages.map((p) => p.packageId) },
      packageGroupId: null,
    },
    orderBy: { sourceMessageId: "asc" },
    select: {
      id: true,
      fileName: true,
      sourceMessageId: true,
      indexedAt: true,
    },
  });

  if (ungrouped.length < 2) return;

  const windowMs = config.autoGroupTimeWindowMinutes * 60 * 1000;

  // Cluster by time proximity: walk through sorted list, start new cluster when gap > window
  const clusters: typeof ungrouped[] = [];
  let current: typeof ungrouped = [ungrouped[0]];

  for (let i = 1; i < ungrouped.length; i++) {
    const prev = current[current.length - 1];
    const gap = Math.abs(ungrouped[i].indexedAt.getTime() - prev.indexedAt.getTime());

    if (gap <= windowMs) {
      current.push(ungrouped[i]);
    } else {
      clusters.push(current);
      current = [ungrouped[i]];
    }
  }
  clusters.push(current);

  // Create groups for clusters with 2+ packages
  for (const cluster of clusters) {
    if (cluster.length < 2) continue;

    // Derive group name from common filename prefix
    const name = findCommonPrefix(cluster.map((p) => p.fileName)) || cluster[0].fileName;

    try {
      const groupId = await createTimeWindowGroup({
        sourceChannelId,
        name,
        packageIds: cluster.map((p) => p.id),
      });

      log.info(
        { groupId, name, memberCount: cluster.length },
        "Created time-window group"
      );
    } catch (err) {
      log.warn({ err, clusterSize: cluster.length }, "Failed to create time-window group");
    }
  }
}

/**
 * Group ungrouped packages that share a date pattern (YYYY-MM, YYYY_MM, etc.)
 * or project slug extracted from their filenames.
 */
export async function processPatternGroups(
  sourceChannelId: string,
  indexedPackages: IndexedPackageRef[]
): Promise<void> {
  const ungrouped = await db.package.findMany({
    where: {
      id: { in: indexedPackages.map((p) => p.packageId) },
      packageGroupId: null,
    },
    select: { id: true, fileName: true },
  });

  if (ungrouped.length < 2) return;

  // Group by extracted pattern
  const patternMap = new Map<string, typeof ungrouped>();
  for (const pkg of ungrouped) {
    const pattern = extractPattern(pkg.fileName);
    if (!pattern) continue;
    const group = patternMap.get(pattern) ?? [];
    group.push(pkg);
    patternMap.set(pattern, group);
  }

  for (const [pattern, members] of patternMap) {
    if (members.length < 2) continue;

    try {
      const groupId = await createAutoGroup({
        sourceChannelId,
        name: pattern,
        packageIds: members.map((m) => m.id),
        groupingSource: "AUTO_PATTERN",
      });

      log.info(
        { groupId, pattern, memberCount: members.length },
        "Created pattern-based group"
      );
    } catch (err) {
      log.warn({ err, pattern }, "Failed to create pattern group");
    }
  }
}

/**
 * Extract a grouping pattern from a filename.
 * Matches: YYYY-MM, YYYY_MM, "Month Year", or a project prefix before common separators.
 * Returns null if no usable pattern found.
 */
function extractPattern(fileName: string): string | null {
  // Strip extension for matching
  const name = fileName.replace(/\.(zip|rar|7z|pdf|stl)(\.\d+)?$/i, "");

  // Match YYYY-MM or YYYY_MM patterns
  const dateMatch = name.match(/(\d{4})[\-_](\d{2})/);
  if (dateMatch) {
    return `${dateMatch[1]}-${dateMatch[2]}`;
  }

  // Match "Month Year" patterns (e.g., "January 2025", "Jan 2025")
  const months = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const monthYearMatch = name.match(new RegExp(`(${months})\\s*(\\d{4})`, "i"));
  if (monthYearMatch) {
    const monthStr = monthYearMatch[1].toLowerCase().slice(0, 3);
    const monthNum = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(monthStr) + 1;
    if (monthNum > 0) {
      return `${monthYearMatch[2]}-${String(monthNum).padStart(2, "0")}`;
    }
  }

  // Match project prefix: text before " - ", " – ", or "(". Must be at least 5 chars.
  const prefixMatch = name.match(/^(.{5,}?)(?:\s*[\-–]\s|\s*\()/);
  if (prefixMatch) {
    return prefixMatch[1].trim();
  }

  return null;
}

/**
 * Group ungrouped packages that share the same creator within a channel.
 * Only groups if there are 3+ packages from the same creator (to avoid
 * over-grouping when a creator only has a couple files).
 */
export async function processCreatorGroups(
  sourceChannelId: string,
  indexedPackages: IndexedPackageRef[]
): Promise<void> {
  const ungrouped = await db.package.findMany({
    where: {
      id: { in: indexedPackages.map((p) => p.packageId) },
      packageGroupId: null,
      creator: { not: null },
    },
    select: { id: true, fileName: true, creator: true },
  });

  if (ungrouped.length < 3) return;

  // Group by creator
  const creatorMap = new Map<string, typeof ungrouped>();
  for (const pkg of ungrouped) {
    if (!pkg.creator) continue;
    const key = pkg.creator.toLowerCase();
    const group = creatorMap.get(key) ?? [];
    group.push(pkg);
    creatorMap.set(key, group);
  }

  for (const [, members] of creatorMap) {
    if (members.length < 3) continue;

    const creatorName = members[0].creator!;
    const name = findCommonPrefix(members.map((m) => m.fileName)) || creatorName;

    try {
      const groupId = await createAutoGroup({
        sourceChannelId,
        name,
        packageIds: members.map((m) => m.id),
        groupingSource: "AUTO_PATTERN",
      });

      log.info(
        { groupId, creator: creatorName, memberCount: members.length },
        "Created creator-based group"
      );
    } catch (err) {
      log.warn({ err, creator: creatorName }, "Failed to create creator group");
    }
  }
}

/**
 * Group ungrouped packages that share the same root folder inside their archives.
 * E.g., if two packages both contain files under "ProjectX/", they're likely related.
 * Only considers packages with 3+ files (to avoid false positives from flat archives).
 */
export async function processZipPathGroups(
  sourceChannelId: string,
  indexedPackages: IndexedPackageRef[]
): Promise<void> {
  // Find ungrouped packages that have indexed files
  const ungrouped = await db.package.findMany({
    where: {
      id: { in: indexedPackages.map((p) => p.packageId) },
      packageGroupId: null,
      fileCount: { gte: 3 },
    },
    select: {
      id: true,
      fileName: true,
      files: {
        select: { path: true },
        take: 50,
      },
    },
  });

  if (ungrouped.length < 2) return;

  // Extract the dominant root folder for each package
  const packageRoots = new Map<string, { id: string; fileName: string }[]>();

  for (const pkg of ungrouped) {
    const root = extractRootFolder(pkg.files.map((f) => f.path));
    if (!root) continue;

    const key = root.toLowerCase();
    const group = packageRoots.get(key) ?? [];
    group.push({ id: pkg.id, fileName: pkg.fileName });
    packageRoots.set(key, group);
  }

  // Create groups for roots shared by 2+ packages
  for (const [root, members] of packageRoots) {
    if (members.length < 2) continue;

    try {
      const groupId = await createAutoGroup({
        sourceChannelId,
        name: root,
        packageIds: members.map((m) => m.id),
        groupingSource: "AUTO_ZIP",
      });

      log.info(
        { groupId, rootFolder: root, memberCount: members.length },
        "Created ZIP path prefix group"
      );
    } catch (err) {
      log.warn({ err, rootFolder: root }, "Failed to create ZIP path group");
    }
  }
}

/**
 * Group ungrouped packages that reply to the same root message.
 * If message B and C both reply to message A, they're grouped together.
 */
export async function processReplyChainGroups(
  sourceChannelId: string,
  indexedPackages: IndexedPackageRef[]
): Promise<void> {
  const ungrouped = await db.package.findMany({
    where: {
      id: { in: indexedPackages.map((p) => p.packageId) },
      packageGroupId: null,
      replyToMessageId: { not: null },
    },
    select: {
      id: true,
      fileName: true,
      replyToMessageId: true,
    },
  });

  if (ungrouped.length < 2) return;

  // Group by replyToMessageId
  const replyMap = new Map<string, typeof ungrouped>();
  for (const pkg of ungrouped) {
    if (!pkg.replyToMessageId) continue;
    const key = pkg.replyToMessageId.toString();
    const group = replyMap.get(key) ?? [];
    group.push(pkg);
    replyMap.set(key, group);
  }

  for (const [replyId, members] of replyMap) {
    if (members.length < 2) continue;

    const name = findCommonPrefix(members.map((m) => m.fileName)) || members[0].fileName;

    try {
      const groupId = await createAutoGroup({
        sourceChannelId,
        name,
        packageIds: members.map((m) => m.id),
        groupingSource: "AUTO_REPLY" as const,
      });

      log.info(
        { groupId, replyToMessageId: replyId, memberCount: members.length },
        "Created reply-chain group"
      );
    } catch (err) {
      log.warn({ err, replyToMessageId: replyId }, "Failed to create reply-chain group");
    }
  }
}

/**
 * Group ungrouped packages with similar captions from the same channel.
 * Uses normalized caption comparison — two captions match if they share
 * the same significant words (ignoring common words and file extensions).
 */
export async function processCaptionGroups(
  sourceChannelId: string,
  indexedPackages: IndexedPackageRef[]
): Promise<void> {
  const ungrouped = await db.package.findMany({
    where: {
      id: { in: indexedPackages.map((p) => p.packageId) },
      packageGroupId: null,
      sourceCaption: { not: null },
    },
    select: {
      id: true,
      fileName: true,
      sourceCaption: true,
    },
  });

  if (ungrouped.length < 2) return;

  // Group by normalized caption key
  const captionMap = new Map<string, typeof ungrouped>();
  for (const pkg of ungrouped) {
    if (!pkg.sourceCaption) continue;
    const key = normalizeCaptionKey(pkg.sourceCaption);
    if (!key) continue;
    const group = captionMap.get(key) ?? [];
    group.push(pkg);
    captionMap.set(key, group);
  }

  for (const [, members] of captionMap) {
    if (members.length < 2) continue;

    const name = members[0].sourceCaption!.slice(0, 80);

    try {
      const groupId = await createAutoGroup({
        sourceChannelId,
        name,
        packageIds: members.map((m) => m.id),
        groupingSource: "AUTO_CAPTION" as const,
      });

      log.info(
        { groupId, memberCount: members.length },
        "Created caption-match group"
      );
    } catch (err) {
      log.warn({ err }, "Failed to create caption group");
    }
  }
}

/**
 * Normalize a caption for grouping: lowercase, strip extensions and numbers,
 * extract significant words (3+ chars), sort, and join.
 * Two captions with the same key are considered a match.
 */
function normalizeCaptionKey(caption: string): string | null {
  const stripped = caption
    .toLowerCase()
    .replace(/\.(zip|rar|7z|stl|pdf|obj|gcode)(\.\d+)?/gi, "")
    .replace(/[^a-z0-9\s]/g, " ");

  const words = stripped
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .filter((w) => !["the", "and", "for", "with", "from", "part", "file", "files"].includes(w));

  if (words.length < 2) return null;

  return words.sort().join(" ");
}

/**
 * Extract the dominant root folder from a list of archive file paths.
 * Returns the first path segment that appears in >50% of files.
 * Returns null for flat archives or archives with no common root.
 */
function extractRootFolder(paths: string[]): string | null {
  if (paths.length === 0) return null;

  // Count first path segments
  const segmentCounts = new Map<string, number>();
  for (const p of paths) {
    // Normalize separators and get first segment
    const normalized = p.replace(/\\/g, "/");
    const firstSlash = normalized.indexOf("/");
    if (firstSlash <= 0) continue; // Skip root-level files
    const segment = normalized.slice(0, firstSlash);
    // Skip common noise folders
    if (segment === "__MACOSX" || segment === ".DS_Store" || segment === "Thumbs.db") continue;
    segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1);
  }

  if (segmentCounts.size === 0) return null;

  // Find the most common segment
  let maxSegment = "";
  let maxCount = 0;
  for (const [seg, count] of segmentCounts) {
    if (count > maxCount) {
      maxSegment = seg;
      maxCount = count;
    }
  }

  // Must appear in >50% of files and be at least 3 chars
  if (maxCount < paths.length * 0.5 || maxSegment.length < 3) return null;

  return maxSegment;
}

/**
 * Find the longest common prefix among a list of filenames,
 * trimming trailing separators and partial words.
 */
function findCommonPrefix(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];

  let prefix = names[0];
  for (let i = 1; i < names.length; i++) {
    while (!names[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return "";
    }
  }

  // Trim trailing separators and partial words
  const trimmed = prefix.replace(/[\s\-_.(]+$/, "");
  return trimmed.length >= 3 ? trimmed : "";
}
