import yauzl from "yauzl";
import { open as fsOpen, stat as fsStat } from "fs/promises";
import path from "path";
import { Readable } from "stream";
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
 * For multipart ZIPs (.zip.001, .zip.002 etc.), uses a custom random-access
 * reader that spans all parts seamlessly so yauzl can find the central
 * directory at the end of the combined data.
 */
export async function readZipCentralDirectory(
  filePaths: string[]
): Promise<FileEntry[]> {
  if (filePaths.length === 1) {
    return readSingleZip(filePaths[0]);
  }

  // Multipart: use a spanning random-access reader
  return readMultipartZip(filePaths);
}

/** Read a single (non-split) ZIP file. */
function readSingleZip(targetFile: string): Promise<FileEntry[]> {
  return new Promise((resolve) => {
    yauzl.open(targetFile, { lazyEntries: true, autoClose: true }, (err, zipFile) => {
      if (err) {
        log.warn({ err, file: targetFile }, "Failed to open ZIP for reading");
        resolve([]);
        return;
      }

      const entries: FileEntry[] = [];

      zipFile.readEntry();
      zipFile.on("entry", (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith("/")) {
          const ext = path.extname(entry.fileName).toLowerCase();
          entries.push({
            path: entry.fileName,
            fileName: path.basename(entry.fileName),
            extension: ext ? ext.slice(1) : null,
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
        resolve(entries);
      });
    });
  });
}

/**
 * Read a multipart split ZIP using yauzl's RandomAccessReader API.
 * This creates a virtual "file" that spans all parts so yauzl can
 * seek freely across the entire archive to read the central directory.
 */
async function readMultipartZip(filePaths: string[]): Promise<FileEntry[]> {
  // Get sizes of all parts
  const partSizes: number[] = [];
  for (const fp of filePaths) {
    const s = await fsStat(fp);
    partSizes.push(s.size);
  }
  const totalSize = partSizes.reduce((a, b) => a + b, 0);

  log.debug(
    { parts: filePaths.length, totalSize },
    "Reading multipart ZIP via spanning reader"
  );

  return new Promise((resolve) => {
    const reader = createMultiPartReader(filePaths, partSizes);

    yauzl.fromRandomAccessReader(
      reader,
      totalSize,
      { lazyEntries: true, autoClose: true },
      (err, zipFile) => {
        if (err) {
          log.warn({ err }, "Failed to open multipart ZIP for reading");
          reader.close(() => {});
          resolve([]);
          return;
        }

        const entries: FileEntry[] = [];

        zipFile.readEntry();
        zipFile.on("entry", (entry: yauzl.Entry) => {
          if (!entry.fileName.endsWith("/")) {
            const ext = path.extname(entry.fileName).toLowerCase();
            entries.push({
              path: entry.fileName,
              fileName: path.basename(entry.fileName),
              extension: ext ? ext.slice(1) : null,
              compressedSize: BigInt(entry.compressedSize),
              uncompressedSize: BigInt(entry.uncompressedSize),
              crc32: entry.crc32 !== 0 ? entry.crc32.toString(16).padStart(8, "0") : null,
            });
          }
          zipFile.readEntry();
        });

        zipFile.on("end", () => {
          log.info({ entries: entries.length }, "Multipart ZIP entries read");
          resolve(entries);
        });
        zipFile.on("error", (error) => {
          log.warn({ error }, "Error reading multipart ZIP entries");
          resolve(entries);
        });
      }
    );
  });
}

/**
 * Create a yauzl RandomAccessReader that reads across multiple split part files.
 * Maps a global offset to the correct part file and local offset.
 *
 * Uses Object.create to properly inherit from yauzl.RandomAccessReader
 * (whose constructor + prototype is defined at runtime, not as a TS class).
 */
function createMultiPartReader(
  filePaths: string[],
  partSizes: number[]
): yauzl.RandomAccessReader {
  // Build cumulative offset table
  const partOffsets: number[] = [];
  let offset = 0;
  for (const size of partSizes) {
    partOffsets.push(offset);
    offset += size;
  }

  // Create an instance by calling the parent constructor
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reader = new (yauzl.RandomAccessReader as any)() as yauzl.RandomAccessReader;

  // Override _readStreamForRange — yauzl calls this to read a range of bytes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (reader as any)._readStreamForRange = function (start: number, end: number): Readable {
    const readable = new Readable({ read() {} });

    readRange(start, end, readable).catch((err) => {
      readable.destroy(err);
    });

    return readable;
  };

  async function readRange(start: number, end: number, readable: Readable): Promise<void> {
    let remaining = end - start;
    let globalOffset = start;

    while (remaining > 0) {
      // Find which part this offset falls in
      let partIdx = partOffsets.length - 1;
      for (let i = 0; i < partOffsets.length; i++) {
        if (i + 1 < partOffsets.length && globalOffset < partOffsets[i + 1]) {
          partIdx = i;
          break;
        }
      }

      const localOffset = globalOffset - partOffsets[partIdx];
      const partRemaining = partSizes[partIdx] - localOffset;
      const toRead = Math.min(remaining, partRemaining);

      const fh = await fsOpen(filePaths[partIdx], "r");
      try {
        const buf = Buffer.alloc(toRead);
        const { bytesRead } = await fh.read(buf, 0, toRead, localOffset);
        readable.push(buf.subarray(0, bytesRead));
        remaining -= bytesRead;
        globalOffset += bytesRead;
      } finally {
        await fh.close();
      }
    }

    readable.push(null); // Signal end of stream
  }

  return reader;
}
