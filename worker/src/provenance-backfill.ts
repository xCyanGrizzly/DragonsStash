import { childLogger } from "./util/logger.js";
import { downloadFileRange } from "./tdlib/range-download.js";
import { invokeWithTimeout } from "./tdlib/download.js";
import { parseZipCentralDirectoryFromTail, MIN_ZIP_TAIL_BYTES } from "./archive/central-directory.js";
import { fingerprintsMatch, crcFingerprint } from "./archive/fingerprint.js";
import {
  findPlaceholderCandidate,
  getPackageFileCrcs,
  backfillProvenance,
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

export async function tryProvenanceBackfill(
  args: BackfillArgs,
): Promise<{ backfilled: boolean; confidence?: "fingerprint" | "name-size" }> {
  const candidate = await findPlaceholderCandidate(args.destChannelId, args.fileName, args.fileSize);
  if (!candidate) return { backfilled: false };

  let entries: FileEntry[] | null = null;
  let confidence: "fingerprint" | "name-size" = "name-size";

  if (args.archiveType === "ZIP") {
    entries = await readScannedZipListing(args.client, args.scannedFileId, args.fileSize);
    if (entries) {
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
          args.client,
          candidate.destChannel.telegramId,
          destMessageId,
          candidate.fileSize,
        );
        if (destEntries) {
          candidateEntries = destEntries;
        }
      }
      if (fingerprintsMatch(entries, candidateEntries)) {
        confidence = "fingerprint";
      } else {
        // Fingerprint mismatch: NOT the same content despite name+size. Do not backfill.
        log.info({ candidateId: candidate.id, fileName: args.fileName }, "fingerprint mismatch — not backfilling");
        return { backfilled: false };
      }
    }
  }

  const ok = await backfillProvenance({
    packageId: candidate.id,
    destChannelId: args.destChannelId,
    sourceChannelId: args.scannedSourceChannelId,
    sourceMessageId: args.sourceMessageId,
    sourceTopicId: args.sourceTopicId,
    sourceCaption: args.sourceCaption,
    remoteUniqueId: args.remoteUniqueId,
    creator: args.creator,
    entries: candidate.fileCount === 0 && entries ? entries : undefined,
    previewData: args.previewData ?? undefined,
    previewMsgId: args.previewMsgId ?? undefined,
  });

  if (!ok) return { backfilled: false };
  log.info(
    { candidateId: candidate.id, fileName: args.fileName, confidence, source: args.scannedSourceChannelId },
    "provenance backfilled",
  );
  return { backfilled: true, confidence };
}
