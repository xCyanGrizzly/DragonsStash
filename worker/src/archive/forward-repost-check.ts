import type { Client } from "tdl";
import type { FileEntry } from "./zip-reader.js";
import { compareFingerprints, resolveCandidateFingerprintEntries } from "../provenance-backfill.js";
import { findFingerprintDedupCandidates } from "../db/queries.js";

export interface FingerprintRepostResult {
  isDuplicate: boolean;
  matchedPackageId: string | null;
}

/**
 * Cross-channel duplicate check for the forward-priority path: compare the
 * new archive's CRC fingerprint against every existing Package sharing its
 * name+size, regardless of which channel or ingestion path produced them.
 * This is what lets a forwarded copy dedupe against a previously
 * fully-downloaded copy of the same archive, despite never sharing a
 * byte-hash-derived contentHash.
 */
export async function checkFingerprintRepost(
  client: Client,
  entries: FileEntry[],
  fileName: string,
  fileSize: bigint,
): Promise<FingerprintRepostResult> {
  const candidates = await findFingerprintDedupCandidates(fileName, fileSize);
  for (const candidate of candidates) {
    const candidateEntries = await resolveCandidateFingerprintEntries(client, candidate);
    if (compareFingerprints(entries, candidateEntries) === "match") {
      return { isDuplicate: true, matchedPackageId: candidate.id };
    }
  }
  return { isDuplicate: false, matchedPackageId: null };
}
