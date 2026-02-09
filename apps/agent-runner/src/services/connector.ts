import type { FastifyBaseLogger } from "fastify";
import { env } from "../config.js";
import type { LaunchSessionRequest } from "../types.js";

export async function dispatchToAgentConnector(
  payload: LaunchSessionRequest,
  logger: FastifyBaseLogger
): Promise<{ mode: "forwarded" | "noop" }> {
  if (!env.AGENT_CONNECTOR_URL) {
    logger.warn(
      {
        call_id: payload.call_id,
        room: payload.room,
        trace_id: payload.trace_id
      },
      "AGENT_CONNECTOR_URL not set; launch kept in noop mode"
    );
    return { mode: "noop" };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };

  if (env.AGENT_CONNECTOR_AUTH_TOKEN) {
    headers.Authorization = `Bearer ${env.AGENT_CONNECTOR_AUTH_TOKEN}`;
  }

  const response = await fetch(env.AGENT_CONNECTOR_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`connector_launch_failed_${response.status}:${body}`);
  }

  return { mode: "forwarded" };
}
