import { describe, it, expect, vi } from "vitest";
import { forwardArchiveToChannel } from "./forward.js";

function fakeClient(response: unknown) {
  return { invoke: vi.fn(async () => response) } as never;
}

describe("forwardArchiveToChannel", () => {
  it("sorts message ids ascending and sends them via forwardMessages", async () => {
    const invoke = vi.fn(async (req: { message_ids: number[] }) => ({
      messages: req.message_ids.map((id) => ({ id: id + 1000 })),
    }));
    const client = { invoke } as never;

    const result = await forwardArchiveToChannel(client, 111n, 222n, [30n, 10n, 20n]);

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        _: "forwardMessages",
        chat_id: 222,
        from_chat_id: 111,
        message_ids: [10, 20, 30],
        send_copy: false,
      }),
    );
    expect(result.messageId).toBe(1010n);
    expect(result.messageIds).toEqual([1010n, 1020n, 1030n]);
  });

  it("throws when Telegram returns null for a message (can't be forwarded)", async () => {
    const client = fakeClient({ messages: [{ id: 1001 }, null] });
    await expect(forwardArchiveToChannel(client, 111n, 222n, [10n, 20n])).rejects.toThrow(/could not forward/);
  });

  it("throws when the response has the wrong number of messages", async () => {
    const client = fakeClient({ messages: [{ id: 1001 }] });
    await expect(forwardArchiveToChannel(client, 111n, 222n, [10n, 20n])).rejects.toThrow(/expected 2/);
  });
});
