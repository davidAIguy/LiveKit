import { env } from "../../config.js";
import type {
  VoiceAudioPacket,
  VoiceInboundAudioFrame,
  VoiceSessionHooks,
  VoiceSessionInput,
  VoiceSessionRuntime
} from "./types.js";
import { createLiveKitTransport } from "./livekit-transport.js";
import { createSttAdapter } from "./stt.js";
import { createTtsAdapter } from "./tts.js";

export interface VoiceStartResult {
  enabled: boolean;
  started: boolean;
  stt_provider: string;
  stt_mode: string;
  tts_provider: string;
  tts_mode: string;
  transport_mode: string;
}

export interface VoiceSpeakResult {
  enabled: boolean;
  attempted: boolean;
  bytes: number;
  transport_mode?: string;
  packet?: VoiceAudioPacket;
}

export interface VoiceIngestResult {
  ingested: boolean;
  barged_in: boolean;
  energy: number;
}

function computeFrameEnergy(frame: VoiceInboundAudioFrame): number {
  if (frame.samples.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < frame.samples.length; i += 1) {
    const normalized = frame.samples[i] / 32768;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / frame.samples.length);
}

function estimatePacketDurationMs(packet: VoiceAudioPacket): number {
  if (packet.format !== "pcm_s16le" || packet.sampleRateHz <= 0 || packet.channels <= 0) {
    return 0;
  }

  const samples = Math.floor(packet.bytes.byteLength / 2);
  const samplesPerChannel = Math.floor(samples / packet.channels);
  return Math.floor((samplesPerChannel / packet.sampleRateHz) * 1000);
}

class VoiceSessionManager {
  private sessions = new Map<string, VoiceSessionRuntime>();

  async start(input: VoiceSessionInput, hooks?: VoiceSessionHooks): Promise<VoiceStartResult> {
    if (!env.CONNECTOR_VOICE_RUNTIME_ENABLED) {
      return {
        enabled: false,
        started: false,
        stt_provider: input.sttProvider,
        stt_mode: "disabled",
        tts_provider: input.ttsProvider,
        tts_mode: "disabled",
        transport_mode: "disabled"
      };
    }

    const existing = this.sessions.get(input.callId);
    if (existing) {
      return {
        enabled: true,
        started: false,
        stt_provider: existing.stt.provider,
        stt_mode: existing.stt.mode,
        tts_provider: existing.tts.provider,
        tts_mode: existing.tts.mode,
        transport_mode: existing.transport.mode
      };
    }

    const stt = createSttAdapter(input.sttProvider);
    const tts = createTtsAdapter(input.ttsProvider);
    const transport = await createLiveKitTransport();

    try {
      await transport.connect(input, {
        onInboundAudio: async (frame) => {
          try {
            await stt.ingestAudio(frame);
          } catch (error) {
            if (hooks?.onSttError && error instanceof Error) {
              await hooks.onSttError(error);
            }
          }
        }
      });

      try {
        await stt.start(input, hooks);
      } catch (error) {
        if (hooks?.onSttError && error instanceof Error) {
          await hooks.onSttError(error);
        }

        if (env.STT_CONNECT_HARD_FAIL) {
          throw error;
        }
      }
    } catch (error) {
      await stt.stop().catch(() => undefined);
      await transport.disconnect().catch(() => undefined);
      throw error;
    }

    this.sessions.set(input.callId, {
      input,
      hooks,
      stt,
      tts,
      transport,
      startedAt: new Date().toISOString(),
      speakingUntilMs: 0
    });

    return {
      enabled: true,
      started: true,
      stt_provider: stt.provider,
      stt_mode: stt.mode,
      tts_provider: tts.provider,
      tts_mode: tts.mode,
      transport_mode: transport.mode
    };
  }

  async speak(callId: string, text: string): Promise<VoiceSpeakResult> {
    if (!env.CONNECTOR_VOICE_RUNTIME_ENABLED) {
      return { enabled: false, attempted: false, bytes: 0 };
    }

    const runtime = this.sessions.get(callId);
    if (!runtime) {
      return { enabled: true, attempted: false, bytes: 0 };
    }

    const packet = await runtime.tts.synthesize(text);
    await runtime.transport.publishAudio(packet);

    const durationMs = estimatePacketDurationMs(packet);
    runtime.speakingUntilMs = Date.now() + Math.max(durationMs, env.VOICE_BARGE_IN_HOLD_MS);

    return {
      enabled: true,
      attempted: true,
      bytes: packet.bytes.byteLength,
      transport_mode: runtime.transport.mode,
      packet
    };
  }

  async ingestInboundAudio(callId: string, frame: VoiceInboundAudioFrame): Promise<VoiceIngestResult> {
    if (!env.CONNECTOR_VOICE_RUNTIME_ENABLED) {
      return { ingested: false, barged_in: false, energy: 0 };
    }

    const runtime = this.sessions.get(callId);
    if (!runtime) {
      return { ingested: false, barged_in: false, energy: 0 };
    }

    const energy = computeFrameEnergy(frame);
    let bargedIn = false;
    if (
      env.VOICE_BARGE_IN_ENABLED &&
      Date.now() < runtime.speakingUntilMs &&
      energy >= env.VOICE_BARGE_IN_ENERGY_THRESHOLD
    ) {
      await runtime.transport.interruptPlayback();
      runtime.speakingUntilMs = 0;
      bargedIn = true;
      if (runtime.hooks?.onBargeIn) {
        await runtime.hooks.onBargeIn({ reason: "caller_voice_detected", energy });
      }
    }

    await runtime.stt.ingestAudio(frame);
    return {
      ingested: true,
      barged_in: bargedIn,
      energy
    };
  }

  async stop(callId: string): Promise<void> {
    const runtime = this.sessions.get(callId);
    if (!runtime) {
      return;
    }

    await runtime.stt.stop();
    await runtime.tts.stop();
    await runtime.transport.disconnect();
    this.sessions.delete(callId);
  }

  list(): Array<{
    call_id: string;
    trace_id: string;
    room: string;
    stt_provider: string;
    stt_mode: string;
    tts_provider: string;
    tts_mode: string;
    transport_mode: string;
    started_at: string;
  }> {
    return Array.from(this.sessions.values()).map((runtime) => ({
      call_id: runtime.input.callId,
      trace_id: runtime.input.traceId,
      room: runtime.input.room,
      stt_provider: runtime.stt.provider,
      stt_mode: runtime.stt.mode,
      tts_provider: runtime.tts.provider,
      tts_mode: runtime.tts.mode,
      transport_mode: runtime.transport.mode,
      started_at: runtime.startedAt
    }));
  }
}

export const voiceSessionManager = new VoiceSessionManager();
