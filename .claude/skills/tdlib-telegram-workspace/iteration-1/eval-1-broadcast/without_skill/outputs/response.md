# /broadcast Command Implementation

## Approach

The implementation requires two pieces:

1. **A new Next.js API endpoint** (`POST /api/telegram/bot/broadcast`) -- triggered from the web app by an admin. It fetches all `TelegramLink` records from the database, then uses `pg_notify` to tell the bot to send messages. However, since broadcast is a one-shot text message (not a package forward), we take a simpler approach: the API endpoint directly uses `pg_notify` with a new `bot_broadcast` channel, passing the broadcast message text as the payload.

2. **A bot-side handler** -- the bot's `send-listener.ts` listens for the new `bot_broadcast` pg_notify channel. When it receives a broadcast payload, it queries all `TelegramLink` records and sends the message text to each linked user via `sendTextMessage`.

Additionally, a `/broadcast` command is added to the bot's command handler so admins who are chatting with the bot directly can trigger it (though the primary trigger path is the API endpoint from the web app).

---

## File 1: New API Endpoint

**Path:** `src/app/api/telegram/bot/broadcast/route.ts`

```typescript
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/telegram/bot/broadcast
 * Send a text message to ALL users who have a linked Telegram account.
 * Admin-only.
 *
 * Body: { message: string }
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Only admins can broadcast
  if (session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only admins can send broadcast messages" },
      { status: 403 }
    );
  }

  let body: { message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.message || body.message.trim().length === 0) {
    return NextResponse.json(
      { error: "message is required and must be non-empty" },
      { status: 400 }
    );
  }

  const message = body.message.trim();

  if (message.length > 4096) {
    return NextResponse.json(
      { error: "Message is too long (max 4096 characters)" },
      { status: 400 }
    );
  }

  // Count how many linked users will receive the broadcast
  const linkCount = await prisma.telegramLink.count();

  if (linkCount === 0) {
    return NextResponse.json(
      { error: "No users have linked Telegram accounts" },
      { status: 400 }
    );
  }

  // Notify the bot via pg_notify with the broadcast message
  try {
    await prisma.$queryRawUnsafe(
      `SELECT pg_notify('bot_broadcast', $1)`,
      JSON.stringify({ message, requestedBy: session.user.id })
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to queue broadcast" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: "QUEUED",
    recipientCount: linkCount,
    message: `Broadcast queued for ${linkCount} linked user(s)`,
  });
}
```

---

## File 2: Updated `bot/src/send-listener.ts`

Add handling for the `bot_broadcast` pg_notify channel. The changes are additions to the existing file -- shown below are the **new/modified sections only** with context.

In the `connectListener` function, add a new LISTEN:

```typescript
// Add after the existing LISTEN lines in connectListener():
await pgClient.query("LISTEN bot_broadcast");
```

In the notification handler, add the broadcast case:

```typescript
// Add to the pgClient.on("notification") handler:
} else if (msg.channel === "bot_broadcast" && msg.payload) {
  handleBroadcast(msg.payload);
}
```

Update the log line:

```typescript
log.info("Send listener started (bot_send, new_package, bot_broadcast)");
```

Add the broadcast handler function (new function at the bottom of the file):

```typescript
// ── bot_broadcast handler ──

async function handleBroadcast(payload: string): Promise<void> {
  try {
    const data = JSON.parse(payload) as {
      message: string;
      requestedBy: string;
    };

    log.info({ requestedBy: data.requestedBy }, "Processing broadcast request");

    // Fetch all linked Telegram users
    const { db } = await import("./db/client.js");
    const links = await db.telegramLink.findMany({
      select: { telegramUserId: true, telegramName: true },
    });

    if (links.length === 0) {
      log.warn("No linked users found for broadcast");
      return;
    }

    log.info({ recipientCount: links.length }, "Sending broadcast to linked users");

    let sent = 0;
    let failed = 0;

    for (const link of links) {
      try {
        const broadcastText = [
          `📢 <b>Broadcast Message</b>`,
          ``,
          data.message,
        ].join("\n");

        await sendTextMessage(
          link.telegramUserId,
          broadcastText,
          "textParseModeHTML"
        );
        sent++;
      } catch (err) {
        failed++;
        log.warn(
          {
            err,
            telegramUserId: link.telegramUserId.toString(),
            telegramName: link.telegramName,
          },
          "Failed to send broadcast to user"
        );
      }
    }

    log.info(
      { sent, failed, total: links.length },
      "Broadcast complete"
    );
  } catch (err) {
    log.error({ err, payload }, "Failed to process broadcast");
  }
}
```

### Full updated `bot/src/send-listener.ts`:

```typescript
import type pg from "pg";
import { pool } from "./db/client.js";
import { childLogger } from "./util/logger.js";
import {
  getPendingSendRequest,
  updateSendRequest,
  findMatchingSubscriptions,
  getGlobalDestinationChannel,
} from "./db/queries.js";
import { copyMessageToUser, sendTextMessage, sendPhotoMessage } from "./tdlib/client.js";

const log = childLogger("send-listener");

let pgClient: pg.PoolClient | null = null;
let stopped = false;

/** Delay (ms) before attempting to reconnect after a connection loss. */
const RECONNECT_DELAY_MS = 5_000;

/**
 * Start listening for pg_notify signals:
 *   - `bot_send` — payload = requestId → send a package to a user
 *   - `new_package` — payload = JSON { packageId, fileName, creator } → notify subscribers
 *   - `bot_broadcast` — payload = JSON { message, requestedBy } → send text to all linked users
 *
 * If the underlying connection is lost, the listener automatically reconnects
 * so that pg_notify signals are never silently dropped.
 */
export async function startSendListener(): Promise<void> {
  stopped = false;
  await connectListener();
}

async function connectListener(): Promise<void> {
  try {
    pgClient = await pool.connect();
    await pgClient.query("LISTEN bot_send");
    await pgClient.query("LISTEN new_package");
    await pgClient.query("LISTEN bot_broadcast");

    pgClient.on("notification", (msg) => {
      if (msg.channel === "bot_send" && msg.payload) {
        handleBotSend(msg.payload);
      } else if (msg.channel === "new_package" && msg.payload) {
        handleNewPackage(msg.payload);
      } else if (msg.channel === "bot_broadcast" && msg.payload) {
        handleBroadcast(msg.payload);
      }
    });

    // Reconnect automatically when the connection ends unexpectedly
    pgClient.on("end", () => {
      if (!stopped) {
        log.warn("Send listener connection lost — reconnecting");
        pgClient = null;
        scheduleReconnect();
      }
    });

    pgClient.on("error", (err) => {
      log.error({ err }, "Send listener connection error");
      if (!stopped && pgClient) {
        try {
          pgClient.release(true);
        } catch (releaseErr) {
          log.debug({ err: releaseErr }, "Failed to release pg client after error");
        }
        pgClient = null;
        scheduleReconnect();
      }
    });

    log.info("Send listener started (bot_send, new_package, bot_broadcast)");
  } catch (err) {
    log.error({ err }, "Failed to start send listener — retrying");
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (stopped) return;
  setTimeout(() => {
    if (!stopped) {
      connectListener();
    }
  }, RECONNECT_DELAY_MS);
}

export function stopSendListener(): void {
  stopped = true;
  if (pgClient) {
    pgClient.release();
    pgClient = null;
  }
  log.info("Send listener stopped");
}

// ── bot_send handler ──

let sendQueue: Promise<void> = Promise.resolve();

function handleBotSend(requestId: string): void {
  sendQueue = sendQueue.then(() => processSendRequest(requestId)).catch((err) => {
    log.error({ err, requestId }, "Send request processing failed");
  });
}

async function processSendRequest(requestId: string): Promise<void> {
  const request = await getPendingSendRequest(requestId);
  if (!request || request.status !== "PENDING") {
    log.warn({ requestId }, "Send request not found or not pending");
    return;
  }

  log.info(
    {
      requestId,
      packageId: request.packageId,
      targetTgId: request.telegramLink.telegramUserId.toString(),
    },
    "Processing send request"
  );

  await updateSendRequest(requestId, "SENDING");

  try {
    const pkg = request.package;
    const targetUserId = request.telegramLink.telegramUserId;

    if (!pkg.destChannelId || !pkg.destMessageId) {
      throw new Error("Package has no destination message — cannot forward");
    }

    // Get the destination channel's Telegram ID
    const destChannel = await getGlobalDestinationChannel();
    if (!destChannel) {
      throw new Error("No global destination channel configured");
    }

    // Send preview if available
    if (pkg.previewData) {
      const caption = `📦 *${pkg.fileName}*\n\nSent from Dragon's Stash`;
      await sendPhotoMessage(targetUserId, Buffer.from(pkg.previewData), caption);
    }

    // Forward the actual archive file(s) from destination channel
    await copyMessageToUser(
      destChannel.telegramId,
      pkg.destMessageId,
      targetUserId
    );

    await updateSendRequest(requestId, "SENT");
    log.info({ requestId }, "Send request completed successfully");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, requestId }, "Send request failed");
    await updateSendRequest(requestId, "FAILED", message);
  }
}

// ── new_package handler ──

async function handleNewPackage(payload: string): Promise<void> {
  try {
    const data = JSON.parse(payload) as {
      packageId: string;
      fileName: string;
      creator: string | null;
    };

    const subs = await findMatchingSubscriptions(data.fileName, data.creator);
    if (subs.length === 0) return;

    log.info(
      { packageId: data.packageId, matchedSubscriptions: subs.length },
      "Notifying subscribers of new package"
    );

    // Group by user to send one notification per user
    const userSubs = new Map<string, string[]>();
    for (const sub of subs) {
      const key = sub.telegramUserId.toString();
      const patterns = userSubs.get(key) ?? [];
      patterns.push(sub.pattern);
      userSubs.set(key, patterns);
    }

    const creator = data.creator ? ` by ${escapeHtml(data.creator)}` : "";
    for (const [telegramUserId, patterns] of userSubs) {
      const msg = [
        `🔔 <b>New package matching your subscriptions:</b>`,
        ``,
        `📦 <b>${escapeHtml(data.fileName)}</b>${creator}`,
        ``,
        `Matched: ${patterns.map((p) => `"${escapeHtml(p)}"`).join(", ")}`,
        ``,
        `Use /package ${data.packageId} for details.`,
      ].join("\n");

      await sendTextMessage(BigInt(telegramUserId), msg, "textParseModeHTML").catch((err) => {
        log.warn(
          { err, telegramUserId, packageId: data.packageId },
          "Failed to notify subscriber"
        );
      });
    }
  } catch (err) {
    log.error({ err, payload }, "Failed to process new_package notification");
  }
}

// ── bot_broadcast handler ──

async function handleBroadcast(payload: string): Promise<void> {
  try {
    const data = JSON.parse(payload) as {
      message: string;
      requestedBy: string;
    };

    log.info({ requestedBy: data.requestedBy }, "Processing broadcast request");

    // Fetch all linked Telegram users
    const { db } = await import("./db/client.js");
    const links = await db.telegramLink.findMany({
      select: { telegramUserId: true, telegramName: true },
    });

    if (links.length === 0) {
      log.warn("No linked users found for broadcast");
      return;
    }

    log.info({ recipientCount: links.length }, "Sending broadcast to linked users");

    let sent = 0;
    let failed = 0;

    for (const link of links) {
      try {
        const broadcastText = [
          `📢 <b>Broadcast Message</b>`,
          ``,
          data.message,
        ].join("\n");

        await sendTextMessage(
          link.telegramUserId,
          broadcastText,
          "textParseModeHTML"
        );
        sent++;
      } catch (err) {
        failed++;
        log.warn(
          {
            err,
            telegramUserId: link.telegramUserId.toString(),
            telegramName: link.telegramName,
          },
          "Failed to send broadcast to user"
        );
      }
    }

    log.info(
      { sent, failed, total: links.length },
      "Broadcast complete"
    );
  } catch (err) {
    log.error({ err, payload }, "Failed to process broadcast");
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

---

## File 3: Updated `bot/src/commands.ts`

Add the `/broadcast` command to the bot's command handler. This allows an admin who is also a linked Telegram user to trigger a broadcast directly from the bot chat. The command queries all `TelegramLink` records and sends the message to each.

### Changes to the switch statement (add new case before `default`):

```typescript
      case "/broadcast":
        await handleBroadcast(chatId, userId, args);
        break;
```

### New handler function:

```typescript
async function handleBroadcast(
  chatId: bigint,
  userId: bigint,
  message: string
): Promise<void> {
  if (!message) {
    await sendTextMessage(
      chatId,
      "Usage: /broadcast &lt;message&gt;\n\nSends a message to all linked Telegram users.",
      "textParseModeHTML"
    );
    return;
  }

  // Verify the sender is a linked admin user
  const link = await findLinkByTelegramUserId(userId);
  if (!link) {
    await sendTextMessage(
      chatId,
      "You must link your Telegram account first. Use /link &lt;code&gt;.",
      "textParseModeHTML"
    );
    return;
  }

  // Check if the linked user is an admin
  const { db } = await import("./db/client.js");
  const user = await db.user.findUnique({
    where: { id: link.userId },
    select: { role: true },
  });

  if (!user || user.role !== "ADMIN") {
    await sendTextMessage(
      chatId,
      "Only admins can use the /broadcast command.",
      "textParseModeHTML"
    );
    return;
  }

  // Fetch all linked users
  const links = await db.telegramLink.findMany({
    select: { telegramUserId: true, telegramName: true },
  });

  if (links.length === 0) {
    await sendTextMessage(
      chatId,
      "No users have linked Telegram accounts.",
      "textParseModeHTML"
    );
    return;
  }

  await sendTextMessage(
    chatId,
    `📢 Sending broadcast to ${links.length} user(s)...`,
    "textParseModeHTML"
  );

  let sent = 0;
  let failed = 0;

  for (const target of links) {
    try {
      const broadcastText = [
        `📢 <b>Broadcast Message</b>`,
        ``,
        message,
      ].join("\n");

      await sendTextMessage(
        target.telegramUserId,
        broadcastText,
        "textParseModeHTML"
      );
      sent++;
    } catch {
      failed++;
    }
  }

  await sendTextMessage(
    chatId,
    `✅ Broadcast complete. Sent: ${sent}, Failed: ${failed}, Total: ${links.length}`,
    "textParseModeHTML"
  );
}
```

### Updated help text in `handleStart` and `handleHelp`:

In `handleStart`, add to the commands list:
```typescript
    `/broadcast &lt;message&gt; — Send message to all linked users (admin)`,
```

In `handleHelp`, add a new section:
```typescript
    ``,
    `📢 <b>Admin</b>`,
    `/broadcast &lt;message&gt; — Send to all linked users`,
```

### Full updated `bot/src/commands.ts`:

```typescript
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
      case "/broadcast":
        await handleBroadcastCommand(chatId, userId, args);
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
    `/broadcast &lt;message&gt; — Send to all linked users (admin)`,
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
    ``,
    `📢 <b>Admin</b>`,
    `/broadcast &lt;message&gt; — Send message to all linked users`,
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

async function handleBroadcastCommand(
  chatId: bigint,
  userId: bigint,
  message: string
): Promise<void> {
  if (!message) {
    await sendTextMessage(
      chatId,
      "Usage: /broadcast &lt;message&gt;\n\nSends a message to all linked Telegram users.",
      "textParseModeHTML"
    );
    return;
  }

  // Verify the sender is a linked admin user
  const link = await findLinkByTelegramUserId(userId);
  if (!link) {
    await sendTextMessage(
      chatId,
      "You must link your Telegram account first. Use /link &lt;code&gt;.",
      "textParseModeHTML"
    );
    return;
  }

  // Check if the linked user is an admin
  const { db } = await import("./db/client.js");
  const user = await db.user.findUnique({
    where: { id: link.userId },
    select: { role: true },
  });

  if (!user || user.role !== "ADMIN") {
    await sendTextMessage(
      chatId,
      "Only admins can use the /broadcast command.",
      "textParseModeHTML"
    );
    return;
  }

  // Fetch all linked users
  const links = await db.telegramLink.findMany({
    select: { telegramUserId: true, telegramName: true },
  });

  if (links.length === 0) {
    await sendTextMessage(
      chatId,
      "No users have linked Telegram accounts.",
      "textParseModeHTML"
    );
    return;
  }

  await sendTextMessage(
    chatId,
    `📢 Sending broadcast to ${links.length} user(s)...`,
    "textParseModeHTML"
  );

  let sent = 0;
  let failed = 0;

  for (const target of links) {
    try {
      const broadcastText = [
        `📢 <b>Broadcast Message</b>`,
        ``,
        message,
      ].join("\n");

      await sendTextMessage(
        target.telegramUserId,
        broadcastText,
        "textParseModeHTML"
      );
      sent++;
    } catch {
      failed++;
    }
  }

  await sendTextMessage(
    chatId,
    `✅ Broadcast complete. Sent: ${sent}, Failed: ${failed}, Total: ${links.length}`,
    "textParseModeHTML"
  );

  log.info(
    { userId: userId.toString(), sent, failed, total: links.length },
    "Broadcast sent via /broadcast command"
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
```

---

## Summary of Changes

### New file: `src/app/api/telegram/bot/broadcast/route.ts`
- `POST /api/telegram/bot/broadcast` -- admin-only API endpoint
- Accepts `{ message: string }` in the request body
- Validates the user is authenticated and has ADMIN role
- Validates message is non-empty and under 4096 chars
- Sends a `bot_broadcast` pg_notify signal with the message payload
- Returns the count of recipients that will receive the broadcast

### Modified file: `bot/src/send-listener.ts`
- Added `LISTEN bot_broadcast` to the PostgreSQL notification listener
- Added `handleBroadcast()` function that:
  - Parses the broadcast payload (message text + requester ID)
  - Queries all `TelegramLink` records from the database
  - Iterates over each linked user and sends the message via `sendTextMessage`
  - Logs success/failure counts
  - Handles individual send failures gracefully (continues to next user)

### Modified file: `bot/src/commands.ts`
- Added `/broadcast <message>` command case to the switch statement
- Added `handleBroadcastCommand()` function that:
  - Verifies the sender has a linked account via `findLinkByTelegramUserId`
  - Checks the linked web user has ADMIN role
  - Fetches all `TelegramLink` records and sends the message to each
  - Reports back with sent/failed counts
- Updated `/start` and `/help` text to include the new command

### Architecture decisions:
- **Two trigger paths**: The web app triggers via the API endpoint (which uses `pg_notify`), while the bot command triggers directly. This matches the existing pattern where `bot_send` uses `pg_notify` from the web app.
- **No schema changes needed**: The broadcast uses existing `TelegramLink` records -- no new database tables or migrations required.
- **Graceful failure handling**: If sending to one user fails, the broadcast continues to the remaining users. Failures are logged but don't abort the whole broadcast.
- **Admin-only**: Both the API endpoint and the bot command verify admin privileges before allowing a broadcast.
