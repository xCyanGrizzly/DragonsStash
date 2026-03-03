import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  transport:
    config.logLevel === "debug"
      ? { target: "pino/file", options: { destination: 1 } }
      : undefined,
});

export function childLogger(module: string, extra?: Record<string, unknown>) {
  return logger.child({ module, ...extra });
}
