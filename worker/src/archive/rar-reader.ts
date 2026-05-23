import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { childLogger } from "../util/logger.js";
import type { FileEntry } from "./zip-reader.js";

const execFileAsync = promisify(execFile);
const log = childLogger("rar-reader");

/**
 * Parse output of `unrar lt <file>` to extract file metadata.
 *
 * `lt` (list technical) emits one block per archived file with key:value
 * lines — far more reliable than the column-based default `l -v` output,
 * which has changed format twice across unrar versions.
 *
 * unrar automatically discovers sibling multipart files when they're
 * co-located (e.g. *.part1.rar + *.part2.rar in the same directory).
 *
 * Returns [] on any failure (best-effort: ingestion still succeeds with
 * an empty file list rather than failing the whole archive).
 */
export async function readRarContents(
  firstPartPath: string
): Promise<FileEntry[]> {
  try {
    const { stdout } = await execFileAsync("unrar", ["lt", firstPartPath], {
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024, // 50MB for archives with very many files
    });

    const entries = parseUnrarTechnical(stdout);
    if (entries.length === 0) {
      // Log a sample of the output so we can diagnose format changes
      log.warn(
        { file: firstPartPath, sample: stdout.slice(0, 500) },
        "unrar lt returned no parseable entries"
      );
    }
    return entries;
  } catch (err) {
    log.warn({ err, file: firstPartPath }, "Failed to read RAR contents");
    return [];
  }
}

/**
 * Parse `unrar lt` output: header followed by per-file key:value blocks
 * separated by blank lines.
 *
 * Example block:
 *
 *         Name: folder/file.stl
 *         Type: File
 *         Size: 12345
 *  Packed size: 10234
 *        Ratio: 83%
 *        mtime: 2024-01-15 10:30:00,000000000
 *   Attributes: ..A....
 *        CRC32: DEADBEEF
 *      Host OS: Windows
 *  Compression: RAR 5.0(v50) -m3 -md=32M
 */
function parseUnrarTechnical(output: string): FileEntry[] {
  const entries: FileEntry[] = [];
  // Split into blocks on blank lines, then on each block read key:value pairs.
  const blocks = output.split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    const fields = parseBlock(block);
    if (!fields) continue;

    // Only File entries (skip Directory, and anything missing the basics)
    if (fields.type && fields.type.toLowerCase() !== "file") continue;
    if (!fields.name || fields.size === undefined) continue;

    const filePath = fields.name;
    const ext = path.extname(filePath).toLowerCase();
    entries.push({
      path: filePath,
      fileName: path.basename(filePath),
      extension: ext ? ext.slice(1) : null,
      uncompressedSize: BigInt(fields.size),
      compressedSize: fields.packedSize !== undefined
        ? BigInt(fields.packedSize)
        : BigInt(fields.size),
      crc32: fields.crc32 ? fields.crc32.toLowerCase() : null,
    });
  }

  return entries;
}

interface BlockFields {
  name?: string;
  type?: string;
  size?: string;
  packedSize?: string;
  crc32?: string;
}

function parseBlock(block: string): BlockFields | null {
  // Skip the archive-header block (contains "Archive:" / "Details:" lines
  // and lacks a Name field).
  if (!/^\s*Name:/m.test(block)) return null;

  const fields: BlockFields = {};
  const lines = block.split(/\r?\n/);

  for (const line of lines) {
    // Match "  key: value" with arbitrary leading whitespace and a multi-word
    // key (e.g. "Packed size", "Host OS").
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 ]*?)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === "name") fields.name = value;
    else if (key === "type") fields.type = value;
    else if (key === "size") fields.size = value;
    else if (key === "packed size") fields.packedSize = value;
    else if (key === "crc32" || key === "blake2sp" || key === "checksum") {
      // unrar may report BLAKE2sp for newer archives instead of CRC32.
      // Either way we just store it as a hex string in our crc32 field.
      fields.crc32 = value;
    }
  }

  return fields;
}
