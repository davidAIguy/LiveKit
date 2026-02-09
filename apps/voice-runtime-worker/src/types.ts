import { z } from "zod";

export const RuntimeHandoffPayloadSchema = z.object({
  version: z.literal("v1"),
  trace_id: z.string().uuid(),
  source: z.literal("twilio_inbound_webhook"),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  twilio_call_sid: z.string().min(1),
  room: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1)
});

export type RuntimeHandoffPayload = z.infer<typeof RuntimeHandoffPayloadSchema>;

export const RuntimeHandoffDispatchedPayloadSchema = z.object({
  event_id: z.string().uuid(),
  trace_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  room: z.string().min(1),
  livekit_url: z.string().url(),
  dispatch_id: z.string().uuid(),
  dispatch_expires_at: z.string().min(1)
});

export type RuntimeHandoffDispatchedPayload = z.infer<typeof RuntimeHandoffDispatchedPayloadSchema>;

export interface RuntimeEvent {
  id: string;
  call_id: string;
  type: string;
  payload_json: unknown;
  processing_attempts: number;
}

export interface RuntimeLaunchJob {
  id: string;
  call_id: string;
  dispatch_id: string;
  tenant_id: string;
  agent_id: string;
  trace_id: string;
  room: string;
  twilio_call_sid: string;
  livekit_url: string;
  agent_join_token: string;
  attempts: number;
}
