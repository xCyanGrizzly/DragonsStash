import { createHash } from "crypto";
import { crcFingerprint } from "./fingerprint.js";
import type { FileEntry } from "./zip-reader.js";

/**
 * Derive a Package.contentHash-compatible identity string for a forward-path
 * package (no downloaded bytes exist to hash directly). Priority order:
 *   1. A CRC32-fingerprint hash, when the ranged listing's CRCs are complete
 *      (ZIP/RAR today) — the strongest available signal, since it lets
 *      forward-path and download-path copies of the same archive still
 *      collide/dedupe on identical content.
 *   2. TDLib's remote.unique_id, when CRCs are incomplete (7z today has none).
 *   3. sourceChannelId+sourceMessageId, as a last-resort unique value so the
 *      required-unique Package.contentHash column is always satisfiable.
 * Follows the same `<prefix>:<value>` synthetic-hash convention already used
 * by `rebuild.ts`'s `rebuild:${destChannelId}:${destMessageId}` placeholder.
 */
export function deriveForwardContentHash(
  entries: FileEntry[],
  remoteUniqueId: string | null,
  sourceChannelId: string,
  sourceMessageId: bigint,
): string {
  const fp = crcFingerprint(entries);
  if (fp.complete && fp.crcs.length > 0) {
    const hash = createHash("sha256").update(fp.crcs.join(",")).digest("hex");
    return `fingerprint:${hash}`;
  }
  if (remoteUniqueId) {
    return `forward:${remoteUniqueId}`;
  }
  return `forward:${sourceChannelId}:${sourceMessageId}`;
}
