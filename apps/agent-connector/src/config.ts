import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().url().optional()
);

const defaultedUrl = (defaultValue: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().default(defaultValue)
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(4200),
  CONNECTOR_AUTH_TOKEN: z.string().optional(),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AGENT_CONNECTOR_MOCK_AI: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_MODEL_FALLBACK: z.string().default("gpt-4o-mini"),
  CONNECTOR_VOICE_RUNTIME_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  CONNECTOR_LIVEKIT_TRANSPORT_MODE: z.enum(["mock", "auto"]).default("mock"),
  STT_DEEPGRAM_API_KEY: z.string().optional(),
  STT_DEEPGRAM_MODEL: z.string().default("nova-3"),
  STT_DEEPGRAM_LANGUAGE: z.string().default("es"),
  STT_CONNECT_HARD_FAIL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  TWILIO_MEDIA_STREAM_TOKEN: z.string().optional(),
  VOICE_BARGE_IN_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  VOICE_BARGE_IN_ENERGY_THRESHOLD: z.coerce.number().positive().max(1).default(0.045),
  VOICE_BARGE_IN_HOLD_MS: z.coerce.number().int().positive().default(1200),
  TTS_RIME_API_KEY: z.string().optional(),
  TTS_REMI_API_KEY: z.string().optional(),
  TTS_RIME_API_URL: defaultedUrl("https://users.rime.ai/v1/rime-tts"),
  TTS_REMI_API_URL: optionalUrl,
  TTS_RIME_SPEAKER: z.string().default("celeste"),
  TTS_RIME_MODEL_ID: z.string().default("arcana"),
  TTS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  TTS_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  TTS_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(250),
  TTS_DEFAULT_SAMPLE_RATE_HZ: z.coerce.number().int().positive().default(16000),
  MOCK_N8N_AUTH_SECRET: z.string().default("local-dev-secret"),
  AUTOMATION_GATEWAY_BASE_URL: z.string().url().optional(),
  AUTOMATION_GATEWAY_BEARER_TOKEN: z.string().optional(),
  AUTOMATION_TOOL_COMMAND_PREFIX: z.string().default("/tool"),
  AUTOMATION_GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  AUTOMATION_LLM_TOOL_CALLS_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true")
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid agent-connector env: ${details}`);
}

export const env = parsed.data;
