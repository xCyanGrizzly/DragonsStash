/**
 * Split a file into ≤2GB parts using byte-level splitting.
 * Returns paths to the split parts. If the file is already ≤2GB, returns the original path.
 */
export declare function byteLevelSplit(filePath: string): Promise<string[]>;
/**
 * Concatenate multiple files into a single output file by streaming
 * each input sequentially. Used for repacking multipart archives
 * that have oversized parts (>2GB) before re-splitting.
 */
export declare function concatenateFiles(inputPaths: string[], outputPath: string): Promise<void>;
