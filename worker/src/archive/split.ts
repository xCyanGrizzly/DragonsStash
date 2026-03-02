import { createReadStream, createWriteStream } from "fs";
import { stat } from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { childLogger } from "../util/logger.js";

const log = childLogger("split");

/** 2GB in bytes — Telegram's file size limit */
const MAX_PART_SIZE = 2n * 1024n * 1024n * 1024n;

/**
 * Split a file into ≤2GB parts using byte-level splitting.
 * Returns paths to the split parts. If the file is already ≤2GB, returns the original path.
 */
export async function byteLevelSplit(filePath: string): Promise<string[]> {
  const stats = await stat(filePath);
  const fileSize = BigInt(stats.size);

  if (fileSize <= MAX_PART_SIZE) {
    return [filePath];
  }

  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const partSize = Number(MAX_PART_SIZE);
  const totalParts = Math.ceil(Number(fileSize) / partSize);
  const parts: string[] = [];

  log.info({ filePath, fileSize: Number(fileSize), totalParts }, "Splitting file");

  for (let i = 0; i < totalParts; i++) {
    const partNum = String(i + 1).padStart(3, "0");
    const partPath = path.join(dir, `${baseName}.${partNum}`);
    const start = i * partSize;
    const end = Math.min(start + partSize - 1, Number(fileSize) - 1);

    await pipeline(
      createReadStream(filePath, { start, end }),
      createWriteStream(partPath)
    );

    parts.push(partPath);
  }

  log.info({ filePath, parts: parts.length }, "File split complete");
  return parts;
}

/**
 * Concatenate multiple files into a single output file by streaming
 * each input sequentially. Used for repacking multipart archives
 * that have oversized parts (>2GB) before re-splitting.
 */
export async function concatenateFiles(
  inputPaths: string[],
  outputPath: string
): Promise<void> {
  const out = createWriteStream(outputPath);

  for (let i = 0; i < inputPaths.length; i++) {
    log.info(
      { part: i + 1, total: inputPaths.length, file: path.basename(inputPaths[i]) },
      "Concatenating part"
    );
    await pipeline(createReadStream(inputPaths[i]), out, { end: false });
  }

  // Close the output stream
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });

  const stats = await stat(outputPath);
  log.info(
    { outputPath, totalBytes: stats.size, parts: inputPaths.length },
    "Concatenation complete"
  );
}
