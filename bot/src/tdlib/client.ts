import tdl from "tdl";
import { getTdjson } from "prebuilt-tdlib";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { withFloodWait } from "../util/flood-wait.js";

const log = childLogger("tdlib-bot");

tdl.configure({ tdjson: getTdjson() });

let client: tdl.Client | null = null;

/**
 * Create and authenticate a TDLib client using the bot token.
 * Bot accounts have different capabilities from user accounts —
 * they can't read channel history but can send/forward/copy messages
 * to users who have interacted with them.
 */
export async function createBotClient(): Promise<tdl.Client> {
  if (client) return client;

  log.info("Creating TDLib bot client");

  client = tdl.createClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    databaseDirectory: `${config.tdlibStateDir}/bot`,
    filesDirectory: `${config.tdlibStateDir}/bot_files`,
  });

  client.on("error", (err) => {
    log.error({ err }, "TDLib client error");
  });

  await client.login(() => ({
    type: "bot",
    getToken: () => Promise.resolve(config.botToken),
  }));

  log.info("Bot client authenticated successfully");
  return client;
}

export async function closeBotClient(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }
    client = null;
    log.info("Bot client closed");
  }
}

/**
 * Send a document from a channel to a user's DM.
 *
 * Instead of forwardMessages (unreliable for bot accounts with send_copy),
 * we fetch the original message to get the file's remote ID, then send a
 * new message with inputFileRemote. This is the documented reliable approach
 * for bots — the file is already on Telegram's servers so no re-upload is needed.
 *
 * Falls back to a plain forward (without send_copy) if getMessage fails.
 */
export async function copyMessageToUser(
  fromChatId: bigint,
  messageId: bigint,
  toUserId: bigint
): Promise<void> {
  if (!client) throw new Error("Bot client not initialized");
  const c = client;

  log.info(
    { fromChatId: fromChatId.toString(), messageId: messageId.toString(), toUserId: toUserId.toString() },
    "Sending file to user"
  );

  // Step 1: Get the original message to extract the file's remote ID
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let message: any;
  try {
    message = await withFloodWait(
      () => c.invoke({
        _: "getMessage",
        chat_id: Number(fromChatId),
        message_id: Number(messageId),
      }),
      "getMessage"
    );
  } catch (err) {
    log.error({ err, fromChatId: fromChatId.toString(), messageId: messageId.toString() }, "getMessage failed");
    throw new Error(`Cannot get source message: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: Extract the document's remote file ID
  const doc = message?.content?.document;
  if (!doc?.document?.remote?.id) {
    log.error(
      { messageContent: message?.content?._, messageId: messageId.toString() },
      "Source message has no document with remote file ID"
    );
    throw new Error(`Source message is not a document or has no remote file ID (type: ${message?.content?._})`);
  }

  const remoteFileId: string = doc.document.remote.id;
  const fileName: string = doc.file_name ?? "file";
  const caption = message.content?.caption;

  log.info(
    { remoteFileId: remoteFileId.slice(0, 20) + "...", fileName, toUserId: toUserId.toString() },
    "Sending document via inputFileRemote"
  );

  // Step 3: Send the document to the user using the remote file ID
  // This doesn't require downloading — Telegram serves the existing file.
  await waitForSendConfirmation(c, Number(toUserId), {
    _: "inputMessageDocument",
    document: { _: "inputFileRemote", id: remoteFileId },
    caption: caption ?? undefined,
  }, fileName);
}

/**
 * Send a message and wait for Telegram to confirm delivery.
 * Returns when updateMessageSendSucceeded fires for the temp message.
 * Throws if updateMessageSendFailed fires or timeout is reached.
 */
async function waitForSendConfirmation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  chatId: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputMessageContent: any,
  label: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let tempMsgId: number | null = null;

    const TIMEOUT_MS = 5 * 60_000;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Send timed out after 5min for ${label}`));
      }
    }, TIMEOUT_MS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleUpdate = (update: any) => {
      if (update?._ === "updateMessageSendSucceeded") {
        if (tempMsgId !== null && update.old_message_id === tempMsgId) {
          if (!settled) {
            settled = true;
            cleanup();
            log.info({ tempMsgId, finalMsgId: update.message?.id, label }, "Send confirmed");
            resolve();
          }
        }
      }
      if (update?._ === "updateMessageSendFailed") {
        if (tempMsgId !== null && update.old_message_id === tempMsgId) {
          if (!settled) {
            settled = true;
            cleanup();
            const errorMsg = update.error?.message ?? "Unknown";
            const errorCode = update.error?.code ?? 0;
            log.error({ tempMsgId, errorCode, errorMsg, label }, "Send failed");
            reject(new Error(`Send failed for ${label}: [${errorCode}] ${errorMsg}`));
          }
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      c.off("update", handleUpdate);
    };

    // Attach BEFORE sending to avoid race
    c.on("update", handleUpdate);

    withFloodWait(
      () => c.invoke({
        _: "sendMessage",
        chat_id: chatId,
        input_message_content: inputMessageContent,
      }),
      "sendMessage:copyToUser"
    )
      .then((result: { id: number }) => {
        tempMsgId = result.id;
        log.debug({ tempMsgId, label }, "Message queued, waiting for confirmation");
      })
      .catch((err: Error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
  });
}

/**
 * Send a text message to a user.
 */
export async function sendTextMessage(
  chatId: bigint,
  text: string,
  parseMode: "textParseModeMarkdown" | "textParseModeHTML" = "textParseModeMarkdown"
): Promise<void> {
  if (!client) throw new Error("Bot client not initialized");
  const c = client;

  // Parse the text first
  const parsed = await withFloodWait(
    () =>
      c.invoke({
        _: "parseTextEntities",
        text,
        parse_mode: { _: parseMode, version: parseMode === "textParseModeMarkdown" ? 2 : 0 },
      }),
    "parseTextEntities"
  );

  await withFloodWait(
    () =>
      c.invoke({
        _: "sendMessage",
        chat_id: Number(chatId),
        input_message_content: {
          _: "inputMessageText",
          text: parsed,
        },
      }),
    "sendTextMessage"
  );
}

/**
 * Send a photo with caption to a user (for preview images).
 */
export async function sendPhotoMessage(
  chatId: bigint,
  photoData: Buffer,
  caption: string
): Promise<void> {
  if (!client) throw new Error("Bot client not initialized");
  const c = client;

  // Write the photo to a temp file
  const { writeFile, unlink } = await import("fs/promises");
  const path = await import("path");
  const tempPath = path.join(config.tdlibStateDir, `preview_${Date.now()}.jpg`);

  try {
    await writeFile(tempPath, photoData);

    const parsedCaption = await withFloodWait(
      () =>
        c.invoke({
          _: "parseTextEntities",
          text: caption,
          parse_mode: { _: "textParseModeMarkdown", version: 2 },
        }),
      "parsePhotoCaption"
    );

    await withFloodWait(
      () =>
        c.invoke({
          _: "sendMessage",
          chat_id: Number(chatId),
          input_message_content: {
            _: "inputMessagePhoto",
            photo: { _: "inputFileLocal", path: tempPath },
            caption: parsedCaption,
            width: 0,
            height: 0,
          },
        }),
      "sendPhotoMessage"
    );
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * Get basic info about a Telegram user (name, username).
 */
export async function getUser(
  userId: number
): Promise<{ firstName: string; lastName?: string; username?: string }> {
  if (!client) throw new Error("Bot client not initialized");
  const c = client;
  const user = (await withFloodWait(
    () =>
      c.invoke({
        _: "getUser",
        user_id: userId,
      }),
    "getUser"
  )) as {
    first_name?: string;
    last_name?: string;
    usernames?: { editable_username?: string };
  };
  return {
    firstName: user.first_name ?? "User",
    lastName: user.last_name || undefined,
    username: user.usernames?.editable_username || undefined,
  };
}

/**
 * Get updates from TDLib. The bot listens for new messages this way.
 */
export function onBotUpdate(
  handler: (update: Record<string, unknown>) => void
): void {
  if (!client) throw new Error("Bot client not initialized");
  client.on("update", handler);
}
