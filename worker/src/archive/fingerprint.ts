import type { FileEntry } from "./zip-reader.js";

export function crcFingerprint(entries: FileEntry[]): { crcs: string[]; complete: boolean } {
  if (entries.length === 0) return { crcs: [], complete: false };
  const crcs: string[] = [];
  let complete = true;
  for (const e of entries) {
    if (e.crc32 == null) { complete = false; continue; }
    crcs.push(e.crc32.toLowerCase());
  }
  crcs.sort();
  return { crcs, complete };
}

export function fingerprintsMatch(a: FileEntry[], b: FileEntry[]): boolean {
  const fa = crcFingerprint(a);
  const fb = crcFingerprint(b);
  if (!fa.complete || !fb.complete) return false;
  if (fa.crcs.length !== fb.crcs.length) return false;
  return fa.crcs.every((c, i) => c === fb.crcs[i]);
}
