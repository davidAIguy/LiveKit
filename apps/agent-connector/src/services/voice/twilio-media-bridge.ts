import type { WebSocket } from "ws";
import type { VoiceAudioPacket } from "./types.js";
import { encodeTwilioMediaPayload } from "./twilio-audio.js";

interface TwilioStreamBinding {
  callId: string;
  streamSid: string;
  socket: WebSocket;
}

class TwilioMediaBridge {
  private streamsByCallId = new Map<string, TwilioStreamBinding>();
  private streamsBySocket = new Map<WebSocket, TwilioStreamBinding>();

  bind(input: { callId: string; streamSid: string; socket: WebSocket }): void {
    const existing = this.streamsByCallId.get(input.callId);
    if (existing) {
      this.streamsBySocket.delete(existing.socket);
    }

    const binding: TwilioStreamBinding = {
      callId: input.callId,
      streamSid: input.streamSid,
      socket: input.socket
    };

    this.streamsByCallId.set(input.callId, binding);
    this.streamsBySocket.set(input.socket, binding);
  }

  unbindBySocket(socket: WebSocket): void {
    const binding = this.streamsBySocket.get(socket);
    if (!binding) {
      return;
    }

    this.streamsBySocket.delete(socket);
    const callBinding = this.streamsByCallId.get(binding.callId);
    if (callBinding?.socket === socket) {
      this.streamsByCallId.delete(binding.callId);
    }
  }

  unbindByCallId(callId: string): void {
    const binding = this.streamsByCallId.get(callId);
    if (!binding) {
      return;
    }

    this.streamsByCallId.delete(callId);
    this.streamsBySocket.delete(binding.socket);
  }

  sendAgentAudio(callId: string, packet: VoiceAudioPacket): boolean {
    const binding = this.streamsByCallId.get(callId);
    if (!binding) {
      return false;
    }

    if (binding.socket.readyState !== binding.socket.OPEN) {
      this.unbindByCallId(callId);
      return false;
    }

    const payload = encodeTwilioMediaPayload(packet);
    if (!payload) {
      return false;
    }

    binding.socket.send(
      JSON.stringify({
        event: "media",
        streamSid: binding.streamSid,
        media: {
          payload
        }
      })
    );

    return true;
  }

  clearPlayback(callId: string): boolean {
    const binding = this.streamsByCallId.get(callId);
    if (!binding) {
      return false;
    }

    if (binding.socket.readyState !== binding.socket.OPEN) {
      this.unbindByCallId(callId);
      return false;
    }

    binding.socket.send(
      JSON.stringify({
        event: "clear",
        streamSid: binding.streamSid
      })
    );

    return true;
  }
}

export const twilioMediaBridge = new TwilioMediaBridge();
