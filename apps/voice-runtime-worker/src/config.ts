import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(10),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),
  INGESTION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  INGESTION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  INGESTION_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  METRICS_LOOKBACK_DAYS: z.coerce.number().int().positive().max(90).default(35),
  KPI_ROLLUP_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  KPI_ROLLUP_INTERVAL_MS: z.coerce.number().int().positive().default(300000),
  KPI_LOOKBACK_DAYS: z.coerce.number().int().positive().max(365).default(35),
  RETENTION_CLEANUP_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  RETENTION_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(86400000),
  RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(30),
  LIVEKIT_MOCK_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CLAIMER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  CLAIMER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  LAUNCHER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  LAUNCHER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  AGENT_LAUNCHER_URL: z.string().url().optional(),
  AGENT_LAUNCHER_AUTH_TOKEN: z.string().optional(),
  CONTROL_PLANE_BASE_URL: z.string().url().optional(),
  CONTROL_PLANE_JWT_SECRET: z.string().min(32).optional(),
  CONTROL_PLANE_JWT_ISSUER: z.string().optional(),
  CONTROL_PLANE_JWT_AUDIENCE: z.string().optional(),
  LIVEKIT_URL: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1)
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid worker environment configuration: ${details}`);
}

export const env = parsed.data;

if (env.CLAIMER_ENABLED) {
  if (!env.CONTROL_PLANE_BASE_URL) {
    throw new Error("CONTROL_PLANE_BASE_URL is required when CLAIMER_ENABLED=true");
  }
  if (!env.CONTROL_PLANE_JWT_SECRET) {
    throw new Error("CONTROL_PLANE_JWT_SECRET is required when CLAIMER_ENABLED=true");
  }
}

if (env.LAUNCHER_ENABLED) {
  if (!env.AGENT_LAUNCHER_URL) {
    throw new Error("AGENT_LAUNCHER_URL is required when LAUNCHER_ENABLED=true");
  }
}
