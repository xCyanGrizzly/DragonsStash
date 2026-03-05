import type { Client } from "tdl";
import type { ChannelScanResult, ScanProgressCallback } from "./download.js";
export interface ForumTopic {
    topicId: bigint;
    name: string;
}
/**
 * Check if a chat is a forum supergroup (topics enabled).
 */
export declare function isChatForum(client: Client, chatId: bigint): Promise<boolean>;
/**
 * Get all forum topics in a supergroup.
 * Includes stuck detection and timeout protection on API calls.
 */
export declare function getForumTopicList(client: Client, chatId: bigint): Promise<ForumTopic[]>;
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
 *
 * Safety features:
 *  - Max page limit to prevent infinite loops
 *  - Stuck detection: breaks if from_message_id stops advancing
 *  - Timeout on each TDLib API call
 */
export declare function getTopicMessages(client: Client, chatId: bigint, topicId: bigint, lastProcessedMessageId?: bigint | null, limit?: number, onProgress?: ScanProgressCallback): Promise<ChannelScanResult>;
