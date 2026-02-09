import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireRole } from "../middleware/require-role.js";

const DateRangeQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  agent_id: z.string().uuid().optional()
});

function resolveDateRange(input: z.infer<typeof DateRangeQuery>): { from: string; to: string } {
  const now = new Date();
  const to = input.to ?? now.toISOString();
  const from =
    input.from ??
    new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/client/kpis",
    { preHandler: [requireRole(["client_viewer", "internal_admin", "internal_operator"])] },
    async (request, reply) => {
      const auth = request.auth!;
      const query = DateRangeQuery.parse(request.query);
      const range = resolveDateRange(query);

      const result = await db.query(
        `select day, tenant_id, agent_id, calls, avg_duration_sec, resolution_rate, handoff_rate, total_cost_usd
         from daily_kpis
         where tenant_id = $1
           and day between $2::date and $3::date
           and ($4::uuid is null or agent_id = $4::uuid)
         order by day desc`,
        [auth.tenantId, range.from, range.to, query.agent_id ?? null]
      );

      reply.send({ items: result.rows });
    }
  );

  app.get(
    "/client/calls",
    { preHandler: [requireRole(["client_viewer", "internal_admin", "internal_operator"])] },
    async (request, reply) => {
      const auth = request.auth!;
      const query = DateRangeQuery.parse(request.query);
      const range = resolveDateRange(query);

      const result = await db.query(
        `select id, agent_id, twilio_call_sid, outcome, handoff_reason, legal_hold, started_at, ended_at
         from calls
         where tenant_id = $1
           and started_at between $2::timestamptz and $3::timestamptz
           and ($4::uuid is null or agent_id = $4::uuid)
         order by started_at desc
         limit 200`,
        [auth.tenantId, range.from, range.to, query.agent_id ?? null]
      );

      reply.send({ items: result.rows });
    }
  );

  app.get(
    "/client/calls/:callId",
    { preHandler: [requireRole(["client_viewer", "internal_admin", "internal_operator"])] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z.object({ callId: z.string().uuid() }).parse(request.params);

      const result = await db.query(
        `select id, tenant_id, agent_id, twilio_call_sid, outcome, handoff_reason, legal_hold, started_at, ended_at
         from calls
         where id = $1 and tenant_id = $2`,
        [params.callId, auth.tenantId]
      );

      if (result.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Call not found" });
        return;
      }

      reply.send(result.rows[0]);
    }
  );

  app.get(
    "/client/calls/:callId/transcript",
    { preHandler: [requireRole(["client_viewer", "internal_admin", "internal_operator"])] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z.object({ callId: z.string().uuid() }).parse(request.params);

      const callRes = await db.query(`select id from calls where id = $1 and tenant_id = $2`, [
        params.callId,
        auth.tenantId
      ]);

      if (callRes.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Call not found" });
        return;
      }

      const transcript = await db.query(
        `select speaker, text, start_ms, end_ms, confidence, created_at
         from utterances
         where call_id = $1
         order by start_ms asc`,
        [params.callId]
      );

      reply.send({ items: transcript.rows });
    }
  );

  app.get(
    "/client/calls/:callId/recording",
    { preHandler: [requireRole(["client_viewer", "internal_admin", "internal_operator"])] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z.object({ callId: z.string().uuid() }).parse(request.params);

      const result = await db.query(
        `select r.storage_url, r.duration_sec, r.redacted, r.created_at
         from recordings r
         join calls c on c.id = r.call_id
         where r.call_id = $1 and c.tenant_id = $2`,
        [params.callId, auth.tenantId]
      );

      if (result.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Recording not found" });
        return;
      }

      reply.send(result.rows[0]);
    }
  );
}
