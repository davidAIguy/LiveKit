export interface VoiceSessionInput {
  callId: string;
  traceId: string;
  room: string;
  livekitUrl: string;
  agentJoinToken: string;
  sttProvider: string;
  ttsProvider: string;
}

export interface VoiceInboundAudioFrame {
  samples: Int16Array;
  sampleRateHz: number;
  channels: number;
}

export interface SttTranscriptEvent {
  text: string;
  isFinal: boolean;
  confidence?: number;
  provider: string;
}

export interface VoiceSessionHooks {
  onTranscript?: (event: SttTranscriptEvent) => Promise<void> | void;
  onSttError?: (error: Error) => Promise<void> | void;
  onBargeIn?: (input: { reason: string; energy: number }) => Promise<void> | void;
}

export interface LiveKitTransportHooks {
  onInboundAudio?: (frame: VoiceInboundAudioFrame) => Promise<void> | void;
}

export interface VoiceAudioPacket {
  bytes: Uint8Array;
  sampleRateHz: number;
  channels: number;
  format: "pcm_s16le" | "opus" | "unknown";
}

export interface SttAdapter {
  provider: string;
  mode: "ready" | "unconfigured" | "mock";
  start(input: VoiceSessionInput, hooks?: VoiceSessionHooks): Promise<void>;
  ingestAudio(frame: VoiceInboundAudioFrame): Promise<void>;
  stop(): Promise<void>;
}

export interface TtsAdapter {
  provider: string;
  mode: "ready" | "unconfigured" | "mock";
  synthesize(text: string): Promise<VoiceAudioPacket>;
  stop(): Promise<void>;
}

export interface LiveKitTransport {
  mode: "mock" | "rtc_node" | "rtc_node_unavailable";
  connect(input: VoiceSessionInput, hooks?: LiveKitTransportHooks): Promise<void>;
  publishAudio(packet: VoiceAudioPacket): Promise<void>;
  interruptPlayback(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface VoiceSessionRuntime {
  input: VoiceSessionInput;
  hooks?: VoiceSessionHooks;
  stt: SttAdapter;
  tts: TtsAdapter;
  transport: LiveKitTransport;
  startedAt: string;
  speakingUntilMs: number;
}
