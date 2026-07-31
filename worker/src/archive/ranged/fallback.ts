import { mkdtemp, rm } from "fs/promises";
import path from "path";
import type { Client } from "tdl";
import { config } from "../../util/config.js";
import { db } from "../../db/client.js";
import { childLogger } from "../../util/logger.js";
import { downloadFile } from "../../tdlib/download.js";
import { read7zContents } from "../sevenz-reader.js";
import { readRarContents } from "../rar-reader.js";
import type { FileEntry } from "../zip-reader.js";
import type { RangedPart } from "./sevenz-ranged.js";

const log = childLogger("ranged-fallback");

export async function fullDownloadListing(args: {
  client: Client;
  parts: RangedPart[];
  archiveType: string;
  totalSize: bigint;
  fileName: string;
}): Promise<FileEntry[] | null> {
  const capBytes = BigInt(config.maxZipSizeMB) * 1024n * 1024n;
  if (args.totalSize > capBytes) {
    await db.systemNotification.create({
      data: {
        type: "INTEGRITY_AUDIT",
        severity: "WARNING",
        title: `Listing skipped (over size cap): ${args.fileName}`,
        message: `Ranged listing failed and the archive (${args.totalSize} bytes) exceeds WORKER_MAX_ZIP_SIZE_MB; not downloaded. Inner files left unindexed.`,
        context: { fileName: args.fileName, archiveType: args.archiveType },
      },
    });
    log.warn({ fileName: args.fileName }, "fallback skipped — over size cap");
    return null;
  }
  const dir = await mkdtemp(path.join(config.tempDir, "fallback-"));
  const paths: string[] = [];
  try {
    for (const p of args.parts) {
      const dest = path.join(dir, p.fileName);
      await downloadFile(args.client, p.fileId, dest, p.fileSize, p.fileName, () => {});
      paths.push(dest);
    }
    const entries =
      args.archiveType === "SEVEN_Z" ? await read7zContents(paths[0])
      : args.archiveType === "RAR" ? await readRarContents(paths[0])
      : [];
    return entries.length > 0 ? entries : null;
  } catch (err) {
    log.warn({ err, fileName: args.fileName }, "full-download fallback failed");
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
