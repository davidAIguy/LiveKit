import { env } from "../config.js";

export async function requestAgentSessionLaunch(input: {
  callId: string;
  tenantId: string;
  agentId: string;
  traceId: string;
  room: string;
  twilioCallSid: string;
  livekitUrl: string;
  agentJoinToken: string;
}): Promise<void> {
  if (!env.AGENT_LAUNCHER_URL) {
    throw new Error("AGENT_LAUNCHER_URL is missing");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (env.AGENT_LAUNCHER_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${env.AGENT_LAUNCHER_AUTH_TOKEN}`;
  }

  const response = await fetch(env.AGENT_LAUNCHER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      call_id: input.callId,
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      trace_id: input.traceId,
      room: input.room,
      twilio_call_sid: input.twilioCallSid,
      livekit_url: input.livekitUrl,
      agent_join_token: input.agentJoinToken
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`agent_launcher_failed_${response.status}:${body}`);
  }
}
