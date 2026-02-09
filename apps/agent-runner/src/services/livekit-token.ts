import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config.js";

const TokenSchema = z.object({
  sub: z.string().min(1),
  video: z
    .object({
      room: z.string().min(1).optional(),
      roomJoin: z.boolean().optional()
    })
    .optional(),
  metadata: z.string().optional()
});

interface VerifyTokenInput {
  token: string;
  expectedRoom: string;
  expectedAgentId: string;
}

export function verifyAgentJoinToken(input: VerifyTokenInput): { identity: string; metadata?: string } {
  const decoded = jwt.verify(input.token, env.LIVEKIT_API_SECRET, {
    algorithms: ["HS256"]
  });

  const parse = TokenSchema.safeParse(decoded);
  if (!parse.success) {
    throw new Error("invalid_livekit_token_claims");
  }

  const claims = parse.data;
  if (!claims.video?.roomJoin || claims.video.room !== input.expectedRoom) {
    throw new Error("invalid_livekit_room_grants");
  }

  const expectedIdentity = `agent-${input.expectedAgentId}`;
  if (claims.sub !== expectedIdentity) {
    throw new Error("invalid_livekit_identity");
  }

  return {
    identity: claims.sub,
    metadata: claims.metadata
  };
}
