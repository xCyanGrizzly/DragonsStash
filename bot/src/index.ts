import { config } from "./util/config.js";
import { logger } from "./util/logger.js";
import { db, pool } from "./db/client.js";
import { createBotClient, closeBotClient, onBotUpdate, getUser } from "./tdlib/client.js";
import { startSendListener, stopSendListener } from "./send-listener.js";
import { handleMessage } from "./commands.js";
import { mkdir } from "fs/promises";

const log = logger.child({ module: "main" });

async function main(): Promise<void> {
  log.info("DragonsStash Telegram Bot starting");

  if (!config.botToken) {
    log.fatal("BOT_TOKEN environment variable is required");
    process.exit(1);
  }

  if (!config.telegramApiId || !config.telegramApiHash) {
    log.fatal("TELEGRAM_API_ID and TELEGRAM_API_HASH are required");
    process.exit(1);
  }

  // Ensure TDLib state directory exists
  await mkdir(config.tdlibStateDir, { recursive: true });
  await mkdir(`${config.tdlibStateDir}/bot`, { recursive: true });
  await mkdir(`${config.tdlibStateDir}/bot_files`, { recursive: true });

  // Initialize TDLib bot client
  await createBotClient();

  // Start pg_notify listener for send requests and new package notifications
  await startSendListener();

  // Listen for incoming messages from Telegram users
  onBotUpdate((update) => {
    if (update._ === "updateNewMessage") {
      const message = update.message as Record<string, unknown>;
      const content = message.content as Record<string, unknown>;
      const chatId = message.chat_id as number;
      const senderId = message.sender_id as Record<string, unknown> | undefined;

      // Only handle text messages from users (not channels or service messages)
      if (
        content?._ === "messageText" &&
        senderId?._ === "messageSenderUser"
      ) {
        const text = (content.text as Record<string, unknown>)?.text as string;
        const userId = senderId.user_id as number;

        if (text && userId) {
          (async () => {
            let firstName = "User";
            let lastName: string | undefined;
            let username: string | undefined;
            try {
              const userInfo = await getUser(userId);
              firstName = userInfo.firstName;
              lastName = userInfo.lastName;
              username = userInfo.username;
            } catch {
              // Fall back to defaults if getUser fails
            }
            await handleMessage({
              chatId: BigInt(chatId),
              userId: BigInt(userId),
              text,
              firstName,
              lastName,
              username,
            });
          })().catch((err) => {
            log.error({ err, chatId, userId }, "Failed to handle message");
          });
        }
      }
    }
  });

  log.info("Bot is running and listening for messages");
}

// Graceful shutdown
function shutdown(signal: string): void {
  log.info({ signal }, "Shutdown signal received");
  stopSendListener();

  Promise.all([closeBotClient(), db.$disconnect(), pool.end()])
    .then(() => {
      log.info("Shutdown complete");
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err }, "Error during shutdown");
      process.exit(1);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
  log.fatal({ err }, "Bot failed to start");
  process.exit(1);
});
