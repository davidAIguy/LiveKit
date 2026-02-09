import { env } from "../../config.js";
import type {
  LiveKitTransport,
  LiveKitTransportHooks,
  VoiceAudioPacket,
  VoiceInboundAudioFrame,
  VoiceSessionInput
} from "./types.js";

interface RtcNodeLike {
  Room: new () => {
    connect: (url: string, token: string) => Promise<void>;
    disconnect: () => Promise<void>;
    localParticipant?: {
      publishTrack: (track: unknown, options: unknown) => Promise<unknown>;
      unpublishTrack: (trackSid: string, stopOnUnpublish?: boolean) => Promise<void>;
    };
    on?: (event: unknown, callback: (...args: unknown[]) => void) => void;
  };
  RoomEvent: {
    TrackSubscribed: unknown;
  };
  TrackKind: {
    KIND_AUDIO: number;
  };
  AudioStream: new (
    track: unknown,
    options: {
      sampleRate: number;
      numChannels: number;
      frameSizeMs: number;
    }
  ) => ReadableStream<{
    data: Int16Array;
    sampleRate: number;
    channels: number;
  }>;
  AudioSource: new (sampleRate: number, channels: number, queueSize?: number) => {
    captureFrame: (frame: unknown) => Promise<void>;
    clearQueue: () => void;
    close: () => Promise<void>;
  };
  AudioFrame: new (
    data: Int16Array,
    sampleRate: number,
    channels: number,
    samplesPerChannel: number
  ) => unknown;
  LocalAudioTrack: {
    createAudioTrack: (
      name: string,
      source: {
        captureFrame: (frame: unknown) => Promise<void>;
        clearQueue: () => void;
        close: () => Promise<void>;
      }
    ) => {
      sid?: string;
      close: (closeSource?: boolean) => Promise<void>;
    };
  };
  TrackPublishOptions: new (data?: Record<string, unknown>) => unknown;
  TrackSource: {
    SOURCE_MICROPHONE: number;
  };
}

function toInt16Samples(packet: VoiceAudioPacket): Int16Array {
  if (packet.format === "pcm_s16le") {
    const raw = Buffer.from(packet.bytes);
    const usableLength = raw.byteLength - (raw.byteLength % 2);
    const samples = new Int16Array(usableLength / 2);
    for (let offset = 0; offset < usableLength; offset += 2) {
      samples[offset / 2] = raw.readInt16LE(offset);
    }
    return samples;
  }

  const sampleRate = Math.max(8000, packet.sampleRateHz);
  const durationMs = 240;
  const totalSamples = Math.floor((sampleRate * durationMs) / 1000);
  const samples = new Int16Array(totalSamples);
  let hash = 0;
  for (const value of packet.bytes) {
    hash = (hash * 33 + value) >>> 0;
  }
  const frequency = 220 + (hash % 180);
  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRate;
    const level = Math.sin(2 * Math.PI * frequency * t) * 0.1;
    samples[i] = Math.round(level * 32767);
  }
  return samples;
}

class MockLiveKitTransport implements LiveKitTransport {
  mode: "mock" | "rtc_node_unavailable";

  constructor(mode: "mock" | "rtc_node_unavailable") {
    this.mode = mode;
  }

  async connect(_input: VoiceSessionInput, _hooks?: LiveKitTransportHooks): Promise<void> {
    return;
  }

  async publishAudio(_packet: VoiceAudioPacket): Promise<void> {
    return;
  }

  async interruptPlayback(): Promise<void> {
    return;
  }

  async disconnect(): Promise<void> {
    return;
  }
}

class RtcNodeLiveKitTransport implements LiveKitTransport {
  mode: "rtc_node" = "rtc_node";
  private rtcNode: RtcNodeLike;
  private room: unknown;
  private source: unknown;
  private track: unknown;
  private hooks: LiveKitTransportHooks = {};
  private audioReaders: Array<ReadableStreamDefaultReader<{ data: Int16Array; sampleRate: number; channels: number }>> =
    [];

  constructor(rtcNode: RtcNodeLike) {
    this.rtcNode = rtcNode;
  }

  async connect(input: VoiceSessionInput, hooks?: LiveKitTransportHooks): Promise<void> {
    this.hooks = hooks ?? {};
    const room = new this.rtcNode.Room();
    await room.connect(input.livekitUrl, input.agentJoinToken);

    if (room.on) {
      room.on(this.rtcNode.RoomEvent.TrackSubscribed, (track: unknown) => {
        const typedTrack = track as { kind?: number };
        if (typedTrack.kind !== this.rtcNode.TrackKind.KIND_AUDIO) {
          return;
        }
        void this.consumeInboundAudioTrack(track);
      });
    }

    const localParticipant = room.localParticipant;
    if (!localParticipant) {
      throw new Error("livekit_local_participant_unavailable");
    }

    const source = new this.rtcNode.AudioSource(16000, 1);
    const track = this.rtcNode.LocalAudioTrack.createAudioTrack("agent-audio", source);
    const publishOptions = new this.rtcNode.TrackPublishOptions({
      source: this.rtcNode.TrackSource.SOURCE_MICROPHONE
    });

    await localParticipant.publishTrack(track, publishOptions);

    this.room = room;
    this.source = source;
    this.track = track;
  }

  private async consumeInboundAudioTrack(track: unknown): Promise<void> {
    const stream = new this.rtcNode.AudioStream(track, {
      sampleRate: 16000,
      numChannels: 1,
      frameSizeMs: 20
    });
    const reader = stream.getReader();
    this.audioReaders.push(reader);

    while (true) {
      let chunk: ReadableStreamReadResult<{ data: Int16Array; sampleRate: number; channels: number }>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }

      if (chunk.done || !chunk.value) {
        break;
      }

      const frame: VoiceInboundAudioFrame = {
        samples: chunk.value.data,
        sampleRateHz: chunk.value.sampleRate,
        channels: chunk.value.channels
      };

      if (this.hooks.onInboundAudio) {
        await this.hooks.onInboundAudio(frame);
      }
    }

    reader.releaseLock();
  }

  async publishAudio(packet: VoiceAudioPacket): Promise<void> {
    if (!this.source) {
      throw new Error("livekit_audio_source_not_initialized");
    }

    const source = this.source as {
      captureFrame: (frame: unknown) => Promise<void>;
    };
    const channels = Math.max(1, packet.channels);
    const samples = toInt16Samples(packet);
    if (samples.length === 0) {
      return;
    }

    const samplesPerChannel = Math.max(1, Math.floor(samples.length / channels));
    const frame = new this.rtcNode.AudioFrame(samples, packet.sampleRateHz, channels, samplesPerChannel);
    await source.captureFrame(frame);
  }

  async interruptPlayback(): Promise<void> {
    if (!this.source) {
      return;
    }

    const source = this.source as { clearQueue: () => void };
    source.clearQueue();
  }

  async disconnect(): Promise<void> {
    for (const reader of this.audioReaders) {
      try {
        await reader.cancel();
      } catch {
        // Ignore reader cancel errors during teardown.
      }
    }
    this.audioReaders = [];

    if (this.room) {
      const room = this.room as { disconnect: () => Promise<void>; localParticipant?: unknown };
      const track = this.track as { sid?: string; close: (closeSource?: boolean) => Promise<void> } | null;

      if (track?.sid && room.localParticipant) {
        const localParticipant = room.localParticipant as {
          unpublishTrack: (trackSid: string, stopOnUnpublish?: boolean) => Promise<void>;
        };
        try {
          await localParticipant.unpublishTrack(track.sid, true);
        } catch {
          // Ignore unpublish errors during teardown.
        }
      }

      if (track) {
        try {
          await track.close(true);
        } catch {
          // Ignore track close errors during teardown.
        }
      }

      try {
        await room.disconnect();
      } catch {
        // Ignore room disconnect errors during teardown.
      }
    }

    if (this.source) {
      try {
        const source = this.source as { close: () => Promise<void> };
        await source.close();
      } catch {
        // Ignore source close errors during teardown.
      }
    }

    this.room = null;
    this.source = null;
    this.track = null;
    this.hooks = {};
  }
}

export async function createLiveKitTransport(): Promise<LiveKitTransport> {
  if (env.CONNECTOR_LIVEKIT_TRANSPORT_MODE === "mock") {
    return new MockLiveKitTransport("mock");
  }

  try {
    const moduleName = "@livekit" + "/rtc-node";
    const rtcNode = (await import(moduleName)) as unknown as RtcNodeLike;
    return new RtcNodeLiveKitTransport(rtcNode);
  } catch {
    return new MockLiveKitTransport("rtc_node_unavailable");
  }
}
