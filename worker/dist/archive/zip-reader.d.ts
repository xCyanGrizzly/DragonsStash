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
export declare function readZipCentralDirectory(filePaths: string[]): Promise<FileEntry[]>;
