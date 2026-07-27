import { mkdtemp, open, rm } from "fs/promises";
import path from "path";
import { config } from "../../util/config.js";
import { childLogger } from "../../util/logger.js";
import type { FileEntry } from "../zip-reader.js";

const log = childLogger("sparse-list");

export interface SparsePart {
  fileName: string;
  size: number;
  regions: { offset: number; bytes: Buffer }[];
}

export type SparseLister = (firstPartPath: string) => Promise<FileEntry[]>;

/**
 * Reconstruct archive header bytes into sparse temp files (data areas left as
 * zero holes), run `lister` on the first part, return its entries.
 * Returns null on any error or when the lister finds nothing.
 */
export async function listFromSparse(
  parts: SparsePart[],
  lister: SparseLister,
): Promise<FileEntry[] | null> {
  if (parts.length === 0) return null;
  const dir = await mkdtemp(path.join(config.tempDir, "ranged-"));
  try {
    let firstPath = "";
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const filePath = path.join(dir, p.fileName);
      if (i === 0) firstPath = filePath;
      const fh = await open(filePath, "w");
      try {
        await fh.truncate(p.size); // create the sparse hole
        for (const r of p.regions) {
          await fh.write(r.bytes, 0, r.bytes.length, r.offset);
        }
      } finally {
        await fh.close();
      }
    }
    const entries = await lister(firstPath);
    return entries.length > 0 ? entries : null;
  } catch (err) {
    log.warn({ err }, "sparse listing failed");
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
