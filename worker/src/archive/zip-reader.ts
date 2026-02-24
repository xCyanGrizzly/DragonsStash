import yauzl from "yauzl";
import path from "path";
import { childLogger } from "../util/logger.js";

const log = childLogger("zip-reader");

export interface FileEntry {
  path: string;
  fileName: string;
  extension: string | null;
  compressedSize: bigint;
  uncompressedSize: bigint;
  crc32: string | null;
}

/**
 * Read the central directory of a ZIP file without extracting any contents.
 * For multipart ZIPs, pass the paths sorted by part order.
 * We attempt to read from the last part first (central directory is at the end).
 */
export async function readZipCentralDirectory(
  filePaths: string[]
): Promise<FileEntry[]> {
  // The central directory lives at the end of the last file
  const targetFile = filePaths[filePaths.length - 1];

  return new Promise((resolve, reject) => {
    yauzl.open(targetFile, { lazyEntries: true, autoClose: true }, (err, zipFile) => {
      if (err) {
        log.warn({ err, file: targetFile }, "Failed to open ZIP for reading");
        resolve([]); // Fallback: return empty on error
        return;
      }

      const entries: FileEntry[] = [];

      zipFile.readEntry();
      zipFile.on("entry", (entry: yauzl.Entry) => {
        // Skip directories
        if (!entry.fileName.endsWith("/")) {
          const ext = path.extname(entry.fileName).toLowerCase();
          entries.push({
            path: entry.fileName,
            fileName: path.basename(entry.fileName),
            extension: ext ? ext.slice(1) : null, // Remove leading dot
            compressedSize: BigInt(entry.compressedSize),
            uncompressedSize: BigInt(entry.uncompressedSize),
            crc32: entry.crc32 !== 0 ? entry.crc32.toString(16).padStart(8, "0") : null,
          });
        }
        zipFile.readEntry();
      });

      zipFile.on("end", () => resolve(entries));
      zipFile.on("error", (error) => {
        log.warn({ error, file: targetFile }, "Error reading ZIP entries");
        resolve(entries); // Return whatever we got
      });
    });
  });
}
