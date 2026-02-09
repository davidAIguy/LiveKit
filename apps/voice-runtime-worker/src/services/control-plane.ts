import jwt from "jsonwebtoken";
import { env } from "../config.js";

interface ClaimDispatchResult {
  dispatch_id: string;
  call_id: string;
  tenant_id: string;
  agent_id: string;
  trace_id: string;
  room: string;
  twilio_call_sid: string;
  agent_join_token: string;
  expires_at: string;
}

function issueServiceToken(tenantId: string): string {
  if (!env.CONTROL_PLANE_JWT_SECRET) {
    throw new Error("CONTROL_PLANE_JWT_SECRET is missing");
  }

  return jwt.sign(
    {
      sub: "voice-runtime-claimer",
      tenant_id: tenantId,
      role: "internal_operator",
      is_internal: true
    },
    env.CONTROL_PLANE_JWT_SECRET,
    {
      issuer: env.CONTROL_PLANE_JWT_ISSUER,
      audience: env.CONTROL_PLANE_JWT_AUDIENCE,
      expiresIn: "5m"
    }
  );
}

export async function claimRuntimeDispatch(input: {
  dispatchId: string;
  tenantId: string;
}): Promise<ClaimDispatchResult> {
  if (!env.CONTROL_PLANE_BASE_URL) {
    throw new Error("CONTROL_PLANE_BASE_URL is missing");
  }

  const token = issueServiceToken(input.tenantId);
  const response = await fetch(`${env.CONTROL_PLANE_BASE_URL}/internal/runtime/dispatches/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ dispatch_id: input.dispatchId })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`claim_failed_${response.status}:${body}`);
  }

  return (await response.json()) as ClaimDispatchResult;
}
