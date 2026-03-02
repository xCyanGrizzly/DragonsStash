import { detectArchive, type ArchiveFormat, type MultipartInfo } from "./detect.js";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";

const log = childLogger("multipart");

export interface TelegramMessage {
  id: bigint;
  fileName: string;
  fileId: string;
  fileSize: bigint;
  date: Date;
}

export interface ArchiveSet {
  type: ArchiveFormat;
  baseName: string;
  parts: TelegramMessage[];
  isMultipart: boolean;
}

/**
 * Group messages into archive sets (single files + multipart groups).
 * Messages should be pre-filtered to only include archive attachments.
 */
export function groupArchiveSets(messages: TelegramMessage[]): ArchiveSet[] {
  // Detect and annotate each message
  const annotated: { msg: TelegramMessage; info: MultipartInfo }[] = [];
  for (const msg of messages) {
    const info = detectArchive(msg.fileName);
    if (info) {
      annotated.push({ msg, info });
    }
  }

  // Group by baseName + format
  const groups = new Map<string, { msg: TelegramMessage; info: MultipartInfo }[]>();
  for (const item of annotated) {
    const key = `${item.info.format}:${item.info.baseName.toLowerCase()}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const results: ArchiveSet[] = [];

  for (const [, group] of groups) {
    const format = group[0].info.format;
    const baseName = group[0].info.baseName;

    // Separate explicit multipart entries from potential singles
    const multipartEntries = group.filter((g) => g.info.pattern !== "SINGLE");
    const singleEntries = group.filter((g) => g.info.pattern === "SINGLE");

    if (multipartEntries.length > 0) {
      // This is a multipart set
      // Check if any single entry is the "final part" of a legacy split
      const allEntries = [...multipartEntries, ...singleEntries];

      // Check time span — skip if parts span too long (0 = no limit)
      if (config.multipartTimeoutHours > 0) {
        const dates = allEntries.map((e) => e.msg.date.getTime());
        const span = Math.max(...dates) - Math.min(...dates);
        const maxSpanMs = config.multipartTimeoutHours * 60 * 60 * 1000;

        if (span > maxSpanMs) {
          log.warn(
            { baseName, format, span: span / 3600000 },
            "Multipart set spans too long, skipping"
          );
          continue;
        }
      }

      // Sort by part number (singles get a very high number so they come last — they're the final part)
      allEntries.sort((a, b) => {
        const aNum = a.info.partNumber === -1 ? 999999 : a.info.partNumber;
        const bNum = b.info.partNumber === -1 ? 999999 : b.info.partNumber;
        return aNum - bNum;
      });

      results.push({
        type: format,
        baseName,
        parts: allEntries.map((e) => e.msg),
        isMultipart: true,
      });
    } else {
      // All entries are singles — each is its own archive set
      for (const entry of singleEntries) {
        results.push({
          type: format,
          baseName: entry.info.baseName,
          parts: [entry.msg],
          isMultipart: false,
        });
      }
    }
  }

  return results;
}
