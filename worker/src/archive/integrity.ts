import { execFile } from "child_process";
import { promisify } from "util";
import { childLogger } from "../util/logger.js";

const execFileAsync = promisify(execFile);
const log = childLogger("integrity");

export type IntegrityFailureKind = "encrypted" | "corrupt" | "inconclusive";

export type IntegrityResult =
  | { ok: true }
  | { ok: false; reason: string; kind: IntegrityFailureKind };

/**
 * Test that the archive can be read end-to-end without errors, BEFORE we
 * spend bandwidth uploading it to the destination channel.
 *
 * Failures are classified so the caller can react appropriately:
 *   - "encrypted"    — password-protected; users can't extract it. Actionable.
 *   - "corrupt"      — genuine CRC / structural error (truncated download, bad
 *                      central directory, CRC mismatch). Actionable.
 *   - "inconclusive" — the test tool itself was killed (OOM) or timed out,
 *                      typically on very large 7z archives in a memory-limited
 *                      container (exit 137 / SIGKILL). This is a TOOL
 *                      LIMITATION, not corruption — callers should NOT raise a
 *                      user-facing alarm for it.
 *
 * Returns { ok: true } if the archive is intact, otherwise
 * { ok: false, reason, kind }.
 *
 * For multipart archives, pass the first part. unzip / unrar / 7z all
 * auto-discover sibling parts.
 *
 * archiveType "DOCUMENT" is a pass-through — there's no container to test.
 */
export async function testArchiveIntegrity(
  archiveType: "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT",
  firstPartPath: string
): Promise<IntegrityResult> {
  if (archiveType === "DOCUMENT") {
    return { ok: true };
  }

  try {
    if (archiveType === "ZIP") {
      // -t = test, -qq = very quiet (errors only)
      const { stderr } = await execFileAsync("unzip", ["-tqq", firstPartPath], {
        timeout: 300_000, // 5 min for very large archives
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stderr && stderr.trim()) {
        return { ok: false, kind: "corrupt", reason: `unzip -t reported: ${stderr.slice(0, 500)}` };
      }
      return { ok: true };
    }

    if (archiveType === "RAR") {
      const { stdout, stderr } = await execFileAsync("unrar", ["t", firstPartPath], {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      // unrar uses non-zero exit code on errors, which becomes a throw.
      // If it succeeds, "All OK" is in stdout.
      const combined = `${stdout}\n${stderr}`;
      if (/All OK/i.test(combined)) {
        return { ok: true };
      }
      return { ok: false, kind: "corrupt", reason: `unrar t did not report "All OK": ${combined.slice(-500)}` };
    }

    if (archiveType === "SEVEN_Z") {
      const { stdout, stderr } = await execFileAsync("7z", ["t", firstPartPath], {
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const combined = `${stdout}\n${stderr}`;
      if (/Everything is Ok/i.test(combined)) {
        return { ok: true };
      }
      return { ok: false, kind: "corrupt", reason: `7z t did not report "Everything is Ok": ${combined.slice(-500)}` };
    }

    return { ok: false, kind: "corrupt", reason: `Unknown archive type: ${archiveType}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // execFile throws on non-zero exit, on timeout, and when killed by a signal.
    const e = err as {
      stderr?: unknown;
      stdout?: unknown;
      signal?: string | null;
      killed?: boolean;
      code?: number | string | null;
    };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : "";
    const haystack = `${msg}\n${stdout}\n${stderr}`;

    // Encrypted archives — users can't extract them, so flag clearly.
    if (/password|encrypted|wrong password|enter password/i.test(haystack)) {
      return { ok: false, kind: "encrypted", reason: `Archive is encrypted (password protected): ${msg}${detail}` };
    }

    // Inconclusive — the test tool was killed or timed out rather than
    // reporting corruption. Common on large 7z in memory-limited containers,
    // where `7z t` gets OOM-killed (SIGKILL / exit 137) mid-decompression.
    // That's a tool limitation, not a corrupt archive.
    const killedBySignal = e.signal === "SIGKILL" || e.signal === "SIGTERM";
    const killedExitCode = e.code === 137 || e.code === 143; // 128 + SIGKILL/SIGTERM
    const timedOut = e.killed === true;
    const maxBufferExceeded = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    if (killedBySignal || killedExitCode || timedOut || maxBufferExceeded) {
      log.debug(
        { err, archiveType, firstPartPath, signal: e.signal, code: e.code, killed: e.killed },
        "Archive integrity test inconclusive (tool killed or timed out)"
      );
      return {
        ok: false,
        kind: "inconclusive",
        reason: `Integrity test could not complete (tool killed or timed out — likely OOM on a large archive): ${msg}`,
      };
    }

    // Genuine failure: a real non-zero exit with error output.
    log.debug({ err, archiveType, firstPartPath }, "Archive integrity test failed");
    return { ok: false, kind: "corrupt", reason: `Integrity test failed: ${msg}${detail}` };
  }
}
