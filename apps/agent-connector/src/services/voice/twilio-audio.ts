import type { VoiceAudioPacket, VoiceInboundAudioFrame } from "./types.js";

const MU_LAW_BIAS = 0x84;
const MU_LAW_CLIP = 32635;

function decodeMuLawByte(input: number): number {
  const mu = (~input) & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  const magnitude = ((mantissa << 3) + MU_LAW_BIAS) << exponent;
  return sign ? MU_LAW_BIAS - magnitude : magnitude - MU_LAW_BIAS;
}

function encodeMuLawSample(sample: number): number {
  let pcm = sample;
  let sign = 0;

  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }

  if (pcm > MU_LAW_CLIP) {
    pcm = MU_LAW_CLIP;
  }

  pcm += MU_LAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function downsample16kTo8k(samples16k: Int16Array): Int16Array {
  if (samples16k.length === 0) {
    return new Int16Array(0);
  }

  const outputLength = Math.floor(samples16k.length / 2);
  const out = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const a = samples16k[i * 2];
    const b = samples16k[i * 2 + 1] ?? a;
    out[i] = Math.round((a + b) / 2);
  }
  return out;
}

function packetToPcm16(packet: VoiceAudioPacket): Int16Array {
  if (packet.format === "pcm_s16le") {
    const buffer = Buffer.from(packet.bytes);
    const byteLength = buffer.byteLength - (buffer.byteLength % 2);
    const out = new Int16Array(byteLength / 2);
    for (let offset = 0; offset < byteLength; offset += 2) {
      out[offset / 2] = buffer.readInt16LE(offset);
    }
    return out;
  }

  return new Int16Array(0);
}

export function decodeTwilioMediaPayload(payloadBase64: string): VoiceInboundAudioFrame {
  const data = Buffer.from(payloadBase64, "base64");
  const pcm8k = new Int16Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    pcm8k[i] = decodeMuLawByte(data[i]);
  }

  return {
    samples: pcm8k,
    sampleRateHz: 8000,
    channels: 1
  };
}

export function encodeTwilioMediaPayload(packet: VoiceAudioPacket): string {
  const pcm = packetToPcm16(packet);
  if (pcm.length === 0) {
    return "";
  }

  const pcm8k = packet.sampleRateHz === 8000 ? pcm : downsample16kTo8k(pcm);
  const out = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i += 1) {
    out[i] = encodeMuLawSample(pcm8k[i]);
  }

  return out.toString("base64");
}
