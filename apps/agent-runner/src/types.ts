import { z } from "zod";

export const LaunchSessionSchema = z.object({
  call_id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  trace_id: z.string().uuid(),
  room: z.string().min(1),
  twilio_call_sid: z.string().min(1),
  livekit_url: z.string().url(),
  agent_join_token: z.string().min(1)
});

export type LaunchSessionRequest = z.infer<typeof LaunchSessionSchema>;
