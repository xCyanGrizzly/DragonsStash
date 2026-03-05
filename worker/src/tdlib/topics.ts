import type { Client } from "tdl";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { isArchiveAttachment } from "../archive/detect.js";
import type { TelegramMessage } from "../archive/multipart.js";
import type { TelegramPhoto } from "../preview/match.js";
import type { ChannelScanResult, ScanProgressCallback } from "./download.js";

const log = childLogger("topics");

export interface ForumTopic {
  topicId: bigint;
  name: string;
}

/**
 * Check if a chat is a forum supergroup (topics enabled).
 */
export async function isChatForum(
  client: Client,
  chatId: bigint
): Promise<boolean> {
  try {
    const chat = (await client.invoke({
      _: "getChat",
      chat_id: Number(chatId),
    })) as {
      type?: {
        _: string;
        supergroup_id?: number;
        is_forum?: boolean;
      };
    };

    if (chat.type?._ === "chatTypeSupergroup" && chat.type.is_forum) {
      return true;
    }

    // Also check via getSupergroup for older TDLib versions
    if (chat.type?._ === "chatTypeSupergroup" && chat.type.supergroup_id) {
      const sg = (await client.invoke({
        _: "getSupergroup",
        supergroup_id: chat.type.supergroup_id,
      })) as { is_forum?: boolean };
      return sg.is_forum === true;
    }

    return false;
  } catch (err) {
    log.warn({ err, chatId: chatId.toString() }, "Failed to check if chat is forum");
    return false;
  }
}

/**
 * Get all forum topics in a supergroup.
 */
export async function getForumTopicList(
  client: Client,
  chatId: bigint
): Promise<ForumTopic[]> {
  const topics: ForumTopic[] = [];
  let offsetDate = 0;
  let offsetMessageId = 0;
  let offsetMessageThreadId = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = (await client.invoke({
      _: "getForumTopics",
      chat_id: Number(chatId),
      query: "",
      offset_date: offsetDate,
      offset_message_id: offsetMessageId,
      offset_message_thread_id: offsetMessageThreadId,
      limit: 100,
    })) as {
      topics?: {
        info?: {
          message_thread_id?: number;
          name?: string;
          is_general?: boolean;
        };
      }[];
      next_offset_date?: number;
      next_offset_message_id?: number;
      next_offset_message_thread_id?: number;
    };

    if (!result.topics || result.topics.length === 0) break;

    for (const t of result.topics) {
      if (!t.info?.message_thread_id) continue;
      // Skip the "General" topic — it's not creator-specific
      if (t.info.is_general) continue;

      topics.push({
        topicId: BigInt(t.info.message_thread_id),
        name: t.info.name ?? "Unnamed",
      });
    }

    // Check if there are more pages
    if (
      !result.next_offset_date &&
      !result.next_offset_message_id &&
      !result.next_offset_message_thread_id
    ) {
      break;
    }

    offsetDate = result.next_offset_date ?? 0;
    offsetMessageId = result.next_offset_message_id ?? 0;
    offsetMessageThreadId = result.next_offset_message_thread_id ?? 0;

    await sleep(config.apiDelayMs);
  }

  log.info(
    { chatId: chatId.toString(), topicCount: topics.length },
    "Enumerated forum topics"
  );

  return topics;
}

/**
 * Fetch messages from a specific forum topic (thread), stopping once
 * we've scanned past the last-processed boundary (with one page of lookback).
 * Uses searchChatMessages with message_thread_id to scan within a topic.
 *
 * Returns messages in chronological order (oldest first).
 *
 * When `lastProcessedMessageId` is null (first run), scans everything.
 * The worker applies a post-grouping filter to skip fully-processed sets,
 * and keeps `packageExistsBySourceMessage` as a safety net.
 */
export async function getTopicMessages(
  client: Client,
  chatId: bigint,
  topicId: bigint,
  lastProcessedMessageId?: bigint | null,
  limit = 100,
  onProgress?: ScanProgressCallback
): Promise<ChannelScanResult> {
  const archives: TelegramMessage[] = [];
  const photos: TelegramPhoto[] = [];
  const boundary = lastProcessedMessageId ? Number(lastProcessedMessageId) : null;

  let currentFromId = 0;
  let totalScanned = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (await client.invoke({
      _: "searchChatMessages",
      chat_id: Number(chatId),
      query: "",
      message_thread_id: Number(topicId),
      from_message_id: currentFromId,
      offset: 0,
      limit: Math.min(limit, 100),
      filter: null,
      sender_id: null,
      saved_messages_topic_id: 0,
    })) as {
      messages?: {
        id: number;
        date: number;
        content: {
          _: string;
          document?: {
            file_name?: string;
            document?: {
              id: number;
              size: number;
            };
          };
          photo?: {
            sizes?: {
              type: string;
              photo: { id: number; size: number; expected_size: number };
              width: number;
              height: number;
            }[];
          };
          caption?: { text?: string };
        };
      }[];
    };

    if (!result.messages || result.messages.length === 0) break;

    totalScanned += result.messages.length;

    for (const msg of result.messages) {
      // Check for archive documents
      const doc = msg.content?.document;
      if (doc?.file_name && doc.document && isArchiveAttachment(doc.file_name)) {
        archives.push({
          id: BigInt(msg.id),
          fileName: doc.file_name,
          fileId: String(doc.document.id),
          fileSize: BigInt(doc.document.size),
          date: new Date(msg.date * 1000),
        });
        continue;
      }

      // Check for photo messages (potential previews)
      const photo = msg.content?.photo;
      const caption = msg.content?.caption?.text ?? "";
      if (photo?.sizes && photo.sizes.length > 0) {
        const smallest = photo.sizes[0];
        photos.push({
          id: BigInt(msg.id),
          date: new Date(msg.date * 1000),
          caption,
          fileId: String(smallest.photo.id),
          fileSize: smallest.photo.size || smallest.photo.expected_size,
        });
      }
    }

    // Report scanning progress after each page
    onProgress?.(totalScanned);

    currentFromId = result.messages[result.messages.length - 1].id;

    // Stop scanning once we've gone past the boundary (this page is the lookback)
    if (boundary && currentFromId < boundary) break;

    if (result.messages.length < 100) break;

    await sleep(config.apiDelayMs);
  }

  log.info(
    { chatId: chatId.toString(), topicId: topicId.toString(), archives: archives.length, photos: photos.length, totalScanned },
    "Topic scan complete"
  );

  // Reverse to chronological order (oldest first) so worker processes old→new
  return {
    archives: archives.reverse(),
    photos: photos.reverse(),
    totalScanned,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
