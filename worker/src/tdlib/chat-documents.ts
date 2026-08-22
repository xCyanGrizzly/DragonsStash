import type { Client } from "tdl";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { invokeWithTimeout, MAX_SCAN_PAGES } from "./download.js";

const log = childLogger("chat-documents");

/** One document message in a chat, with everything a ranged read needs. */
export interface ChatDocument {
  id: bigint;
  fileName: string;
  fileId: string;
  fileSize: bigint;
  date: Date;
}

export interface ChatDocumentScan {
  /** Every document message with a file name, oldest first. */
  documents: ChatDocument[];
  /** Total messages returned by the search, including ones without a document. */
  totalScanned: number;
  pages: number;
  /** True when the scan stopped on MAX_SCAN_PAGES rather than running out. */
  truncated: boolean;
}

/**
 * Page through every document message in a chat.
 *
 * `searchChatMessages` rather than `getChatHistory` because the destination
 * channel may be a hidden-history supergroup, where history reads come back
 * empty.
 *
 * Deliberately returns **all** documents and leaves filtering to the caller.
 * The rebuild path wants only names `archive/detect.ts` recognizes; the repair
 * path specifically needs the ones it does *not* — a `<base>.concat.NNN` chunk
 * matches no archive pattern, and if the scan dropped those the repair could
 * not tell "this package was repacked into an unlistable concatenation" apart
 * from "its destination messages are gone".
 */
export async function scanChatDocuments(
  client: Client,
  chatId: bigint,
  onProgress?: (messagesScanned: number) => Promise<void> | void
): Promise<ChatDocumentScan> {
  const documents: ChatDocument[] = [];
  let currentFromId = 0;
  let totalScanned = 0;
  let pageCount = 0;
  let lastProgressUpdate = 0;
  let truncated = false;

  for (;;) {
    if (pageCount >= MAX_SCAN_PAGES) {
      log.warn(
        { chatId: chatId.toString(), pageCount, totalScanned },
        "Hit max page limit for chat document scan, stopping"
      );
      truncated = true;
      break;
    }
    pageCount++;

    const previousFromId = currentFromId;

    const result = await invokeWithTimeout<{
      messages?: {
        id: number;
        date: number;
        content: {
          _: string;
          document?: {
            file_name?: string;
            document?: { id: number; size: number };
          };
        };
      }[];
    }>(client, {
      _: "searchChatMessages",
      chat_id: Number(chatId),
      // No topic context for a flat scan. TDLib 1.8.64+ replaced
      // `message_thread_id` / `saved_messages_topic_id` with a single optional
      // `topic_id`; for a flat scan we just omit it.
      query: "",
      from_message_id: currentFromId,
      offset: 0,
      limit: 100,
      filter: { _: "searchMessagesFilterDocument" },
      sender_id: null,
    });

    if (!result.messages || result.messages.length === 0) break;

    totalScanned += result.messages.length;

    for (const msg of result.messages) {
      const doc = msg.content?.document;
      if (doc?.file_name && doc.document) {
        documents.push({
          id: BigInt(msg.id),
          fileName: doc.file_name,
          fileId: String(doc.document.id),
          fileSize: BigInt(doc.document.size),
          date: new Date(msg.date * 1000),
        });
      }
    }

    // Throttle progress updates to every 2 seconds
    const now = Date.now();
    if (onProgress && now - lastProgressUpdate >= 2000) {
      lastProgressUpdate = now;
      await onProgress(totalScanned);
    }

    currentFromId = result.messages[result.messages.length - 1].id;

    // Stuck detection
    if (currentFromId === previousFromId) {
      log.warn(
        { chatId: chatId.toString(), currentFromId, totalScanned },
        "Pagination stuck, breaking"
      );
      break;
    }

    if (result.messages.length < 100) break;

    await sleep(config.apiDelayMs);
  }

  if (onProgress) await onProgress(totalScanned);

  log.info(
    { chatId: chatId.toString(), documents: documents.length, totalScanned, pages: pageCount, truncated },
    "Chat document scan complete"
  );

  // Reverse to chronological order (oldest first)
  documents.reverse();
  return { documents, totalScanned, pages: pageCount, truncated };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
