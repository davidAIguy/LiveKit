import { buildApp } from "./app.js";
import { env } from "./config.js";

async function start(): Promise<void> {
  const app = buildApp();
  await app.listen({ host: env.HOST, port: env.PORT });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
