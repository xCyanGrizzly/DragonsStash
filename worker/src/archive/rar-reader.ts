import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { childLogger } from "../util/logger.js";
import type { FileEntry } from "./zip-reader.js";

const execFileAsync = promisify(execFile);
const log = childLogger("rar-reader");

/**
 * Parse output of `unrar l -v <file>` to extract file metadata.
 * unrar automatically discovers sibling parts when they're co-located.
 */
export async function readRarContents(
  firstPartPath: string
): Promise<FileEntry[]> {
  try {
    const { stdout } = await execFileAsync("unrar", ["l", "-v", firstPartPath], {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB for very large archives
    });

    return parseUnrarOutput(stdout);
  } catch (err) {
    log.warn({ err, file: firstPartPath }, "Failed to read RAR contents");
    return []; // Fallback: return empty on error
  }
}

/**
 * Parse the tabular output of `unrar l -v`.
 *
 * Example output format:
 *  Archive: test.rar
 *  Details: RAR 5
 *
 *   Attributes      Size     Packed Ratio   Date   Time   CRC-32  Name
 *  ----------- ---------  --------- ----- -------- ----- --------  ----
 *   ...A....      12345      10234  83%  2024-01-15 10:30 DEADBEEF  folder/file.stl
 *  ----------- ---------  --------- ----- -------- ----- --------  ----
 */
function parseUnrarOutput(output: string): FileEntry[] {
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

    // Parse file entry line
    // Format: Attributes Size Packed Ratio Date Time CRC Name
    const match = trimmed.match(
      /^\S+\s+(\d+)\s+(\d+)\s+\d+%\s+\S+\s+\S+\s+([0-9A-Fa-f]+)\s+(.+)$/
    );

    if (match) {
      const [, uncompressedStr, compressedStr, crc32, filePath] = match;

      // Skip directory entries (typically end with / or have size 0 with dir attributes)
      if (filePath.endsWith("/") || filePath.endsWith("\\")) continue;

      const ext = path.extname(filePath).toLowerCase();
      entries.push({
        path: filePath,
        fileName: path.basename(filePath),
        extension: ext ? ext.slice(1) : null,
        compressedSize: BigInt(compressedStr),
        uncompressedSize: BigInt(uncompressedStr),
        crc32: crc32.toLowerCase(),
      });
    }
  }

  return entries;
}
