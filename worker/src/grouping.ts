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
