import tdl, { createClient, type Client } from "tdl";
import { getTdjson } from "prebuilt-tdlib";
import path from "path";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import {
  updateAccountAuthState,
  getAccountAuthCode,
  updateAccountPremiumStatus,
} from "../db/queries.js";

const log = childLogger("tdlib-client");

// Configure tdl to use the prebuilt tdjson shared library
tdl.configure({ tdjson: getTdjson() });

interface AccountConfig {
  id: string;
  phone: string;
}

/**
 * Create and authenticate a TDLib client for a Telegram account.
 * Authentication flow communicates with the admin UI via the database:
 * - Worker sets authState to AWAITING_CODE when TDLib asks for phone code
 * - Admin enters the code via UI, which writes it to authCode field
 * - Worker polls DB for the code and feeds it to TDLib
 */
export async function createTdlibClient(
  account: AccountConfig
): Promise<{ client: Client; isPremium: boolean }> {
  const dbPath = path.join(config.tdlibStateDir, account.id);

  const client = createClient({
    apiId: config.telegramApiId,
    apiHash: config.telegramApiHash,
    databaseDirectory: dbPath,
    filesDirectory: path.join(dbPath, "files"),
  });

  client.on("error", (err) => {
    log.error({ err, accountId: account.id }, "TDLib client error");
  });

  try {
    await client.login(() => ({
      getPhoneNumber: async () => {
        log.info({ accountId: account.id }, "TDLib requesting phone number");
        return account.phone;
      },
      getAuthCode: async () => {
        log.info({ accountId: account.id }, "TDLib requesting auth code");
        await updateAccountAuthState(account.id, "AWAITING_CODE");

        // Poll database for the code entered via admin UI
        const code = await pollForAuthCode(account.id);
        if (!code) {
          throw new Error("Auth code not provided within timeout");
        }

        // Clear the code after reading
        await updateAccountAuthState(account.id, "AUTHENTICATED", null);
        return code;
      },
      getPassword: async () => {
        log.info({ accountId: account.id }, "TDLib requesting 2FA password");
        await updateAccountAuthState(account.id, "AWAITING_PASSWORD");

        // Poll database for the password entered via admin UI
        const code = await pollForAuthCode(account.id);
        if (!code) {
          throw new Error("2FA password not provided within timeout");
        }

        await updateAccountAuthState(account.id, "AUTHENTICATED", null);
        return code;
      },
    }));

    await updateAccountAuthState(account.id, "AUTHENTICATED");
    log.info({ accountId: account.id }, "TDLib client authenticated");

    let isPremium = false;
    try {
      const me = await client.invoke({ _: "getMe" }) as { is_premium?: boolean };
      isPremium = me.is_premium ?? false;
      await updateAccountPremiumStatus(account.id, isPremium);
      log.info({ accountId: account.id, isPremium }, "Account Premium status detected");
    } catch (err) {
      log.warn({ err, accountId: account.id }, "Could not detect Premium status, defaulting to false");
    }

    client.on("update", (update: unknown) => {
      const u = update as { _?: string; is_upload?: boolean };
      if (u?._ === "updateSpeedLimitNotification") {
        log.warn(
          { accountId: account.id, isUpload: u.is_upload },
          u.is_upload
            ? "Upload speed limited by Telegram (account is not Premium)"
            : "Download speed limited by Telegram (account is not Premium)"
        );
      }
    });

    return { client, isPremium };
  } catch (err) {
    log.error({ err, accountId: account.id }, "TDLib authentication failed");
    await updateAccountAuthState(account.id, "EXPIRED");
    throw err;
  }
}

/**
 * Poll the database every 5 seconds for an auth code, up to 5 minutes.
 */
async function pollForAuthCode(
  accountId: string,
  timeoutMs = 300_000
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await getAccountAuthCode(accountId);
    if (result?.authCode) {
      return result.authCode;
    }
    await sleep(5000);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Close a TDLib client gracefully.
 */
export async function closeTdlibClient(client: Client): Promise<void> {
  try {
    await client.close();
  } catch (err) {
    log.warn({ err }, "Error closing TDLib client");
  }
}

/**
 * Prune TDLib's local file cache (filesDirectory). TDLib keeps a permanent
 * copy of every file it has ever downloaded or uploaded — via inputFileLocal
 * uploads in particular — with no automatic cleanup. That cache is redundant
 * (the content already lives in the source and destination Telegram chats)
 * and grows unbounded, so it's cleared after every ingestion run. A short
 * immunity_delay protects files from an in-flight operation that might still
 * reference them.
 */
export async function optimizeTdlibStorage(
  client: Client,
  accountId: string
): Promise<void> {
  try {
    const result = (await client.invoke({
      _: "optimizeStorage",
      size: 0,
      ttl: 0,
      count: 0,
      immunity_delay: 300,
      return_deleted_file_statistics: true,
    })) as { size?: number; count?: number };
    log.info(
      { accountId, freedBytes: result.size, freedCount: result.count },
      "TDLib local file cache pruned"
    );
  } catch (err) {
    log.warn({ err, accountId }, "TDLib storage optimization failed");
  }
}
