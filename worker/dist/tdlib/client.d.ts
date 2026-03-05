import { type Client } from "tdl";
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
export declare function createTdlibClient(account: AccountConfig): Promise<Client>;
/**
 * Close a TDLib client gracefully.
 */
export declare function closeTdlibClient(client: Client): Promise<void>;
export {};
