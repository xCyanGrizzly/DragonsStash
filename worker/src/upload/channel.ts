import path from "path";
import { stat } from "fs/promises";
import type { Client } from "tdl";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";

const log = childLogger("upload");

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
export async function uploadToChannel(
  client: Client,
  chatId: bigint,
  filePaths: string[],
  caption?: string
): Promise<UploadResult> {
  let firstMessageId: bigint | null = null;

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const fileCaption =
      i === 0 && caption ? caption : undefined;

    const fileName = path.basename(filePath);
    let fileSizeMB = 0;
    try {
      const s = await stat(filePath);
      fileSizeMB = Math.round(s.size / (1024 * 1024));
    } catch {
      // Non-critical
    }

    log.info(
      { chatId: Number(chatId), fileName, sizeMB: fileSizeMB, part: i + 1, total: filePaths.length },
      "Uploading file to channel"
    );

    const serverMsgId = await sendAndWaitForUpload(client, chatId, filePath, fileCaption, fileName, fileSizeMB);

    if (i === 0) {
      firstMessageId = serverMsgId;
    }

    // Rate limit delay between uploads
    if (i < filePaths.length - 1) {
      await sleep(config.apiDelayMs);
    }
  }

  if (firstMessageId === null) {
    throw new Error("Upload failed: no messages sent");
  }

  log.info(
    { chatId: Number(chatId), messageId: Number(firstMessageId), files: filePaths.length },
    "All uploads confirmed by Telegram"
  );

  return { messageId: firstMessageId };
}

/**
 * Send a single file message and wait for Telegram to confirm the upload.
 * Returns the final server-assigned message ID.
 */
async function sendAndWaitForUpload(
  client: Client,
  chatId: bigint,
  filePath: string,
  caption: string | undefined,
  fileName: string,
  fileSizeMB: number
): Promise<bigint> {
  // Send the message — this returns a temporary message immediately
  const tempMsg = (await client.invoke({
    _: "sendMessage",
    chat_id: Number(chatId),
    input_message_content: {
      _: "inputMessageDocument",
      document: {
        _: "inputFileLocal",
        path: filePath,
      },
      caption: caption
        ? {
            _: "formattedText",
            text: caption,
          }
        : undefined,
    },
  })) as { id: number };

  const tempMsgId = tempMsg.id;

  log.debug(
    { fileName, tempMsgId },
    "Message queued, waiting for upload confirmation"
  );

  // Wait for the actual upload to complete
  return new Promise<bigint>((resolve, reject) => {
    let settled = false;
    let lastLoggedPercent = 0;

    // Timeout: 10 minutes per GB, minimum 10 minutes
    const timeoutMs = Math.max(
      10 * 60_000,
      (fileSizeMB / 1024) * 10 * 60_000
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Upload timed out after ${Math.round(timeoutMs / 60_000)}min for ${fileName}`
          )
        );
      }
    }, timeoutMs);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleUpdate = (update: any) => {
      // Track upload progress via updateFile events
      if (update?._ === "updateFile") {
        const file = update.file;
        if (file?.remote?.is_uploading_active && file.expected_size > 0) {
          const uploaded = file.remote.uploaded_size ?? 0;
          const total = file.expected_size;
          const percent = Math.round((uploaded / total) * 100);
          if (percent >= lastLoggedPercent + 20) {
            lastLoggedPercent = percent - (percent % 20);
            log.info(
              { fileName, uploaded, total, percent: `${percent}%` },
              "Upload progress"
            );
          }
        }
      }

      // The money event: upload succeeded, we get the final server message ID
      if (update?._ === "updateMessageSendSucceeded") {
        const msg = update.message;
        const oldMsgId = update.old_message_id;
        if (oldMsgId === tempMsgId) {
          if (!settled) {
            settled = true;
            cleanup();
            const finalId = BigInt(msg.id);
            log.info(
              { fileName, tempMsgId, finalMsgId: Number(finalId) },
              "Upload confirmed by Telegram"
            );
            resolve(finalId);
          }
        }
      }

      // Upload failed
      if (update?._ === "updateMessageSendFailed") {
        const oldMsgId = update.old_message_id;
        if (oldMsgId === tempMsgId) {
          if (!settled) {
            settled = true;
            cleanup();
            const errorMsg = update.error?.message ?? "Unknown upload error";
            reject(new Error(`Upload failed for ${fileName}: ${errorMsg}`));
          }
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      client.off("update", handleUpdate);
    };

    client.on("update", handleUpdate);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
