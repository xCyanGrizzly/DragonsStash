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
 * Returns the message ID of the first uploaded message.
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

    log.debug(
      { chatId: Number(chatId), filePath, part: i + 1, total: filePaths.length },
      "Uploading file to channel"
    );

    const result = (await client.invoke({
      _: "sendMessage",
      chat_id: Number(chatId),
      input_message_content: {
        _: "inputMessageDocument",
        document: {
          _: "inputFileLocal",
          path: filePath,
        },
        caption: fileCaption
          ? {
              _: "formattedText",
              text: fileCaption,
            }
          : undefined,
      },
    })) as { id: number };

    if (i === 0) {
      firstMessageId = BigInt(result.id);
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
    "Upload complete"
  );

  return { messageId: firstMessageId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
