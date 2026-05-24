import { execFile } from "child_process";
import { promisify } from "util";
import { childLogger } from "../util/logger.js";

const execFileAsync = promisify(execFile);
const log = childLogger("integrity");

export type IntegrityResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Test that the archive can be read end-to-end without errors, BEFORE we
 * spend bandwidth uploading it to the destination channel. Catches:
 *   - Truncated downloads (rare given our size check, but cheap to confirm)
 *   - CRC errors inside the archive
 *   - Bad central directories
 *   - Encrypted archives (we report them as failures rather than upload
 *     a file users can't extract)
 *
 * Returns { ok: true } if the archive is intact. Returns
 * { ok: false, reason } otherwise. Logs at warn level on failure.
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
        return { ok: false, reason: `unzip -t reported: ${stderr.slice(0, 500)}` };
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
      return { ok: false, reason: `unrar t did not report "All OK": ${combined.slice(-500)}` };
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
      return { ok: false, reason: `7z t did not report "Everything is Ok": ${combined.slice(-500)}` };
    }

    return { ok: false, reason: `Unknown archive type: ${archiveType}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // execFile throws on non-zero exit. Try to extract the most useful part.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stderr = (err as any)?.stderr as string | undefined;
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : "";

    // Specifically flag encrypted archives so the caller can record a more
    // specific SkipReason / notification.
    if (/password|encrypted|need.*password/i.test(`${msg}${detail}`)) {
      return { ok: false, reason: `Archive is encrypted (password protected): ${msg}${detail}` };
    }

    log.debug({ err, archiveType, firstPartPath }, "Archive integrity test failed");
    return { ok: false, reason: `Integrity test failed: ${msg}${detail}` };
  }
}
