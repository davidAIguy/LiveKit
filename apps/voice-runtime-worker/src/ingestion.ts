import { env } from "./config.js";
import { projectEndedCallsFromEvents, refreshCallMetrics } from "./db.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runIngestionCycle(): Promise<void> {
  const updatedCalls = await projectEndedCallsFromEvents(env.INGESTION_BATCH_SIZE);
  const upsertedMetrics = await refreshCallMetrics(env.METRICS_LOOKBACK_DAYS);

  if (updatedCalls > 0 || upsertedMetrics > 0) {
    console.log(
      `ingestion cycle completed: ended_calls=${updatedCalls} metrics_upserted=${upsertedMetrics} lookback_days=${env.METRICS_LOOKBACK_DAYS}`
    );
  }
}

export async function runIngestionLoop(): Promise<void> {
  while (true) {
    try {
      await runIngestionCycle();
    } catch (error) {
      console.error("ingestion cycle failed", error);
    }

    await sleep(env.INGESTION_POLL_INTERVAL_MS);
  }
}
