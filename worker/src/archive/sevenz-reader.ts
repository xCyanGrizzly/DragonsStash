import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { childLogger } from "../util/logger.js";
import type { FileEntry } from "./zip-reader.js";

const execFileAsync = promisify(execFile);
const log = childLogger("7z-reader");

/**
 * Parse output of `7z l <file>` to extract file metadata.
 *
 * Example output:
 *    Date      Time    Attr         Size   Compressed  Name
 *   ------------------- ----- ------------ ------------  ------------------------
 *   2024-01-15 10:30:00 ....A        12345        10234  folder/file.stl
 *   ------------------- ----- ------------ ------------  ------------------------
 */
export async function read7zContents(
  filePath: string
): Promise<FileEntry[]> {
  try {
    const { stdout } = await execFileAsync("7z", ["l", filePath], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });

    return parse7zOutput(stdout);
  } catch (err) {
    log.warn({ err, file: filePath }, "Failed to read 7z contents");
    return [];
  }
}

function parse7zOutput(output: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const lines = output.split("\n");

  let inFileList = false;
  let separatorCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect separator lines (------- pattern)
    if (/^-{5,}/.test(trimmed)) {
      separatorCount++;
      if (separatorCount === 1) {
        inFileList = true;
      } else if (separatorCount >= 2) {
        inFileList = false;
      }
      continue;
    }

    if (!inFileList) continue;

    // Parse: Date Time Attr Size Compressed Name
    // 2024-01-15 10:30:00 ....A        12345        10234  folder/file.stl
    const match = trimmed.match(
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+(\d+)\s+(\d+)\s+(.+)$/
    );

    if (match) {
      const [, uncompressedStr, compressedStr, filePath] = match;

      // Skip directory entries
      if (filePath.endsWith("/") || filePath.endsWith("\\")) continue;
      // Skip entries with 0 size (typically directories without trailing slash)
      if (uncompressedStr === "0" && compressedStr === "0") continue;

      const ext = path.extname(filePath).toLowerCase();
      entries.push({
        path: filePath,
        fileName: path.basename(filePath),
        extension: ext ? ext.slice(1) : null,
        compressedSize: BigInt(compressedStr),
        uncompressedSize: BigInt(uncompressedStr),
        crc32: null,
      });
    }
  }

  return entries;
}
