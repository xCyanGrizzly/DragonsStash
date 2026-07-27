import type { Client } from "tdl";
import { downloadFileRange } from "../../tdlib/range-download.js";

export type RangeReader = (
  fileId: string,
  offset: number,
  length: number,
  partSize: bigint,
) => Promise<Buffer>;

export function tdlibRangeReader(client: Client): RangeReader {
  return (fileId, offset, length, partSize) =>
    downloadFileRange(client, fileId, offset, length, partSize);
}
