import type { FileEntry } from "./zip-reader.js";
/**
 * Parse output of `unrar l -v <file>` to extract file metadata.
 * unrar automatically discovers sibling parts when they're co-located.
 */
export declare function readRarContents(firstPartPath: string): Promise<FileEntry[]>;
