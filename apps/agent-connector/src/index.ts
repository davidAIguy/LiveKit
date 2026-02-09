import { buildApp } from "./app.js";
import { env } from "./config.js";
import { healthcheckDb } from "./db.js";

async function start(): Promise<void> {
  await healthcheckDb();
  const app = buildApp();
  await app.listen({ host: env.HOST, port: env.PORT });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
