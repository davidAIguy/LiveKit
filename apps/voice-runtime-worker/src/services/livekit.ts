import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { env } from "../config.js";
import type { RuntimeHandoffPayload } from "../types.js";

const roomService = new RoomServiceClient(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

function isRoomAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.toLowerCase().includes("already exists");
}

export async function ensureLiveKitRoom(roomName: string): Promise<void> {
  if (env.LIVEKIT_MOCK_MODE) {
    return;
  }

  try {
    await roomService.createRoom({
      name: roomName,
      emptyTimeout: 10 * 60,
      maxParticipants: 5
    });
  } catch (error) {
    if (!isRoomAlreadyExistsError(error)) {
      throw error;
    }
  }
}

export async function prepareAgentJoinToken(payload: RuntimeHandoffPayload): Promise<string> {
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: `agent-${payload.agent_id}`,
    ttl: "10m",
    metadata: JSON.stringify({
      tenant_id: payload.tenant_id,
      agent_id: payload.agent_id,
      call_sid: payload.twilio_call_sid,
      trace_id: payload.trace_id
    })
  });

  token.addGrant({
    room: payload.room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true
  });

  return token.toJwt();
}
