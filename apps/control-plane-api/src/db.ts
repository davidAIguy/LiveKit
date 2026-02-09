import pg from "pg";
import { env } from "./config.js";

const { Pool } = pg;

export const db = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20
});

export async function healthcheckDb(): Promise<void> {
  await db.query("select 1");
}
