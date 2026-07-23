import { db } from "./db/client.js";
import { childLogger } from "./util/logger.js";
import { downloadFileRange } from "./tdlib/range-download.js";
import { invokeWithTimeout } from "./tdlib/download.js";
import { parseZipCentralDirectoryFromTail, MIN_ZIP_TAIL_BYTES } from "./archive/central-directory.js";
import { fingerprintsMatch, crcFingerprint } from "./archive/fingerprint.js";
import {
  findPlaceholderCandidates,
  getPackageFileCrcs,
  backfillProvenance,
  type PlaceholderCandidate,
} from "./db/queries.js";
import type { FileEntry } from "./archive/zip-reader.js";
import type { Client } from "tdl";

const log = childLogger("provenance-backfill");

export interface BackfillArgs {
  client: Client;
  destChannelId: string;
  scannedSourceChannelId: string;
  fileName: string;
  fileSize: bigint;
  archiveType: string;
  sourceMessageId: bigint;
  sourceTopicId: bigint | null;
  sourceCaption: string | null;
  remoteUniqueId: string | null;
  creator: string | null;
  scannedParts: { fileId: string; fileSize: bigint }[];
  previewData?: Buffer | null;
  previewMsgId?: bigint | null;
}

/**
 * Read a ZIP central directory from the tail of a (possibly multipart)
 * archive. `parts` is ordered; only the LAST part carries the EOCD record.
 * `fileSize` on each part is that part's own size (NOT the whole-archive
 * total) so the download offset stays within that part's bounds, while
 * `tailStart` passed to the parser is the logical whole-archive offset
 * (preceding parts' sizes + the offset within the last part).
 */
async function readScannedZipListing(
  client: Client,
  parts: { fileId: string; fileSize: bigint }[],
): Promise<FileEntry[] | null> {
  if (parts.length === 0) return null;
  const lastPart = parts[parts.length - 1];
  const precedingSize = parts.slice(0, -1).reduce((sum, p) => sum + Number(p.fileSize), 0);
  const lastSize = Number(lastPart.fileSize);
  for (const tailBytes of [MIN_ZIP_TAIL_BYTES, MIN_ZIP_TAIL_BYTES * 4]) {
    const partOffset = Math.max(0, lastSize - tailBytes);
    const downloadLen = Math.min(tailBytes, lastSize);
    try {
      const buf = await downloadFileRange(client, lastPart.fileId, partOffset, downloadLen, lastPart.fileSize);
      const tailStart = precedingSize + partOffset;
      return parseZipCentralDirectoryFromTail(buf, tailStart);
    } catch (err) {
      if (err instanceof RangeError) continue; // try a larger tail
      log.warn({ err, fileId: lastPart.fileId }, "ranged ZIP listing failed");
      return null;
    }
  }
  return null;
}

async function readZipListingFromDestination(
  client: Client,
  destChatTelegramId: bigint,
  destMessageIds: bigint[],
  destMessageId: bigint | null,
): Promise<FileEntry[] | null> {
  const messageIds = destMessageIds.length > 0 ? destMessageIds : destMessageId ? [destMessageId] : [];
  if (messageIds.length === 0) return null;
  try {
    // Resolve each destination message's document file id + size, in order,
    // so a multipart destination copy is reconstructed with correct
    // per-part sizes (the last message carries the EOCD-bearing tail part).
    const parts: { fileId: string; fileSize: bigint }[] = [];
    for (const msgId of messageIds) {
      const msg = (await invokeWithTimeout(client, {
        _: "getMessage",
        chat_id: Number(destChatTelegramId),
        message_id: Number(msgId),
      })) as { content?: { document?: { document?: { id: number; size?: number } } } };
      const doc = msg?.content?.document?.document;
      if (!doc?.id) return null;
      parts.push({ fileId: String(doc.id), fileSize: BigInt(doc.size ?? 0) });
    }
    return await readScannedZipListing(client, parts);
  } catch (err) {
    log.warn({ err, destMessageIds: messageIds.map(Number) }, "destination ZIP listing read failed");
    return null;
  }
}

/**
 * Build the CRC fingerprint entries for a placeholder candidate: start from
 * its stored PackageFile CRCs, and if those are incomplete (e.g. a rebuild
 * candidate with fileCount === 0), fall back to a fresh ranged read of the
 * candidate's own copy in the destination channel (Task 9).
 */
async function resolveCandidateFingerprintEntries(
  client: Client,
  candidate: PlaceholderCandidate,
): Promise<FileEntry[]> {
  const candidateCrcs = await getPackageFileCrcs(candidate.id);
  let candidateEntries: FileEntry[] = candidateCrcs.map((crc) => ({
    path: "", fileName: "", extension: null, compressedSize: 0n, uncompressedSize: 0n, crc32: crc,
  }));
  const hasDestMessage = candidate.destMessageIds.length > 0 || candidate.destMessageId != null;
  if (!crcFingerprint(candidateEntries).complete && hasDestMessage && candidate.destChannel) {
    const destEntries = await readZipListingFromDestination(
      client,
      candidate.destChannel.telegramId,
      candidate.destMessageIds,
      candidate.destMessageId,
    );
    if (destEntries) {
      candidateEntries = destEntries;
    }
  }
  return candidateEntries;
}

/**
 * Classify a fingerprint comparison between two entry sets. "incomplete"
 * means at least one side is missing CRCs (e.g. an empty file → CRC32 of
 * zero-length data → null) and the comparison CANNOT be used to confirm or
 * refute a match — callers must fall back to name+size confidence rather
 * than treating this as a mismatch.
 */
function compareFingerprints(a: FileEntry[], b: FileEntry[]): "match" | "mismatch" | "incomplete" {
  const fa = crcFingerprint(a);
  const fb = crcFingerprint(b);
  if (!fa.complete || !fb.complete) return "incomplete";
  return fingerprintsMatch(a, b) ? "match" : "mismatch";
}

export async function tryProvenanceBackfill(
  args: BackfillArgs,
): Promise<{ backfilled: boolean; confidence?: "fingerprint" | "name-size" }> {
  const candidates = await findPlaceholderCandidates(args.destChannelId, args.fileName, args.fileSize);
  if (candidates.length === 0) return { backfilled: false };

  let scannedEntries: FileEntry[] | null = null;
  if (args.archiveType === "ZIP") {
    scannedEntries = await readScannedZipListing(args.client, args.scannedParts);
  }

  let chosen = candidates[0];
  let confidence: "fingerprint" | "name-size" = "name-size";

  if (candidates.length > 1) {
    // Multiple placeholder packages share this name+size. Try to
    // disambiguate by fingerprint (ZIP only); if we can't uniquely resolve
    // it, notify instead of guessing which one is the real match.
    if (args.archiveType === "ZIP" && scannedEntries) {
      const matches: PlaceholderCandidate[] = [];
      // Candidates NOT ruled out as a definite (both-complete) mismatch —
      // used as the name+size fallback pool when the fingerprint can't
      // confirm a match (e.g. incomplete CRCs on either side).
      const nonMismatches: PlaceholderCandidate[] = [];
      for (const c of candidates) {
        const candidateEntries = await resolveCandidateFingerprintEntries(args.client, c);
        const comparison = compareFingerprints(scannedEntries, candidateEntries);
        if (comparison === "match") {
          matches.push(c);
          nonMismatches.push(c);
        } else if (comparison === "incomplete") {
          nonMismatches.push(c);
        }
        // comparison === "mismatch": both sides complete and differ — excluded.
      }
      if (matches.length === 1) {
        chosen = matches[0];
        confidence = "fingerprint";
      } else if (matches.length === 0 && nonMismatches.length === 1) {
        // Fingerprint couldn't confirm (incomplete CRCs), but exactly one
        // candidate wasn't ruled out as a definite mismatch — fall back to
        // name+size confidence rather than treating this as unresolved.
        chosen = nonMismatches[0];
        confidence = "name-size";
      } else {
        await db.systemNotification.create({
          data: {
            type: "INTEGRITY_AUDIT",
            severity: "WARNING",
            title: `Ambiguous provenance match: ${args.fileName}`,
            message: `${candidates.length} placeholder packages share this name+size and the fingerprint did not uniquely disambiguate. No provenance was backfilled.`,
            context: { fileName: args.fileName, candidateIds: candidates.map((c) => c.id) },
          },
        });
        return { backfilled: false };
      }
    } else {
      // Can't disambiguate without a fingerprint — notify, don't guess.
      await db.systemNotification.create({
        data: {
          type: "INTEGRITY_AUDIT",
          severity: "WARNING",
          title: `Ambiguous provenance match: ${args.fileName}`,
          message: `${candidates.length} placeholder packages share this name+size (archive type ${args.archiveType} — no cheap fingerprint). No provenance was backfilled.`,
          context: { fileName: args.fileName, candidateIds: candidates.map((c) => c.id) },
        },
      });
      return { backfilled: false };
    }
  } else if (scannedEntries) {
    const candidateEntries = await resolveCandidateFingerprintEntries(args.client, chosen);
    const comparison = compareFingerprints(scannedEntries, candidateEntries);
    if (comparison === "match") {
      confidence = "fingerprint";
    } else if (comparison === "mismatch") {
      // Both sides' CRCs are complete and differ: NOT the same content
      // despite name+size. Do not backfill.
      log.info({ candidateId: chosen.id, fileName: args.fileName }, "fingerprint mismatch — not backfilling");
      return { backfilled: false };
    }
    // comparison === "incomplete": can't confirm or refute by fingerprint —
    // fall through and backfill on name+size confidence instead.
  }

  const ok = await backfillProvenance({
    packageId: chosen.id,
    destChannelId: args.destChannelId,
    sourceChannelId: args.scannedSourceChannelId,
    sourceMessageId: args.sourceMessageId,
    sourceTopicId: args.sourceTopicId,
    sourceCaption: args.sourceCaption,
    remoteUniqueId: args.remoteUniqueId,
    creator: args.creator,
    entries: chosen.fileCount === 0 && scannedEntries ? scannedEntries : undefined,
    previewData: args.previewData ?? undefined,
    previewMsgId: args.previewMsgId ?? undefined,
  });

  if (!ok) return { backfilled: false };

  if (confidence === "name-size") {
    // Lower-confidence backfill: no CRC fingerprint guard confirmed this
    // match. Record it as an auditable event so name+size-only backfills
    // can be reviewed after the fact.
    await db.systemNotification.create({
      data: {
        type: "INTEGRITY_AUDIT",
        severity: "INFO",
        title: `Provenance backfilled by name+size: ${args.fileName}`,
        message: `Package ${chosen.id} was matched to a scanned source message by file name and size only (no CRC fingerprint confirmation).`,
        context: {
          packageId: chosen.id,
          fileName: args.fileName,
          sourceChannelId: args.scannedSourceChannelId,
        },
      },
    });
  }

  log.info(
    { candidateId: chosen.id, fileName: args.fileName, confidence, source: args.scannedSourceChannelId },
    "provenance backfilled",
  );
  return { backfilled: true, confidence };
}
