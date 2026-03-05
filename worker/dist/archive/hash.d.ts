/**
 * Compute SHA-256 hash of one or more files by streaming them in order.
 * Memory usage: O(1) — reads in 64KB chunks regardless of total size.
 * For multipart archives, pass all parts sorted by part number.
 */
export declare function hashParts(filePaths: string[]): Promise<string>;
