import { env } from "../../config.js";
import type { TtsAdapter, VoiceAudioPacket } from "./types.js";

function synthesizePcmFromText(text: string, sampleRateHz = 16000): VoiceAudioPacket {
  const durationMs = Math.max(300, Math.min(1800, text.length * 18));
  const totalSamples = Math.floor((sampleRateHz * durationMs) / 1000);
  const samples = new Int16Array(totalSamples);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }

  const baseFreq = 180 + (hash % 220);
  const amplitude = 0.15;
  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRateHz;
    const value = Math.sin(2 * Math.PI * baseFreq * t) * amplitude;
    samples[i] = Math.round(value * 32767);
  }

  return {
    bytes: new Uint8Array(samples.buffer.slice(0)),
    sampleRateHz,
    channels: 1,
    format: "pcm_s16le"
  };
}

function decodeWavPcm16(buffer: Buffer): VoiceAudioPacket | null {
  if (buffer.byteLength < 44) {
    return null;
  }

  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let formatTag = 0;
  let channels = 1;
  let sampleRate = env.TTS_DEFAULT_SAMPLE_RATE_HZ;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.byteLength) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt " && chunkDataOffset + 16 <= buffer.byteLength) {
      formatTag = buffer.readUInt16LE(chunkDataOffset);
      channels = buffer.readUInt16LE(chunkDataOffset + 2);
      sampleRate = buffer.readUInt32LE(chunkDataOffset + 4);
      bitsPerSample = buffer.readUInt16LE(chunkDataOffset + 14);
    }

    if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = Math.min(chunkSize, buffer.byteLength - chunkDataOffset);
      break;
    }

    const advance = 8 + chunkSize + (chunkSize % 2);
    offset += advance;
  }

  if (dataOffset < 0 || dataSize <= 0 || formatTag !== 1 || bitsPerSample !== 16) {
    return null;
  }

  const sampleBytes = Buffer.from(buffer.subarray(dataOffset, dataOffset + dataSize));
  const monoSamples = Math.floor(sampleBytes.byteLength / 2 / Math.max(1, channels));
  const mono = new Int16Array(monoSamples);

  for (let i = 0; i < monoSamples; i += 1) {
    if (channels === 1) {
      mono[i] = sampleBytes.readInt16LE(i * 2);
      continue;
    }

    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      sum += sampleBytes.readInt16LE((i * channels + c) * 2);
    }
    mono[i] = Math.round(sum / channels);
  }

  return {
    bytes: new Uint8Array(mono.buffer.slice(0)),
    sampleRateHz: sampleRate,
    channels: 1,
    format: "pcm_s16le"
  };
}

function parseJsonAudioPayload(payload: unknown): VoiceAudioPacket | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const base64 =
    (typeof record.audio_base64 === "string" && record.audio_base64) ||
    (typeof record.audio === "string" && record.audio) ||
    (typeof record.data === "string" && record.data) ||
    "";
  if (!base64) {
    return null;
  }

  const sampleRate =
    (typeof record.sample_rate_hz === "number" && record.sample_rate_hz) ||
    (typeof record.sample_rate === "number" && record.sample_rate) ||
    env.TTS_DEFAULT_SAMPLE_RATE_HZ;

  const channels =
    (typeof record.channels === "number" && Number.isInteger(record.channels) && record.channels > 0
      ? record.channels
      : 1) || 1;

  const format =
    record.format === "pcm_s16le"
      ? "pcm_s16le"
      : record.format === "opus"
        ? "opus"
        : "unknown";

  return {
    bytes: new Uint8Array(Buffer.from(base64, "base64")),
    sampleRateHz: sampleRate,
    channels,
    format
  };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

class RimeTtsAdapter implements TtsAdapter {
  provider: string;

  constructor(provider: string) {
    this.provider = provider;
  }

  private get config(): { apiKey: string; apiUrl: string } | null {
    if (this.provider === "rime") {
      if (!env.TTS_RIME_API_KEY) {
        return null;
      }
      return {
        apiKey: env.TTS_RIME_API_KEY,
        apiUrl: env.TTS_RIME_API_URL
      };
    }

    if (this.provider === "remi") {
      if (!env.TTS_REMI_API_KEY || !env.TTS_REMI_API_URL) {
        return null;
      }
      return {
        apiKey: env.TTS_REMI_API_KEY,
        apiUrl: env.TTS_REMI_API_URL
      };
    }

    return null;
  }

  get mode(): "ready" | "unconfigured" {
    return this.config ? "ready" : "unconfigured";
  }

  async synthesize(text: string): Promise<VoiceAudioPacket> {
    const cfg = this.config;
    if (!cfg) {
      return synthesizePcmFromText(text, env.TTS_DEFAULT_SAMPLE_RATE_HZ);
    }

    const maxRetries = Math.max(0, env.TTS_MAX_RETRIES);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetchWithTimeout(
          cfg.apiUrl,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "audio/wav, audio/mp3, application/json",
              Authorization: `Bearer ${cfg.apiKey}`,
              "X-API-Key": cfg.apiKey
            },
            body: JSON.stringify({
              text,
              speaker: this.provider === "rime" ? env.TTS_RIME_SPEAKER : undefined,
              modelId: this.provider === "rime" ? env.TTS_RIME_MODEL_ID : undefined,
              format: "wav",
              sample_rate_hz: env.TTS_DEFAULT_SAMPLE_RATE_HZ
            })
          },
          env.TTS_REQUEST_TIMEOUT_MS
        );

        if (!response.ok) {
          if (attempt < maxRetries && shouldRetryStatus(response.status)) {
            const delay = env.TTS_RETRY_BASE_DELAY_MS * 2 ** attempt;
            await sleep(delay);
            continue;
          }
          break;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const payload = (await response.json().catch(() => null)) as unknown;
          const parsed = parseJsonAudioPayload(payload);
          if (parsed) {
            return parsed;
          }
          break;
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (contentType.includes("audio/wav") || contentType.includes("audio/x-wav")) {
          const wav = decodeWavPcm16(buffer);
          if (wav) {
            return wav;
          }
        }

        return synthesizePcmFromText(text, env.TTS_DEFAULT_SAMPLE_RATE_HZ);
      } catch {
        if (attempt < maxRetries) {
          const delay = env.TTS_RETRY_BASE_DELAY_MS * 2 ** attempt;
          await sleep(delay);
          continue;
        }
      }
    }

    return synthesizePcmFromText(text, env.TTS_DEFAULT_SAMPLE_RATE_HZ);
  }

  async stop(): Promise<void> {
    return;
  }
}

class MockTtsAdapter implements TtsAdapter {
  provider: string;
  mode: "mock" = "mock";

  constructor(provider: string) {
    this.provider = provider;
  }

  async synthesize(text: string): Promise<VoiceAudioPacket> {
    return synthesizePcmFromText(`mock_tts:${text}`, env.TTS_DEFAULT_SAMPLE_RATE_HZ);
  }

  async stop(): Promise<void> {
    return;
  }
}

export function createTtsAdapter(provider: string): TtsAdapter {
  if (provider === "rime" || provider === "remi") {
    return new RimeTtsAdapter(provider);
  }

  return new MockTtsAdapter(provider || "unknown_tts");
}
