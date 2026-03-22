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

  // Load chat list so TDLib knows about channels the bot has access to.
  // Without this, forwardMessages/copyMessage will fail with "Chat not found".
  try {
    await client.invoke({
      _: "getChats",
      chat_list: { _: "chatListMain" },
      limit: 200,
    });
    log.info("Chat list loaded");
  } catch (err) {
    log.warn({ err }, "Failed to load chat list — forwarding may fail");
  }

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
 * Copy a message from a channel to a user's DM.
 * Uses forwardMessages with send_copy so it appears sent by the bot.
 *
 * The fromChatId is the Telegram chat ID from the DB (e.g. -1003767441152).
 * The messageId is the TDLib message ID stored in the DB.
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
    "Copying message to user"
  );

  // First, ensure TDLib knows about the source chat by opening it
  try {
    await c.invoke({ _: "getChat", chat_id: Number(fromChatId) });
  } catch (err) {
    log.warn({ err, chatId: fromChatId.toString() }, "getChat failed for source channel");
  }

  const result = await withFloodWait(
    () =>
      c.invoke({
        _: "forwardMessages",
        chat_id: Number(toUserId),
        from_chat_id: Number(fromChatId),
        message_ids: [Number(messageId)],
        send_copy: true,
        remove_caption: false,
      }),
    "copyMessageToUser"
  );

  // forwardMessages returns immediately with temp messages — check result
  const messages = (result as { messages?: unknown[] })?.messages;
  log.info(
    { messageCount: messages?.length ?? 0, result: JSON.stringify(result).slice(0, 500) },
    "forwardMessages result"
  );
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
