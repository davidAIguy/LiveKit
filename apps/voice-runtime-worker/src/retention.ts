import { env } from "./config.js";
import { runRetentionCleanup } from "./db.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRetentionCycle(): Promise<void> {
  const result = await runRetentionCleanup(env.RETENTION_DAYS);
  console.log(
    `retention cleanup completed: job_id=${result.jobId} deleted=${result.recordsDeleted} eligible_calls=${result.eligibleCalls} days=${env.RETENTION_DAYS}`
  );
}

export async function runRetentionLoop(): Promise<void> {
  while (true) {
    try {
      await runRetentionCycle();
    } catch (error) {
      console.error("retention cleanup failed", error);
    }

    await sleep(env.RETENTION_CLEANUP_INTERVAL_MS);
  }
}
