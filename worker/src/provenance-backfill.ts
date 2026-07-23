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
  scannedFileId: string;
  previewData?: Buffer | null;
  previewMsgId?: bigint | null;
}

async function readScannedZipListing(
  client: Client,
  fileId: string,
  fileSize: bigint,
): Promise<FileEntry[] | null> {
  const total = Number(fileSize);
  for (const tailBytes of [MIN_ZIP_TAIL_BYTES, MIN_ZIP_TAIL_BYTES * 4]) {
    const start = Math.max(0, total - tailBytes);
    try {
      const tail = await downloadFileRange(client, fileId, start, Math.min(tailBytes, total), fileSize);
      return parseZipCentralDirectoryFromTail(tail, start);
    } catch (err) {
      if (err instanceof RangeError) continue; // try a larger tail
      log.warn({ err, fileId }, "ranged ZIP listing failed");
      return null;
    }
  }
  return null;
}

async function readZipListingFromDestination(
  client: Client,
  destChatTelegramId: bigint,
  destMessageId: bigint,
  fileSize: bigint,
): Promise<FileEntry[] | null> {
  try {
    // Resolve the destination message's document file id.
    const msg = (await invokeWithTimeout(client, {
      _: "getMessage",
      chat_id: Number(destChatTelegramId),
      message_id: Number(destMessageId),
    })) as { content?: { document?: { document?: { id: number } } } };
    const fid = msg?.content?.document?.document?.id;
    if (!fid) return null;
    return await readScannedZipListing(client, String(fid), fileSize);
  } catch (err) {
    log.warn({ err, destMessageId: Number(destMessageId) }, "destination ZIP listing read failed");
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
  const destMessageId =
    candidate.destMessageIds.length > 0
      ? candidate.destMessageIds[candidate.destMessageIds.length - 1]
      : candidate.destMessageId;
  if (!crcFingerprint(candidateEntries).complete && destMessageId && candidate.destChannel) {
    const destEntries = await readZipListingFromDestination(
      client,
      candidate.destChannel.telegramId,
      destMessageId,
      candidate.fileSize,
    );
    if (destEntries) {
      candidateEntries = destEntries;
    }
  }
  return candidateEntries;
}

export async function tryProvenanceBackfill(
  args: BackfillArgs,
): Promise<{ backfilled: boolean; confidence?: "fingerprint" | "name-size" }> {
  const candidates = await findPlaceholderCandidates(args.destChannelId, args.fileName, args.fileSize);
  if (candidates.length === 0) return { backfilled: false };

  let scannedEntries: FileEntry[] | null = null;
  if (args.archiveType === "ZIP") {
    scannedEntries = await readScannedZipListing(args.client, args.scannedFileId, args.fileSize);
  }

  let chosen = candidates[0];
  let confidence: "fingerprint" | "name-size" = "name-size";

  if (candidates.length > 1) {
    // Multiple placeholder packages share this name+size. Try to
    // disambiguate by fingerprint (ZIP only); if we can't uniquely resolve
    // it, notify instead of guessing which one is the real match.
    if (args.archiveType === "ZIP" && scannedEntries) {
      const matches: PlaceholderCandidate[] = [];
      for (const c of candidates) {
        const candidateEntries = await resolveCandidateFingerprintEntries(args.client, c);
        if (fingerprintsMatch(scannedEntries, candidateEntries)) matches.push(c);
      }
      if (matches.length === 1) {
        chosen = matches[0];
        confidence = "fingerprint";
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
    if (fingerprintsMatch(scannedEntries, candidateEntries)) {
      confidence = "fingerprint";
    } else {
      // Fingerprint mismatch: NOT the same content despite name+size. Do not backfill.
      log.info({ candidateId: chosen.id, fileName: args.fileName }, "fingerprint mismatch — not backfilling");
      return { backfilled: false };
    }
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
  log.info(
    { candidateId: chosen.id, fileName: args.fileName, confidence, source: args.scannedSourceChannelId },
    "provenance backfilled",
  );
  return { backfilled: true, confidence };
}
