import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_ISSUER: z.string().optional(),
  JWT_AUDIENCE: z.string().optional(),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/, "ENCRYPTION_KEY must be a 64-char hex key (32 bytes)"),
  N8N_TEST_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  N8N_TEST_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AUTOMATION_MAX_EXECUTIONS_PER_MINUTE: z.coerce.number().int().positive().max(120).default(8),
  AUTOMATION_REQUIRE_AGENT_TOOL_MAPPING: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  AUTH_JWT_EXPIRES_IN: z.string().default("8h"),
  AUTH_BOOTSTRAP_KEY: z.string().optional(),
  DEV_BOOTSTRAP_KEY: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_VALIDATE_SIGNATURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  TWILIO_WEBHOOK_BASE_URL: z.string().url().optional(),
  TWILIO_MEDIA_STREAM_URL: z.string().url().optional(),
  TWILIO_MEDIA_STREAM_TOKEN: z.string().optional()
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = parsed.data;
