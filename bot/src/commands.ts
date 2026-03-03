import { childLogger } from "./util/logger.js";
import {
  searchPackages,
  getLatestPackages,
  getPackageById,
  findLinkByTelegramUserId,
  validateLinkCode,
  deleteLinkCode,
  createTelegramLink,
  getSubscriptions,
  addSubscription,
  removeSubscription,
} from "./db/queries.js";
import { sendTextMessage, sendPhotoMessage } from "./tdlib/client.js";

const log = childLogger("commands");

interface IncomingMessage {
  chatId: bigint;
  userId: bigint;
  text: string;
  firstName: string;
  lastName?: string;
  username?: string;
}

function formatSize(bytes: bigint): string {
  const mb = Number(bytes) / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function handleMessage(msg: IncomingMessage): Promise<void> {
  const { chatId, userId, text } = msg;

  // Parse command and args
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const command = (spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed).toLowerCase();
  const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

  try {
    switch (command) {
      case "/start":
        await handleStart(chatId, userId, args, msg);
        break;
      case "/help":
        await handleHelp(chatId);
        break;
      case "/search":
        await handleSearch(chatId, args);
        break;
      case "/latest":
        await handleLatest(chatId, args);
        break;
      case "/package":
        await handlePackage(chatId, args);
        break;
      case "/link":
        await handleLink(chatId, userId, args, msg);
        break;
      case "/unlink":
        await handleUnlink(chatId, userId);
        break;
      case "/subscribe":
        await handleSubscribe(chatId, userId, args);
        break;
      case "/unsubscribe":
        await handleUnsubscribe(chatId, userId, args);
        break;
      case "/subscriptions":
        await handleListSubscriptions(chatId, userId);
        break;
      case "/status":
        await handleStatus(chatId, userId);
        break;
      default:
        await sendTextMessage(
          chatId,
          "Unknown command. Use /help to see available commands.",
          "textParseModeHTML"
        );
    }
  } catch (err) {
    log.error({ err, command, userId: userId.toString() }, "Command handler error");
    await sendTextMessage(
      chatId,
      "An error occurred processing your command. Please try again.",
      "textParseModeHTML"
    ).catch(() => {});
  }
}

async function handleStart(
  chatId: bigint,
  userId: bigint,
  args: string,
  msg: IncomingMessage
): Promise<void> {
  // Deep link: /start link_<code>
  if (args.startsWith("link_")) {
    const code = args.slice(5);
    await handleLink(chatId, userId, code, msg);
    return;
  }

  const welcome = [
    `🐉 <b>Dragon's Stash Bot</b>`,
    ``,
    `I can help you search and receive indexed archive packages.`,
    ``,
    `<b>Commands:</b>`,
    `/search &lt;query&gt; — Search packages`,
    `/latest [n] — Show latest packages`,
    `/package &lt;id&gt; — Package details`,
    `/link &lt;code&gt; — Link your Telegram to your web account`,
    `/subscribe &lt;keyword&gt; — Get notified for new packages`,
    `/subscriptions — View your subscriptions`,
    `/unsubscribe &lt;keyword&gt; — Remove a subscription`,
    `/status — Check your link status`,
    `/help — Show this help message`,
  ].join("\n");

  await sendTextMessage(chatId, welcome, "textParseModeHTML");
}

async function handleHelp(chatId: bigint): Promise<void> {
  const help = [
    `<b>Available Commands:</b>`,
    ``,
    `🔍 <b>Search &amp; Browse</b>`,
    `/search &lt;query&gt; — Search by filename or creator`,
    `/latest [n] — Show n most recent packages (default: 5)`,
    `/package &lt;id&gt; — View package details and file list`,
    ``,
    `🔗 <b>Account Linking</b>`,
    `/link &lt;code&gt; — Link Telegram to your web account`,
    `/unlink — Unlink your Telegram account`,
    `/status — Check link status`,
    ``,
    `🔔 <b>Notifications</b>`,
    `/subscribe &lt;keyword&gt; — Get alerts for matching packages`,
    `/unsubscribe &lt;keyword&gt; — Remove a subscription`,
    `/subscriptions — List your subscriptions`,
  ].join("\n");

  await sendTextMessage(chatId, help, "textParseModeHTML");
}

async function handleSearch(chatId: bigint, query: string): Promise<void> {
  if (!query) {
    await sendTextMessage(chatId, "Usage: /search &lt;query&gt;", "textParseModeHTML");
    return;
  }

  const results = await searchPackages(query, 10);

  if (results.length === 0) {
    await sendTextMessage(
      chatId,
      `No packages found for "<b>${escapeHtml(query)}</b>".`,
      "textParseModeHTML"
    );
    return;
  }

  const lines = results.map((pkg, i) => {
    const creator = pkg.creator ? ` by ${pkg.creator}` : "";
    return `${i + 1}. <b>${escapeHtml(pkg.fileName)}</b>${creator}\n   📦 ${pkg.fileCount} files · ${formatSize(pkg.fileSize)} · ${formatDate(pkg.indexedAt)}\n   ID: <code>${pkg.id}</code>`;
  });

  const response = [
    `🔍 <b>Search results for "${escapeHtml(query)}":</b>`,
    ``,
    ...lines,
    ``,
    `Use /package &lt;id&gt; for details.`,
  ].join("\n");

  await sendTextMessage(chatId, response, "textParseModeHTML");
}

async function handleLatest(chatId: bigint, args: string): Promise<void> {
  const limit = Math.min(Math.max(parseInt(args) || 5, 1), 20);
  const results = await getLatestPackages(limit);

  if (results.length === 0) {
    await sendTextMessage(chatId, "No packages indexed yet.", "textParseModeHTML");
    return;
  }

  const lines = results.map((pkg, i) => {
    const creator = pkg.creator ? ` by ${pkg.creator}` : "";
    return `${i + 1}. <b>${escapeHtml(pkg.fileName)}</b>${creator}\n   📦 ${pkg.fileCount} files · ${formatSize(pkg.fileSize)} · ${formatDate(pkg.indexedAt)}\n   ID: <code>${pkg.id}</code>`;
  });

  const response = [
    `📋 <b>Latest ${results.length} packages:</b>`,
    ``,
    ...lines,
    ``,
    `Use /package &lt;id&gt; for details.`,
  ].join("\n");

  await sendTextMessage(chatId, response, "textParseModeHTML");
}

async function handlePackage(chatId: bigint, id: string): Promise<void> {
  if (!id) {
    await sendTextMessage(chatId, "Usage: /package &lt;id&gt;", "textParseModeHTML");
    return;
  }

  const pkg = await getPackageById(id.trim());
  if (!pkg) {
    await sendTextMessage(chatId, "Package not found.", "textParseModeHTML");
    return;
  }

  const fileList = pkg.files
    .slice(0, 15)
    .map((f) => `  ${escapeHtml(f.path)}`)
    .join("\n");
  const moreFiles = pkg.files.length > 15 ? `\n  ... and ${pkg.fileCount - 15} more` : "";

  const details = [
    `📦 <b>${escapeHtml(pkg.fileName)}</b>`,
    ``,
    `Type: ${pkg.archiveType}`,
    `Size: ${formatSize(pkg.fileSize)}`,
    `Files: ${pkg.fileCount}`,
    pkg.creator ? `Creator: ${escapeHtml(pkg.creator)}` : null,
    `Source: ${escapeHtml(pkg.sourceChannel.title)}`,
    `Indexed: ${formatDate(pkg.indexedAt)}`,
    pkg.isMultipart ? `Parts: ${pkg.partCount}` : null,
    ``,
    `<b>File listing:</b>`,
    `<code>${fileList}${moreFiles}</code>`,
  ]
    .filter(Boolean)
    .join("\n");

  // Send preview if available
  if (pkg.previewData) {
    await sendPhotoMessage(
      chatId,
      Buffer.from(pkg.previewData),
      details
    );
  } else {
    await sendTextMessage(chatId, details, "textParseModeHTML");
  }
}

async function handleLink(
  chatId: bigint,
  userId: bigint,
  code: string,
  msg: IncomingMessage
): Promise<void> {
  if (!code) {
    await sendTextMessage(
      chatId,
      "Usage: /link &lt;code&gt;\n\nGet your link code from Settings → Telegram in the web app.",
      "textParseModeHTML"
    );
    return;
  }

  // Check if already linked
  const existing = await findLinkByTelegramUserId(userId);
  if (existing) {
    await sendTextMessage(
      chatId,
      "Your Telegram account is already linked to a web account. Use /unlink first if you want to re-link.",
      "textParseModeHTML"
    );
    return;
  }

  // Validate the code
  const webUserId = await validateLinkCode(code.trim());
  if (!webUserId) {
    await sendTextMessage(
      chatId,
      "Invalid or expired link code. Please generate a new one from Settings → Telegram.",
      "textParseModeHTML"
    );
    return;
  }

  // Create the link
  const displayName = [msg.firstName, msg.lastName].filter(Boolean).join(" ");
  await createTelegramLink(webUserId, userId, displayName || msg.username || null);
  await deleteLinkCode(code.trim());

  await sendTextMessage(
    chatId,
    `✅ <b>Account linked successfully!</b>\n\nYou can now receive packages sent from the web app. Use /status to verify.`,
    "textParseModeHTML"
  );

  log.info({ userId: userId.toString(), webUserId }, "Telegram account linked");
}

async function handleUnlink(chatId: bigint, userId: bigint): Promise<void> {
  const existing = await findLinkByTelegramUserId(userId);
  if (!existing) {
    await sendTextMessage(
      chatId,
      "Your Telegram account is not linked to any web account.",
      "textParseModeHTML"
    );
    return;
  }

  const { db } = await import("./db/client.js");
  await db.telegramLink.delete({ where: { telegramUserId: userId } });

  await sendTextMessage(
    chatId,
    "🔓 Account unlinked. You will no longer receive packages from the web app.",
    "textParseModeHTML"
  );

  log.info({ userId: userId.toString() }, "Telegram account unlinked");
}

async function handleSubscribe(
  chatId: bigint,
  userId: bigint,
  pattern: string
): Promise<void> {
  if (!pattern) {
    await sendTextMessage(
      chatId,
      "Usage: /subscribe &lt;keyword&gt;\n\nYou'll be notified when new packages matching this keyword are indexed.",
      "textParseModeHTML"
    );
    return;
  }

  await addSubscription(userId, pattern.toLowerCase().trim());

  await sendTextMessage(
    chatId,
    `🔔 Subscribed to "<b>${escapeHtml(pattern.trim())}</b>".\n\nYou'll be notified when matching packages are indexed.`,
    "textParseModeHTML"
  );
}

async function handleUnsubscribe(
  chatId: bigint,
  userId: bigint,
  pattern: string
): Promise<void> {
  if (!pattern) {
    await sendTextMessage(
      chatId,
      "Usage: /unsubscribe &lt;keyword&gt;",
      "textParseModeHTML"
    );
    return;
  }

  const result = await removeSubscription(userId, pattern.toLowerCase().trim());

  if (result.count === 0) {
    await sendTextMessage(
      chatId,
      `No subscription found for "<b>${escapeHtml(pattern.trim())}</b>".`,
      "textParseModeHTML"
    );
  } else {
    await sendTextMessage(
      chatId,
      `🔕 Unsubscribed from "<b>${escapeHtml(pattern.trim())}</b>".`,
      "textParseModeHTML"
    );
  }
}

async function handleListSubscriptions(
  chatId: bigint,
  userId: bigint
): Promise<void> {
  const subs = await getSubscriptions(userId);

  if (subs.length === 0) {
    await sendTextMessage(
      chatId,
      "You have no active subscriptions. Use /subscribe &lt;keyword&gt; to add one.",
      "textParseModeHTML"
    );
    return;
  }

  const lines = subs.map(
    (s, i) => `${i + 1}. <b>${escapeHtml(s.pattern)}</b> (since ${formatDate(s.createdAt)})`
  );

  const response = [
    `🔔 <b>Your subscriptions:</b>`,
    ``,
    ...lines,
    ``,
    `Use /unsubscribe &lt;keyword&gt; to remove one.`,
  ].join("\n");

  await sendTextMessage(chatId, response, "textParseModeHTML");
}

async function handleStatus(chatId: bigint, userId: bigint): Promise<void> {
  const link = await findLinkByTelegramUserId(userId);

  if (link) {
    await sendTextMessage(
      chatId,
      `✅ <b>Linked</b>\n\nYour Telegram account is linked to a web account.\nLinked since: ${formatDate(link.createdAt)}`,
      "textParseModeHTML"
    );
  } else {
    await sendTextMessage(
      chatId,
      `❌ <b>Not linked</b>\n\nUse /link &lt;code&gt; to connect your web account.`,
      "textParseModeHTML"
    );
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
