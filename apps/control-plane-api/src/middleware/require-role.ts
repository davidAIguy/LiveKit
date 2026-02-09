import { FastifyReply, FastifyRequest } from "fastify";
import type { AppRole } from "../types/http.js";

export function requireRole(allowedRoles: AppRole[], internalOnly = false) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = request.auth;
    if (!auth) {
      reply.code(401).send({ error: "unauthorized", message: "No auth context" });
      return;
    }

    if (internalOnly && !auth.isInternal) {
      reply.code(403).send({ error: "forbidden", message: "Internal access required" });
      return;
    }

    if (!allowedRoles.includes(auth.role)) {
      reply.code(403).send({ error: "forbidden", message: "Insufficient role" });
      return;
    }
  };
}

export function requireTenantMatch(requestTenantId: string | undefined, authTenantId: string): boolean {
  if (!requestTenantId) {
    return true;
  }
  return requestTenantId === authTenantId;
}
