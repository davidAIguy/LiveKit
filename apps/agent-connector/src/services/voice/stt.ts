import { env } from "../../config.js";
import { WebSocket } from "ws";
import type {
  SttAdapter,
  SttTranscriptEvent,
  VoiceInboundAudioFrame,
  VoiceSessionHooks,
  VoiceSessionInput
} from "./types.js";

interface DeepgramMessage {
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
}

function toTranscriptEvent(message: DeepgramMessage): SttTranscriptEvent | null {
  const alternative = message.channel?.alternatives?.[0];
  if (!alternative) {
    return null;
  }

  const text = alternative.transcript?.trim();
  if (!text) {
    return null;
  }

  return {
    text,
    isFinal: Boolean(message.is_final || message.speech_final),
    confidence: typeof alternative.confidence === "number" ? alternative.confidence : undefined,
    provider: "deepgram"
  };
}

class DeepgramSttAdapter implements SttAdapter {
  provider = "deepgram";
  private ws: WebSocket | null = null;
  private hooks: VoiceSessionHooks = {};
  private keepAliveTimer: NodeJS.Timeout | null = null;

  get mode(): "ready" | "unconfigured" {
    return env.STT_DEEPGRAM_API_KEY ? "ready" : "unconfigured";
  }

  async start(_input: VoiceSessionInput, hooks?: VoiceSessionHooks): Promise<void> {
    this.hooks = hooks ?? {};
    if (this.mode !== "ready") {
      return;
    }

    const query = new URLSearchParams({
      encoding: "linear16",
      sample_rate: "8000",
      channels: "1",
      interim_results: "true",
      punctuate: "true",
      model: env.STT_DEEPGRAM_MODEL,
      language: env.STT_DEEPGRAM_LANGUAGE,
      endpointing: "300"
    });

    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${query.toString()}`, {
      headers: {
        Authorization: `Token ${env.STT_DEEPGRAM_API_KEY!}`
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      const onError = () => {
        ws.off("open", onOpen);
        reject(new Error("deepgram_ws_connect_failed"));
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    ws.on("message", async (raw) => {
      try {
        const data = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
        if (!data) {
          return;
        }

        const parsed = JSON.parse(data) as DeepgramMessage;
        const transcript = toTranscriptEvent(parsed);
        if (!transcript || !this.hooks.onTranscript) {
          return;
        }

        await this.hooks.onTranscript(transcript);
      } catch (error) {
        if (this.hooks.onSttError && error instanceof Error) {
          await this.hooks.onSttError(error);
        }
      }
    });

    ws.on("error", async () => {
      if (this.hooks.onSttError) {
        await this.hooks.onSttError(new Error("deepgram_ws_error"));
      }
    });

    this.keepAliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 8_000);

    this.ws = ws;
  }

  async ingestAudio(frame: VoiceInboundAudioFrame): Promise<void> {
    if (this.mode !== "ready" || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const bytes = new Uint8Array(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength);
    this.ws.send(bytes);
  }

  async stop(): Promise<void> {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    if (!this.ws) {
      return;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
      this.ws.close();
    }

    this.ws = null;
    this.hooks = {};
  }
}

class MockSttAdapter implements SttAdapter {
  provider: string;
  mode: "mock" = "mock";

  constructor(provider: string) {
    this.provider = provider;
  }

  async start(_input: VoiceSessionInput, _hooks?: VoiceSessionHooks): Promise<void> {
    return;
  }

  async ingestAudio(_frame: VoiceInboundAudioFrame): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }
}

export function createSttAdapter(provider: string): SttAdapter {
  if (provider === "deepgram") {
    return new DeepgramSttAdapter();
  }
  return new MockSttAdapter(provider || "unknown_stt");
}
