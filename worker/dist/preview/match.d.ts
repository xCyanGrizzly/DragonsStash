export interface TelegramPhoto {
    id: bigint;
    date: Date;
    /** Caption text on the photo message (if any). */
    caption: string;
    /** The smallest photo size available — used as thumbnail. */
    fileId: string;
    fileSize: number;
}
export interface ArchiveRef {
    baseName: string;
    firstMessageId: bigint;
    firstMessageDate: Date;
}
/**
 * Try to match a photo message to an archive by:
 * 1. Caption contains the archive baseName (without extension)
 * 2. Photo was posted within ±10 messages (time-window: ±6 hours)
 *
 * Returns the best match (closest in time), or null.
 */
export declare function matchPreviewToArchive(photos: TelegramPhoto[], archives: ArchiveRef[]): Map<string, TelegramPhoto>;
