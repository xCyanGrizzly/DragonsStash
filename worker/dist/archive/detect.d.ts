export type ArchiveFormat = "ZIP" | "RAR";
export interface MultipartInfo {
    baseName: string;
    partNumber: number;
    format: ArchiveFormat;
    pattern: "ZIP_NUMBERED" | "ZIP_LEGACY" | "RAR_PART" | "RAR_LEGACY" | "SINGLE";
}
/**
 * Detect if a filename is an archive and extract multipart info.
 */
export declare function detectArchive(fileName: string): MultipartInfo | null;
/**
 * Check if a filename looks like any archive attachment we should process.
 */
export declare function isArchiveAttachment(fileName: string): boolean;
