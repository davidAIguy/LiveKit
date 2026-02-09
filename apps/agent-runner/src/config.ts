import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4100),
  RUNNER_AUTH_TOKEN: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().min(1),
  AGENT_CONNECTOR_URL: z.string().url().optional(),
  AGENT_CONNECTOR_AUTH_TOKEN: z.string().optional()
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid agent-runner environment configuration: ${details}`);
}

export const env = parsed.data;
