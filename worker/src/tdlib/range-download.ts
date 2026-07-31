import { open } from "fs/promises";
import type { Client } from "tdl";
import { childLogger } from "../util/logger.js";
import { withFloodWait } from "../util/retry.js";

const log = childLogger("range-download");
const RANGE_TIMEOUT_MS = 120_000;

// NOTE (from Task 4 spike): TDLib writes the requested region into
// file.local.path at its ABSOLUTE file offset; file.local.downloaded_prefix_size
// counts contiguous bytes from download_offset. We request a 1KB-aligned offset
// so downloaded_prefix_size covers our whole [offset, offset+limit) window.
// This absolute-offset assumption is PENDING LIVE VERIFICATION ON DEPLOY —
// the authenticated TDLib session could not be spiked in this environment.
export async function downloadFileRange(
  client: Client,
  fileId: string,
  offset: number,
  limit: number,
  expectedSize: bigint,
): Promise<Buffer> {
  const numericId = parseInt(fileId, 10);
  const alignedOffset = Math.max(0, offset - (offset % 1024));
  const alignedLimit = limit + (offset - alignedOffset);

  const file = await withFloodWait(
    () =>
      new Promise<{ local: { path: string; download_offset: number; downloaded_prefix_size: number } }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Range download timed out for ${fileId}`)), RANGE_TIMEOUT_MS);
          client
            .invoke({
              _: "downloadFile",
              file_id: numericId,
              priority: 1,
              offset: alignedOffset,
              limit: alignedLimit,
              synchronous: true,
            } as never)
            .then((f) => { clearTimeout(timer); resolve(f as never); })
            .catch((e) => { clearTimeout(timer); reject(e); });
        },
      ),
    `downloadFileRange:${fileId}`,
  );

  const start = offset;
  const fh = await open(file.local.path, "r");
  try {
    const buf = Buffer.alloc(limit);
    const { bytesRead } = await fh.read(buf, 0, limit, start);
    log.debug({ fileId, offset, limit, bytesRead }, "range read");
    return bytesRead < limit ? buf.subarray(0, bytesRead) : buf;
  } finally {
    await fh.close();
  }
}
