import { FastifyInstance } from "fastify";
import { env } from "../config.js";
import { dispatchToAgentConnector } from "../services/connector.js";
import { verifyAgentJoinToken } from "../services/livekit-token.js";
import { LaunchSessionSchema } from "../types.js";

const seenLaunches = new Map<string, number>();
const LAUNCH_TTL_MS = 15 * 60 * 1000;

function cleanupSeenLaunches(now: number): void {
  for (const [key, expiresAt] of seenLaunches.entries()) {
    if (expiresAt <= now) {
      seenLaunches.delete(key);
    }
  }
}

function validateRunnerAuth(authorizationHeader: string | undefined): boolean {
  if (!env.RUNNER_AUTH_TOKEN) {
    return true;
  }

  if (!authorizationHeader) {
    return false;
  }

  const [scheme, token] = authorizationHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return false;
  }

  return token === env.RUNNER_AUTH_TOKEN;
}

export async function registerRuntimeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/runtime/agent-sessions/launch", async (request, reply) => {
    if (!validateRunnerAuth(request.headers.authorization)) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid runner auth" });
      return;
    }

    const payload = LaunchSessionSchema.parse(request.body);
    const tokenClaims = verifyAgentJoinToken({
      token: payload.agent_join_token,
      expectedRoom: payload.room,
      expectedAgentId: payload.agent_id
    });

    const dedupeKey = `${payload.call_id}:${payload.trace_id}`;
    const now = Date.now();
    cleanupSeenLaunches(now);

    if (seenLaunches.has(dedupeKey)) {
      reply.send({
        ok: true,
        accepted: true,
        duplicate: true,
        identity: tokenClaims.identity
      });
      return;
    }

    const connector = await dispatchToAgentConnector(payload, app.log);
    seenLaunches.set(dedupeKey, now + LAUNCH_TTL_MS);

    app.log.info(
      {
        call_id: payload.call_id,
        tenant_id: payload.tenant_id,
        agent_id: payload.agent_id,
        trace_id: payload.trace_id,
        room: payload.room,
        connector_mode: connector.mode
      },
      "Agent session launch accepted"
    );

    reply.code(202).send({
      ok: true,
      accepted: true,
      connector_mode: connector.mode,
      identity: tokenClaims.identity
    });
  });

  app.get("/runtime/agent-sessions/launches/stats", async (_request, reply) => {
    reply.send({
      tracked_launches: seenLaunches.size
    });
  });
}
