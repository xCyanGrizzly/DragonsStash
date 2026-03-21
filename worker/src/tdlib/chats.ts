import type { Client } from "tdl";
import { childLogger } from "../util/logger.js";
import { config } from "../util/config.js";
import { withFloodWait } from "../util/retry.js";

const log = childLogger("chats");

export interface TelegramChatInfo {
  chatId: bigint;
  title: string;
  type: "channel" | "supergroup" | "group" | "private" | "other";
  isForum: boolean;
  memberCount?: number;
}

/**
 * Fetch all chats the account is a member of.
 * Uses TDLib's getChats to load the chat list, then getChat for details.
 * Filters to channels and supergroups only (groups/privates are not useful for ingestion).
 */
export async function getAccountChats(
  client: Client
): Promise<TelegramChatInfo[]> {
  const chats: TelegramChatInfo[] = [];

  // Load main chat list — TDLib loads in batches
  let offsetOrder = "9223372036854775807"; // max int64 as string
  let offsetChatId = 0;
  let hasMore = true;

  while (hasMore) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await withFloodWait(
      () => client.invoke({
        _: "getChats",
        chat_list: { _: "chatListMain" },
        limit: 100,
      }),
      "getChats"
    )) as { chat_ids: number[] };

    if (!result.chat_ids || result.chat_ids.length === 0) {
      break;
    }

    for (const chatId of result.chat_ids) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chat = (await withFloodWait(
          () => client.invoke({
            _: "getChat",
            chat_id: chatId,
          }),
          "getChat"
        )) as any;

        const chatType = chat.type?._;
        let type: TelegramChatInfo["type"] = "other";
        let isForum = false;

        if (chatType === "chatTypeSupergroup") {
          // Get supergroup details to check if it's a channel or group
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sg = (await withFloodWait(
              () => client.invoke({
                _: "getSupergroup",
                supergroup_id: chat.type.supergroup_id,
              }),
              "getSupergroup"
            )) as any;

            type = sg.is_channel ? "channel" : "supergroup";
            isForum = sg.is_forum ?? false;
          } catch {
            type = "supergroup";
          }
        } else if (chatType === "chatTypeBasicGroup") {
          type = "group";
        } else if (chatType === "chatTypePrivate" || chatType === "chatTypeSecret") {
          type = "private";
        }

        // Only include channels and supergroups
        if (type === "channel" || type === "supergroup") {
          chats.push({
            chatId: BigInt(chatId),
            title: chat.title ?? `Chat ${chatId}`,
            type,
            isForum,
          });
        }
      } catch (err) {
        log.warn({ chatId, err }, "Failed to get chat details, skipping");
      }
    }

    // getChats with chatListMain returns all chats at once in newer TDLib versions
    // So we break after the first batch
    hasMore = false;

    await sleep(config.apiDelayMs);
  }

  log.info(
    { total: chats.length },
    "Fetched channels/supergroups from Telegram"
  );

  return chats;
}

/**
 * Generate an invite link for a chat. The account must be an admin or have
 * invite link permissions.
 */
export async function generateInviteLink(
  client: Client,
  chatId: bigint
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await withFloodWait(
    () => client.invoke({
      _: "createChatInviteLink",
      chat_id: Number(chatId),
      name: "DragonsStash Auto-Join",
      creates_join_request: false,
    }),
    "createChatInviteLink"
  )) as any;

  const link = result.invite_link as string;
  log.info({ chatId: chatId.toString(), link }, "Generated invite link");
  return link;
}

/**
 * Create a new supergroup (private group) via TDLib.
 * Returns the chat ID and title.
 */
export async function createSupergroup(
  client: Client,
  title: string
): Promise<{ chatId: bigint; title: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await withFloodWait(
    () => client.invoke({
      _: "createNewSupergroupChat",
      title,
      is_forum: false,
      is_channel: false,
      description: "DragonsStash archive destination — all accounts write here",
    }),
    "createNewSupergroupChat"
  )) as any;

  const chatId = BigInt(result.id);
  log.info({ chatId: chatId.toString(), title }, "Created new supergroup");
  return { chatId, title: result.title ?? title };
}

/**
 * Join a chat using an invite link.
 */
export async function joinChatByInviteLink(
  client: Client,
  inviteLink: string
): Promise<void> {
  await withFloodWait(
    () => client.invoke({
      _: "joinChatByInviteLink",
      invite_link: inviteLink,
    }),
    "joinChatByInviteLink"
  );
  log.info({ inviteLink }, "Joined chat by invite link");
}

/**
 * Search for a public chat by username.
 * Returns the chat info if found, or null if not found.
 */
export async function searchPublicChat(
  client: Client,
  username: string
): Promise<TelegramChatInfo | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chat = (await withFloodWait(
      () => client.invoke({
        _: "searchPublicChat",
        username,
      }),
      "searchPublicChat"
    )) as any;

    const chatType = chat.type?._;
    let type: TelegramChatInfo["type"] = "other";
    let isForum = false;

    if (chatType === "chatTypeSupergroup") {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sg = (await withFloodWait(
          () => client.invoke({
            _: "getSupergroup",
            supergroup_id: chat.type.supergroup_id,
          }),
          "getSupergroup"
        )) as any;

        type = sg.is_channel ? "channel" : "supergroup";
        isForum = sg.is_forum ?? false;
      } catch {
        type = "supergroup";
      }
    } else if (chatType === "chatTypeBasicGroup") {
      type = "group";
    } else if (chatType === "chatTypePrivate" || chatType === "chatTypeSecret") {
      type = "private";
    }

    log.info({ username, chatId: chat.id, type }, "Found public chat");
    return {
      chatId: BigInt(chat.id),
      title: chat.title ?? username,
      type,
      isForum,
    };
  } catch (err) {
    log.warn({ username, err }, "Public chat not found");
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
