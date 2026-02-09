import "./types/http.js";
import { buildApp } from "./app.js";
import { env } from "./config.js";

async function start() {
  const app = buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
