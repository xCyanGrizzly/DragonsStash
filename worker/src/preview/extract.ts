import { execFile } from "child_process";
import { promisify } from "util";
import { childLogger } from "../util/logger.js";
import type { FileEntry } from "../archive/zip-reader.js";

const execFileAsync = promisify(execFile);
const log = childLogger("preview-extract");

/** Max bytes we'll accept for an extracted preview image (2MB). */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Image extensions we consider valid previews, in priority order. */
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png"]);

/**
 * Pick the best preview image from the file entries list.
 *
 * Prefers files that look like dedicated preview images (01.jpg, insta.jpg,
 * preview.jpg) over arbitrary images buried in subdirectories.
 * Skips images that are suspiciously large (>2MB uncompressed).
 */
export function pickPreviewFile(entries: FileEntry[]): FileEntry | null {
  const candidates = entries.filter((e) => {
    if (!e.extension || !IMAGE_EXTENSIONS.has(e.extension.toLowerCase())) return false;
    // Skip very large images — they're probably textures, not previews
    if (e.uncompressedSize > BigInt(MAX_PREVIEW_BYTES)) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // Score candidates: lower depth + preview-like names win
  const scored = candidates.map((entry) => {
    const depth = entry.path.split("/").length - 1;
    const nameLower = entry.fileName.toLowerCase();

    let nameScore = 10; // default
    // Known preview-like names get priority
    if (/^(preview|thumb|cover|insta)\b/i.test(nameLower)) {
      nameScore = 0;
    } else if (/^0*[1-2]\.(jpe?g|png)$/i.test(nameLower)) {
      // 01.jpg, 1.jpg, 02.jpg — common preview filenames
      nameScore = 1;
    } else if (/^0*[3-9]\.(jpe?g|png)$/i.test(nameLower)) {
      nameScore = 2;
    }

    return { entry, score: nameScore + depth };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored[0].entry;
}

/**
 * Extract a single file from an archive and return its contents as a Buffer.
 *
 * Uses the appropriate CLI tool based on archive type:
 * - ZIP: unzip -p
 * - RAR: unrar p -inul
 * - 7Z: 7z e -so
 */
export async function extractPreviewImage(
  archivePath: string,
  archiveType: "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT",
  filePath: string
): Promise<Buffer | null> {
  if (archiveType === "DOCUMENT") return null;

  try {
    let stdout: Buffer;

    if (archiveType === "ZIP") {
      const result = await execFileAsync("unzip", ["-p", archivePath, filePath], {
        timeout: 15000,
        maxBuffer: MAX_PREVIEW_BYTES,
        encoding: "buffer",
      });
      stdout = result.stdout as unknown as Buffer;
    } else if (archiveType === "RAR") {
      const result = await execFileAsync("unrar", ["p", "-inul", archivePath, filePath], {
        timeout: 15000,
        maxBuffer: MAX_PREVIEW_BYTES,
        encoding: "buffer",
      });
      stdout = result.stdout as unknown as Buffer;
    } else {
      // SEVEN_Z
      const result = await execFileAsync("7z", ["e", "-so", archivePath, filePath], {
        timeout: 15000,
        maxBuffer: MAX_PREVIEW_BYTES,
        encoding: "buffer",
      });
      stdout = result.stdout as unknown as Buffer;
    }

    if (stdout.length === 0) {
      log.warn({ archivePath, filePath }, "Extracted preview image is empty");
      return null;
    }

    log.debug(
      { archivePath, filePath, bytes: stdout.length },
      "Extracted preview image from archive"
    );
    return stdout;
  } catch (err) {
    log.warn({ err, archivePath, filePath }, "Failed to extract preview image from archive");
    return null;
  }
}
