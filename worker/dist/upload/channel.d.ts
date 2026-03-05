import type { Client } from "tdl";
export interface UploadResult {
    messageId: bigint;
}
/**
 * Upload one or more files to a destination Telegram channel.
 * For multipart archives, each file is sent as a separate message.
 * Returns the **final** (server-assigned) message ID of the first uploaded message.
 *
 * IMPORTANT: `sendMessage` returns a *temporary* message immediately.
 * The actual file upload happens asynchronously in TDLib. We listen for
 * `updateMessageSendSucceeded` to get the real server-side message ID and
 * to make sure the upload is fully committed before we clean up temp files
 * or close the TDLib client (which would cancel pending uploads).
 */
export declare function uploadToChannel(client: Client, chatId: bigint, filePaths: string[], caption?: string): Promise<UploadResult>;
