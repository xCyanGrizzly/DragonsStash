export declare const config: {
    readonly databaseUrl: string;
    readonly workerIntervalMinutes: number;
    readonly tempDir: string;
    readonly tdlibStateDir: string;
    readonly maxZipSizeMB: number;
    readonly logLevel: "debug" | "info" | "warn" | "error";
    readonly telegramApiId: number;
    readonly telegramApiHash: string;
    /** Maximum jitter added to scheduler interval (in minutes) */
    readonly jitterMinutes: 5;
    /** Maximum time span for multipart archive parts (in hours). 0 = no limit. */
    readonly multipartTimeoutHours: number;
    /** Delay between Telegram API calls (in ms) to avoid rate limits */
    readonly apiDelayMs: 1000;
    /** Max retries for rate-limited requests */
    readonly maxRetries: 5;
};
