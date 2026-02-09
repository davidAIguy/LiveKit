import { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config.js";

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  tenant_id: z.string().min(1),
  role: z.enum(["internal_admin", "internal_operator", "client_viewer"]),
  is_internal: z.boolean().default(false)
});

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(request.headers.authorization);
  if (!token) {
    reply.code(401).send({
      error: "unauthorized",
      message: "Missing or invalid bearer token"
    });
    return;
  }

  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE
    });
  } catch {
    reply.code(401).send({
      error: "unauthorized",
      message: "Token verification failed"
    });
    return;
  }

  const parse = ClaimsSchema.safeParse(payload);
  if (!parse.success) {
    reply.code(401).send({
      error: "unauthorized",
      message: "Invalid token claims"
    });
    return;
  }

  const claims = parse.data;
  request.auth = {
    userId: claims.sub,
    tenantId: claims.tenant_id,
    role: claims.role,
    isInternal: claims.is_internal
  };
}
