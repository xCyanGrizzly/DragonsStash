import type { Client } from "tdl";
import type { TelegramPhoto } from "./preview/match.js";
import { downloadPhotoThumbnail } from "./tdlib/download.js";
import { createOrFindPackageGroup, linkPackagesToGroup } from "./db/queries.js";
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
