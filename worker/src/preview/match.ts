import { childLogger } from "../util/logger.js";

const log = childLogger("preview-match");

export interface TelegramPhoto {
  id: bigint;
  date: Date;
  /** Caption text on the photo message (if any). */
  caption: string;
  /** The smallest photo size available — used as thumbnail. */
  fileId: string;
  fileSize: number;
  mediaAlbumId?: string;
}

export interface ArchiveRef {
  baseName: string;
  firstMessageId: bigint;
  firstMessageDate: Date;
}

/**
 * Try to match a photo message to an archive by:
 * 1. Caption contains the archive baseName (without extension)
 * 2. Photo was posted within ±10 messages (time-window: ±6 hours)
 *
 * Returns the best match (closest in time), or null.
 */
export function matchPreviewToArchive(
  photos: TelegramPhoto[],
  archives: ArchiveRef[]
): Map<string, TelegramPhoto> {
  const results = new Map<string, TelegramPhoto>();
  const TIME_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours

  for (const archive of archives) {
    // Normalize the archive base name for matching
    const normalizedBase = normalizeForMatch(archive.baseName);
    if (!normalizedBase) continue;

    let bestMatch: TelegramPhoto | null = null;
    let bestTimeDiff = Infinity;

    for (const photo of photos) {
      const timeDiff = Math.abs(
        photo.date.getTime() - archive.firstMessageDate.getTime()
      );

      // Must be within time window
      if (timeDiff > TIME_WINDOW_MS) continue;

      // Check if the photo caption contains the archive base name
      const normalizedCaption = normalizeForMatch(photo.caption);
      if (!normalizedCaption) continue;

      const matches =
        normalizedCaption.includes(normalizedBase) ||
        normalizedBase.includes(normalizedCaption);

      if (matches && timeDiff < bestTimeDiff) {
        bestMatch = photo;
        bestTimeDiff = timeDiff;
      }
    }

    if (bestMatch) {
      log.debug(
        { baseName: archive.baseName, photoId: bestMatch.id.toString() },
        "Matched preview photo to archive"
      );
      results.set(archive.baseName, bestMatch);
    }
  }

  return results;
}

/**
 * Strip extension, punctuation, and normalize for fuzzy matching.
 */
function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, "") // strip extension
    .replace(/[_\-.\s]+/g, " ") // normalize separators
    .trim();
}
