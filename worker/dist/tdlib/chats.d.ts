import type { Client } from "tdl";
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
export declare function getAccountChats(client: Client): Promise<TelegramChatInfo[]>;
/**
 * Generate an invite link for a chat. The account must be an admin or have
 * invite link permissions.
 */
export declare function generateInviteLink(client: Client, chatId: bigint): Promise<string>;
/**
 * Create a new supergroup (private group) via TDLib.
 * Returns the chat ID and title.
 */
export declare function createSupergroup(client: Client, title: string): Promise<{
    chatId: bigint;
    title: string;
}>;
/**
 * Join a chat using an invite link.
 */
export declare function joinChatByInviteLink(client: Client, inviteLink: string): Promise<void>;
