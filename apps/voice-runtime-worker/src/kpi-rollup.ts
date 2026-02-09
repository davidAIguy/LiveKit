import { env } from "./config.js";
import { refreshDailyKpis } from "./db.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRollupCycle(): Promise<void> {
  const rows = await refreshDailyKpis(env.KPI_LOOKBACK_DAYS);
  console.log(`kpi rollup completed: rows=${rows} lookback_days=${env.KPI_LOOKBACK_DAYS}`);
}

export async function runKpiRollupLoop(): Promise<void> {
  while (true) {
    try {
      await runRollupCycle();
    } catch (error) {
      console.error("kpi rollup failed", error);
    }

    await sleep(env.KPI_ROLLUP_INTERVAL_MS);
  }
}
