import tdl, { createClient } from "tdl";
import { getTdjson } from "prebuilt-tdlib";
import path from "path";
import { config } from "../util/config.js";
import { childLogger } from "../util/logger.js";
import { updateAccountAuthState, getAccountAuthCode, } from "../db/queries.js";
const log = childLogger("tdlib-client");
// Configure tdl to use the prebuilt tdjson shared library
tdl.configure({ tdjson: getTdjson() });
/**
 * Create and authenticate a TDLib client for a Telegram account.
 * Authentication flow communicates with the admin UI via the database:
 * - Worker sets authState to AWAITING_CODE when TDLib asks for phone code
 * - Admin enters the code via UI, which writes it to authCode field
 * - Worker polls DB for the code and feeds it to TDLib
 */
export async function createTdlibClient(account) {
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
        return client;
    }
    catch (err) {
        log.error({ err, accountId: account.id }, "TDLib authentication failed");
        await updateAccountAuthState(account.id, "EXPIRED");
        throw err;
    }
}
/**
 * Poll the database every 5 seconds for an auth code, up to 5 minutes.
 */
async function pollForAuthCode(accountId, timeoutMs = 300_000) {
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
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Close a TDLib client gracefully.
 */
export async function closeTdlibClient(client) {
    try {
        await client.close();
    }
    catch (err) {
        log.warn({ err }, "Error closing TDLib client");
    }
}
//# sourceMappingURL=client.js.map