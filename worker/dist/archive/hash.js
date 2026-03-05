import { createReadStream } from "fs";
import { createHash } from "crypto";
import { pipeline } from "stream/promises";
import { PassThrough } from "stream";
/**
 * Compute SHA-256 hash of one or more files by streaming them in order.
 * Memory usage: O(1) — reads in 64KB chunks regardless of total size.
 * For multipart archives, pass all parts sorted by part number.
 */
export async function hashParts(filePaths) {
    const hash = createHash("sha256");
    for (const filePath of filePaths) {
        await pipeline(createReadStream(filePath), new PassThrough({
            transform(chunk, _encoding, callback) {
                hash.update(chunk);
                callback();
            },
        }));
    }
    return hash.digest("hex");
}
//# sourceMappingURL=hash.js.map