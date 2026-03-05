import { type ArchiveFormat } from "./detect.js";
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
export declare function groupArchiveSets(messages: TelegramMessage[]): ArchiveSet[];
