import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { config } from "../util/config.js";

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Pool needs headroom for: 2 account advisory locks (held for entire cycle),
  // up to 2 concurrent hash locks, plus Prisma operations from both accounts.
  // Previously max=5 caused pool exhaustion and indefinite hangs.
  max: 15,
  // Prevent pool.connect() from blocking forever when pool is exhausted.
  // Throws an error after 30s so the operation can fail and retry instead of
  // silently hanging for hours (as happened with the Turnbase.7z stall).
  connectionTimeoutMillis: 30_000,
});

const adapter = new PrismaPg(pool);
export const db = new PrismaClient({ adapter });

export { pool };
