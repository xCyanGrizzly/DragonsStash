import pino from "pino";
export declare const logger: pino.Logger<never, boolean>;
export declare function childLogger(name: string, extra?: Record<string, unknown>): pino.Logger<never, boolean>;
