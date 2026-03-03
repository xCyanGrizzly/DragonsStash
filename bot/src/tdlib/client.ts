import tdl from "tdl";
import { getTdjson } from "prebuilt-tdlib";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";

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
    token: config.botToken,
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
 * Forward a message from a channel to a user's DM.
 * Uses copyMessage to make it appear as sent by the bot.
 */
export async function copyMessageToUser(
  fromChatId: bigint,
  messageId: bigint,
  toUserId: bigint
): Promise<void> {
  if (!client) throw new Error("Bot client not initialized");

  // TDLib uses negative chat IDs for channels/supergroups
  // The telegramId from the DB is the raw Telegram ID; for channels it needs -100 prefix
  const fromChatIdNum = Number(-100n * 1n) + Number(fromChatId);

  await client.invoke({
    _: "forwardMessages",
    chat_id: Number(toUserId),
    from_chat_id: Number(fromChatId) > 0 ? -Number(fromChatId) : Number(fromChatId),
    message_ids: [Number(messageId)],
    send_copy: true,
    remove_caption: false,
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

  // Parse the text first
  const parsed = await client.invoke({
    _: "parseTextEntities",
    text,
    parse_mode: { _: parseMode, version: parseMode === "textParseModeMarkdown" ? 2 : 0 },
  });

  await client.invoke({
    _: "sendMessage",
    chat_id: Number(chatId),
    input_message_content: {
      _: "inputMessageText",
      text: parsed,
    },
  });
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

  // Write the photo to a temp file
  const { writeFile, unlink } = await import("fs/promises");
  const path = await import("path");
  const tempPath = path.join(config.tdlibStateDir, `preview_${Date.now()}.jpg`);

  try {
    await writeFile(tempPath, photoData);

    const parsedCaption = await client.invoke({
      _: "parseTextEntities",
      text: caption,
      parse_mode: { _: "textParseModeMarkdown", version: 2 },
    });

    await client.invoke({
      _: "sendMessage",
      chat_id: Number(chatId),
      input_message_content: {
        _: "inputMessagePhoto",
        photo: { _: "inputFileLocal", path: tempPath },
        caption: parsedCaption,
        width: 0,
        height: 0,
      },
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
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
