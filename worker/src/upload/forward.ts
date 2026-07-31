import type { Client } from "tdl";
import { childLogger } from "../util/logger.js";
import { withFloodWait } from "../util/retry.js";

const log = childLogger("forward");

export interface ForwardResult {
  messageId: bigint;
  messageIds: bigint[];
}

/**
 * Forward all parts of an archive set from the source chat directly to the
 * destination chat via TDLib's forwardMessages — no download, no re-upload.
 * Only usable when the source channel allows forwarding
 * (TelegramChannel.allowsForwarding); the caller is responsible for that
 * check. message_ids must be in strictly increasing order per the TDLib API,
 * so this always sorts them regardless of the order they're passed in.
 */
export async function forwardArchiveToChannel(
  client: Client,
  fromChatId: bigint,
  toChatId: bigint,
  sourceMessageIds: bigint[],
): Promise<ForwardResult> {
  const sortedIds = [...sourceMessageIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const numericIds = sortedIds.map((id) => Number(id));

  log.info(
    { fromChatId: Number(fromChatId), toChatId: Number(toChatId), count: numericIds.length },
    "Forwarding archive to destination channel"
  );

  const result = (await withFloodWait(
    () =>
      client.invoke({
        _: "forwardMessages",
        chat_id: Number(toChatId),
        topic_id: null,
        from_chat_id: Number(fromChatId),
        message_ids: numericIds,
        options: null,
        send_copy: false,
        remove_caption: false,
      } as never),
    "forwardMessages"
  )) as { messages: ({ id: number } | null)[] };

  const forwarded = result.messages;
  if (!forwarded || forwarded.length !== numericIds.length) {
    throw new Error(
      `forwardMessages returned ${forwarded?.length ?? 0} messages, expected ${numericIds.length}`
    );
  }

  const messageIds: bigint[] = [];
  for (let i = 0; i < forwarded.length; i++) {
    const msg = forwarded[i];
    if (!msg) {
      throw new Error(
        `forwardMessages could not forward source message ${sortedIds[i]} (Telegram returned null — message may not be forwardable)`
      );
    }
    messageIds.push(BigInt(msg.id));
  }

  log.info(
    { fromChatId: Number(fromChatId), toChatId: Number(toChatId), messageIds: messageIds.map(Number) },
    "Forward confirmed by Telegram"
  );

  return { messageId: messageIds[0], messageIds };
}
