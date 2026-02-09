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

function resampleTo8k(samples: Int16Array, sampleRateHz: number): Int16Array {
  if (samples.length === 0 || sampleRateHz <= 0) {
    return new Int16Array(0);
  }

  if (sampleRateHz === 8000) {
    return samples;
  }

  const outputLength = Math.max(1, Math.round((samples.length * 8000) / sampleRateHz));
  const out = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = (i * sampleRateHz) / 8000;
    const indexA = Math.floor(sourceIndex);
    const indexB = Math.min(samples.length - 1, indexA + 1);
    const fraction = sourceIndex - indexA;
    const sampleA = samples[indexA] ?? 0;
    const sampleB = samples[indexB] ?? sampleA;
    out[i] = Math.round(sampleA + (sampleB - sampleA) * fraction);
  }

  return out;
}

function packetToPcm16(packet: VoiceAudioPacket): Int16Array {
  if (packet.format === "pcm_s16le") {
    const buffer = Buffer.from(packet.bytes);
    const byteLength = buffer.byteLength - (buffer.byteLength % 2);
    const samples = new Int16Array(byteLength / 2);
    for (let offset = 0; offset < byteLength; offset += 2) {
      samples[offset / 2] = buffer.readInt16LE(offset);
    }

    const channels = Math.max(1, packet.channels);
    if (channels === 1) {
      return samples;
    }

    const frames = Math.floor(samples.length / channels);
    const mono = new Int16Array(frames);
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        sum += samples[i * channels + channel];
      }
      mono[i] = Math.round(sum / channels);
    }

    return mono;
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

  const pcm8k = resampleTo8k(pcm, packet.sampleRateHz);
  const out = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i += 1) {
    out[i] = encodeMuLawSample(pcm8k[i]);
  }

  return out.toString("base64");
}
