import type { Client } from "tdl";
import type { TelegramPhoto } from "./preview/match.js";
import { downloadPhotoThumbnail } from "./tdlib/download.js";
import { createOrFindPackageGroup, linkPackagesToGroup, createTimeWindowGroup } from "./db/queries.js";
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
