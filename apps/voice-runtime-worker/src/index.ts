import { env } from "./config.js";
import { db } from "./db.js";
import { runDispatchClaimerLoop } from "./claimer.js";
import { runAgentSessionLauncherLoop } from "./launcher.js";
import { runWorkerLoop } from "./worker.js";

async function start(): Promise<void> {
  await db.query("select 1");
  console.log("voice-runtime-worker started");

  const processes: Array<Promise<void>> = [runWorkerLoop()];
  if (env.CLAIMER_ENABLED) {
    console.log("runtime dispatch claimer enabled");
    processes.push(runDispatchClaimerLoop());
  }

  if (env.LAUNCHER_ENABLED) {
    console.log("runtime agent launcher enabled");
    processes.push(runAgentSessionLauncherLoop());
  }

  await Promise.all(processes);
}

start().catch((error) => {
  console.error("voice-runtime-worker failed", error);
  process.exit(1);
});
