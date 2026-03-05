import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { config } from "../util/config.js";
const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
});
const adapter = new PrismaPg(pool);
export const db = new PrismaClient({ adapter });
export { pool };
//# sourceMappingURL=client.js.map