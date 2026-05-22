import path from "path";
import { stat } from "fs/promises";
import type { Client } from "tdl";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { withFloodWait, extractFloodWaitSeconds } from "../util/retry.js";

const log = childLogger("upload");

/**
 * Custom error class to distinguish upload stalls from other errors.
 * When consecutive stalls occur, the caller can use this signal to
 * recreate the TDLib client (whose event stream may have degraded).
 */
export class UploadStallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadStallError";
  }
}

export interface UploadResult {
  messageId: bigint;
  messageIds: bigint[];
}

/**
 * Upload one or more files to a destination Telegram channel.
 * For multipart archives, each file is sent as a separate message.
 * Returns the **final** (server-assigned) message ID of the first uploaded message.
 *
 * IMPORTANT: `sendMessage` returns a *temporary* message immediately.
 * The actual file upload happens asynchronously in TDLib. We listen for
 * `updateMessageSendSucceeded` to get the real server-side message ID and
 * to make sure the upload is fully committed before we clean up temp files
 * or close the TDLib client (which would cancel pending uploads).
 */
export async function uploadToChannel(
  client: Client,
  chatId: bigint,
  filePaths: string[],
  caption?: string
): Promise<UploadResult> {
  const allMessageIds: bigint[] = [];

  for (let i = 0; i < filePaths.length; i++) {
    const filePath = filePaths[i];
    const fileCaption =
      i === 0 && caption ? caption : undefined;

    const fileName = path.basename(filePath);
    let fileSizeMB = 0;
    try {
      const s = await stat(filePath);
      fileSizeMB = Math.round(s.size / (1024 * 1024));
    } catch {
      // Non-critical
    }

    log.info(
      { chatId: Number(chatId), fileName, sizeMB: fileSizeMB, part: i + 1, total: filePaths.length },
      "Uploading file to channel"
    );

    const serverMsgId = await sendWithRetry(client, chatId, filePath, fileCaption, fileName, fileSizeMB);

    allMessageIds.push(serverMsgId);

    // Rate limit delay between uploads
    if (i < filePaths.length - 1) {
      await sleep(config.apiDelayMs);
    }
  }

  if (allMessageIds.length === 0) {
    throw new Error("Upload failed: no messages sent");
  }

  log.info(
    { chatId: Number(chatId), messageId: Number(allMessageIds[0]), files: filePaths.length },
    "All uploads confirmed by Telegram"
  );

  return { messageId: allMessageIds[0], messageIds: allMessageIds };
}

/**
 * Retry wrapper for sendAndWaitForUpload.
 * Handles:
 *  - Rate limits (429 / FLOOD_WAIT) from updateMessageSendFailed — waits and retries
 *  - Stall / timeout — retries with a cooldown
 */
const MAX_UPLOAD_RETRIES = 3;

async function sendWithRetry(
  client: Client,
  chatId: bigint,
  filePath: string,
  caption: string | undefined,
  fileName: string,
  fileSizeMB: number
): Promise<bigint> {
  for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      return await sendAndWaitForUpload(client, chatId, filePath, caption, fileName, fileSizeMB);
    } catch (err) {
      const isLastAttempt = attempt >= MAX_UPLOAD_RETRIES;

      // Rate limit from Telegram (429 / FLOOD_WAIT / "retry after N")
      const waitSeconds = extractFloodWaitSeconds(err);
      if (waitSeconds !== null && !isLastAttempt) {
        const jitter = 1000 + Math.random() * 4000;
        const waitMs = waitSeconds * 1000 + jitter;
        log.warn(
          { fileName, attempt: attempt + 1, maxRetries: MAX_UPLOAD_RETRIES, waitSeconds },
          `Upload rate-limited — sleeping ${waitSeconds}s before retry`
        );
        await sleep(waitMs);
        continue;
      }

      // Stall or timeout — fail fast and let the caller recreate the TDLib
      // client. Retrying on the same degraded event stream wastes ~15 min
      // per attempt because the underlying issue (missing send-success
      // events) is client-level, not transient. The set ends up in
      // SkippedPackage and the caller's watermark cap ensures it gets
      // retried next cycle on a fresh client.
      const errMsg = err instanceof Error ? err.message : "";
      if (errMsg.includes("stalled") || errMsg.includes("timed out")) {
        log.warn(
          { fileName, attempt: attempt + 1 },
          "Upload stalled — failing fast so caller can recreate TDLib client"
        );
        throw new UploadStallError(
          `Upload stalled for ${fileName}: ${errMsg}`
        );
      }

      // Transient Telegram server-side error (HTTP 5xx returned via
      // updateMessageSendFailed). These are NOT FLOOD_WAIT, NOT stalls — just
      // TG having a bad moment. They typically resolve on a short backoff, so
      // retry up to MAX_UPLOAD_RETRIES with linear backoff before giving up.
      const lowerMsg = errMsg.toLowerCase();
      const isTransientServerError =
        lowerMsg.includes("internal server error") ||
        lowerMsg.includes("internal error") ||
        lowerMsg.includes("server error") ||
        lowerMsg.includes("bad gateway") ||
        lowerMsg.includes("service unavailable") ||
        lowerMsg.includes("gateway timeout");
      if (isTransientServerError && !isLastAttempt) {
        const backoffMs = 15_000 * (attempt + 1) + Math.random() * 5_000;
        log.warn(
          { fileName, attempt: attempt + 1, maxRetries: MAX_UPLOAD_RETRIES, backoffMs: Math.round(backoffMs) },
          `Transient Telegram server error — retrying after backoff`
        );
        await sleep(backoffMs);
        continue;
      }

      throw err;
    }
  }
  throw new Error(`Upload failed after ${MAX_UPLOAD_RETRIES} retries for ${fileName}`);
}

/**
 * Send a single file message and wait for Telegram to confirm the upload.
 * Returns the final server-assigned message ID.
 *
 * IMPORTANT: The update listener is attached BEFORE sending the message to
 * avoid a race where fast uploads (cached files) complete before the listener
 * is registered, which would cause the promise to hang forever.
 */
async function sendAndWaitForUpload(
  client: Client,
  chatId: bigint,
  filePath: string,
  caption: string | undefined,
  fileName: string,
  fileSizeMB: number
): Promise<bigint> {
  return new Promise<bigint>((resolve, reject) => {
    let settled = false;
    let lastLoggedPercent = 0;
    let tempMsgId: number | null = null;
    let uploadStarted = false;
    let lastProgressBytes = 0;
    let lastProgressTime = Date.now();

    // Events for our message can arrive before `sendMessage` resolves
    // (TDLib emits them while our .then() is still in the microtask queue).
    // Buffer them and replay once tempMsgId is known.
    let pendingSuccess: { oldMsgId: number; finalId: number } | null = null;
    let pendingFailure: { oldMsgId: number; errorMsg: string; code?: number } | null = null;

    // Timeout: 20 minutes per GB, minimum 15 minutes
    const timeoutMs = Math.max(
      15 * 60_000,
      (fileSizeMB / 1024) * 20 * 60_000
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Upload timed out after ${Math.round(timeoutMs / 60_000)}min for ${fileName}`
          )
        );
      }
    }, timeoutMs);

    // Stall detection: no progress for 3 minutes after upload started → reject
    // (reduced from 5min — once data is fully sent, confirmation should arrive quickly;
    //  a 3min silence strongly indicates a degraded TDLib event stream)
    const STALL_TIMEOUT_MS = 3 * 60_000;
    const stallChecker = setInterval(() => {
      if (settled || !uploadStarted) return;
      const stallMs = Date.now() - lastProgressTime;
      if (stallMs >= STALL_TIMEOUT_MS) {
        settled = true;
        cleanup();
        reject(
          new Error(
            `Upload stalled for ${fileName} — no progress for ${Math.round(stallMs / 60_000)}min`
          )
        );
      }
    }, 30_000);

    const completeWithSuccess = (finalId: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      log.info(
        { fileName, tempMsgId, finalMsgId: finalId },
        "Upload confirmed by Telegram"
      );
      resolve(BigInt(finalId));
    };

    const completeWithFailure = (errorMsg: string, code?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error(`Upload failed for ${fileName}: ${errorMsg}`);
      (error as Error & { code?: number }).code = code;
      reject(error);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleUpdate = (update: any) => {
      // Track upload progress via updateFile events
      if (update?._ === "updateFile") {
        const file = update.file;
        if (file?.remote?.is_uploading_active && file.expected_size > 0) {
          uploadStarted = true;

          const uploaded = file.remote.uploaded_size ?? 0;

          // Only reset stall timer when bytes actually advance
          if (uploaded > lastProgressBytes) {
            lastProgressBytes = uploaded;
            lastProgressTime = Date.now();
          }
          const total = file.expected_size;
          const percent = Math.round((uploaded / total) * 100);
          if (percent >= lastLoggedPercent + 20) {
            lastLoggedPercent = percent - (percent % 20);
            log.info(
              { fileName, uploaded, total, percent: `${percent}%` },
              "Upload progress"
            );
          }
        }
      }

      // The money event: upload succeeded, we get the final server message ID
      if (update?._ === "updateMessageSendSucceeded") {
        const msg = update.message;
        const oldMsgId: number = update.old_message_id;
        if (tempMsgId === null) {
          // Race: event arrived before our .then() assigned tempMsgId.
          // Buffer it and process once tempMsgId is known.
          pendingSuccess = { oldMsgId, finalId: msg.id };
          return;
        }
        if (oldMsgId === tempMsgId) {
          completeWithSuccess(msg.id);
        }
      }

      // Upload failed
      if (update?._ === "updateMessageSendFailed") {
        const oldMsgId: number = update.old_message_id;
        const errorMsg: string = update.error?.message ?? "Unknown upload error";
        const code: number | undefined = update.error?.code;
        if (tempMsgId === null) {
          pendingFailure = { oldMsgId, errorMsg, code };
          return;
        }
        if (oldMsgId === tempMsgId) {
          completeWithFailure(errorMsg, code);
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(stallChecker);
      client.off("update", handleUpdate);
    };

    // Attach listener BEFORE sending to avoid missing fast completions
    client.on("update", handleUpdate);

    // Send the message — this returns a temporary message immediately.
    // Wrapped in withFloodWait to handle Telegram rate limits on upload.
    withFloodWait(
      () =>
        client.invoke({
          _: "sendMessage",
          chat_id: Number(chatId),
          input_message_content: {
            _: "inputMessageDocument",
            document: {
              _: "inputFileLocal",
              path: filePath,
            },
            caption: caption
              ? {
                  _: "formattedText",
                  text: caption,
                }
              : undefined,
          },
        }),
      "sendMessage:upload"
    )
      .then((result) => {
        const tempMsg = result as { id: number };
        tempMsgId = tempMsg.id;
        log.debug(
          { fileName, tempMsgId },
          "Message queued, waiting for upload confirmation"
        );

        // Replay any event that arrived before we knew tempMsgId
        if (pendingSuccess && pendingSuccess.oldMsgId === tempMsgId) {
          completeWithSuccess(pendingSuccess.finalId);
        } else if (pendingFailure && pendingFailure.oldMsgId === tempMsgId) {
          completeWithFailure(pendingFailure.errorMsg, pendingFailure.code);
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err);
        }
      });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
