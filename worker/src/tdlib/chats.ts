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
 * Returns ALL chat types: channels, supergroups, groups, private chats,
 * and the special "Saved Messages" (self) chat.
 */
export async function getAccountChats(
  client: Client
): Promise<TelegramChatInfo[]> {
  const chats: TelegramChatInfo[] = [];

  // Get the current user's ID so we can label Saved Messages
  let selfUserId: number | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = (await client.invoke({ _: "getMe" })) as any;
    selfUserId = me.id;
  } catch {
    log.warn("Failed to get current user via getMe");
  }

  // First, load all chats into TDLib's cache using loadChats (the proper API).
  // loadChats returns 404 when all chats have been loaded.
  // Then use getChats to retrieve the IDs for enrichment.
  // Load from main, archive, AND chat folders to cover all chat types.
  const folderLists: { _: "chatListFolder"; chat_folder_id: number }[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const folders = (await client.invoke({ _: "getChatFolders" })) as any;
    if (folders?.chat_folders) {
      for (const f of folders.chat_folders) {
        folderLists.push({ _: "chatListFolder", chat_folder_id: f.id });
      }
    }
  } catch {
    // getChatFolders may not be available in older TDLib versions
  }

  const chatLists: Record<string, unknown>[] = [
    { _: "chatListMain" },
    { _: "chatListArchive" },
    ...folderLists,
  ];

  // Phase 1: Load all chats into TDLib's cache
  for (const chatList of chatLists) {
    try {
      for (let page = 0; page < 500; page++) {
        await withFloodWait(
          () => client.invoke({ _: "loadChats", chat_list: chatList, limit: 100 }),
          "loadChats"
        );
      }
    } catch {
      // 404 = all chats loaded (expected), or unsupported list type
    }
  }

  // Phase 2: Retrieve chat IDs and enrich with details
  const seenChatIds = new Set<number>();

  for (const chatList of chatLists) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: { chat_ids: number[] };
    try {
      result = (await withFloodWait(
        () => client.invoke({
          _: "getChats",
          chat_list: chatList,
          limit: 50000,
        }),
        "getChats"
      )) as { chat_ids: number[] };
    } catch {
      continue;
    }

    if (!result.chat_ids || result.chat_ids.length === 0) continue;

    for (const chatId of result.chat_ids) {
      if (seenChatIds.has(chatId)) continue;
      seenChatIds.add(chatId);

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
        let title = chat.title ?? `Chat ${chatId}`;

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
          if (selfUserId !== null && chat.type?.user_id === selfUserId) {
            title = "Saved Messages";
          }
        }

        chats.push({
          chatId: BigInt(chatId),
          title,
          type,
          isForum,
        });
      } catch (err) {
        log.warn({ chatId, err }, "Failed to get chat details, skipping");
      }
    }
  }

  log.info(
    { total: chats.length },
    "Fetched all chats from Telegram (main + archive + folders)"
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
