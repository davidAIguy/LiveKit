import { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db.js";
import { requireRole, requireTenantMatch } from "../middleware/require-role.js";
import { encryptSecret } from "../security/crypto.js";
import { testN8nCloudConnection } from "../services/n8n.js";
import {
  executeAutomationTool,
  AutomationRateLimitError,
  AutomationToolForbiddenError,
  AutomationToolNotFoundError
} from "../services/automation.js";
import { validateSchemaDefinition } from "../services/json-schema.js";

const CreateTenantSchema = z.object({
  name: z.string().min(2),
  timezone: z.string().default("UTC"),
  plan: z.string().default("starter")
});

const CreateAgentSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(2),
  language: z.string().default("es"),
  llm_model: z.string().default("gpt-4o-mini"),
  stt_provider: z.string().default("deepgram"),
  tts_provider: z.string().default("rime"),
  voice_id: z.string().optional()
});

const CreateVersionSchema = z.object({
  system_prompt: z.string().min(10),
  temperature: z.number().min(0).max(2).default(0.3)
});

const CreateIntegrationSchema = z.object({
  tenant_id: z.string().uuid(),
  base_url: z.string().url(),
  auth_type: z.enum(["api_key", "bearer"]),
  secret: z.string().min(1)
});

const CreateToolSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(2),
  description: z.string().min(5),
  input_schema_json: z.record(z.string(), z.unknown()),
  timeout_ms: z.number().int().positive().default(5000),
  max_retries: z.number().int().min(0).max(5).default(1)
});

const CreateToolEndpointSchema = z.object({
  integration_id: z.string().uuid(),
  webhook_path: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers_template: z.record(z.string(), z.unknown()).default({})
});

const ExecuteAutomationToolBodySchema = z.object({
  call_id: z.string().uuid(),
  input_json: z.unknown(),
  trace_id: z.string().uuid().optional()
});

const AutomationToolCatalogQuerySchema = z.object({
  call_id: z.string().uuid()
});

const SetVersionToolsSchema = z.object({
  tool_ids: z.array(z.string().uuid()).max(100)
});

const ClaimRuntimeDispatchSchema = z.object({
  dispatch_id: z.string().uuid()
});

const ListInternalCallsQuerySchema = z.object({
  tenant_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200)
});

const ListInternalAgentsQuerySchema = z.object({
  tenant_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200)
});

export async function registerInternalRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/internal/tenants",
    { preHandler: [requireRole(["internal_admin"], true)] },
    async (request, reply) => {
      const body = CreateTenantSchema.parse(request.body);
      const result = await db.query(
        `insert into tenants (name, timezone, plan)
         values ($1, $2, $3)
         returning id, name, status, timezone, plan, created_at`,
        [body.name, body.timezone, body.plan]
      );
      reply.code(201).send(result.rows[0]);
    }
  );

  app.get(
    "/internal/calls",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const query = ListInternalCallsQuerySchema.parse(request.query);

      let tenantFilter: string | null = null;
      if (auth.role === "internal_admin") {
        tenantFilter = query.tenant_id ?? null;
      } else {
        if (query.tenant_id && query.tenant_id !== auth.tenantId) {
          reply.code(403).send({ error: "forbidden", message: "Cross-tenant read blocked" });
          return;
        }
        tenantFilter = auth.tenantId;
      }

      const result = await db.query(
        `select id, tenant_id, agent_id, twilio_call_sid, outcome, handoff_reason, legal_hold, started_at, ended_at
         from calls
         where ($1::uuid is null or tenant_id = $1::uuid)
         order by started_at desc
         limit $2`,
        [tenantFilter, query.limit]
      );

      reply.send({ items: result.rows });
    }
  );

  app.get(
    "/internal/tenants",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (_request, reply) => {
      const result = await db.query(
        `select id, name, status, timezone, plan, created_at
         from tenants
         order by created_at desc`
      );
      reply.send({ items: result.rows });
    }
  );

  app.get(
    "/internal/agents",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const query = ListInternalAgentsQuerySchema.parse(request.query);

      let tenantFilter: string | null = null;
      if (auth.role === "internal_admin") {
        tenantFilter = query.tenant_id ?? null;
      } else {
        if (query.tenant_id && query.tenant_id !== auth.tenantId) {
          reply.code(403).send({ error: "forbidden", message: "Cross-tenant read blocked" });
          return;
        }
        tenantFilter = auth.tenantId;
      }

      const result = await db.query(
        `select id, tenant_id, name, status, language, llm_model, stt_provider, tts_provider, voice_id, created_at
         from agents
         where ($1::uuid is null or tenant_id = $1::uuid)
         order by created_at desc
         limit $2`,
        [tenantFilter, query.limit]
      );

      reply.send({ items: result.rows });
    }
  );

  app.post(
    "/internal/agents",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const body = CreateAgentSchema.parse(request.body);
      const auth = request.auth!;
      if (!requireTenantMatch(body.tenant_id, auth.tenantId) && auth.role !== "internal_admin") {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant write blocked" });
        return;
      }

      const result = await db.query(
        `insert into agents (tenant_id, name, language, llm_model, stt_provider, tts_provider, voice_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, tenant_id, name, status, language, llm_model, stt_provider, tts_provider, voice_id, created_at`,
        [
          body.tenant_id,
          body.name,
          body.language,
          body.llm_model,
          body.stt_provider,
          body.tts_provider,
          body.voice_id ?? null
        ]
      );

      reply.code(201).send(result.rows[0]);
    }
  );

  app.post(
    "/internal/agents/:agentId/versions",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const params = z.object({ agentId: z.string().uuid() }).parse(request.params);
      const body = CreateVersionSchema.parse(request.body);

      const currentVersionRes = await db.query(
        `select coalesce(max(version), 0) as max_version from agent_versions where agent_id = $1`,
        [params.agentId]
      );
      const nextVersion = Number(currentVersionRes.rows[0].max_version) + 1;

      const result = await db.query(
        `insert into agent_versions (agent_id, version, system_prompt, temperature)
         values ($1, $2, $3, $4)
         returning id, agent_id, version, system_prompt, temperature, published_at, created_at`,
        [params.agentId, nextVersion, body.system_prompt, body.temperature]
      );

      reply.code(201).send(result.rows[0]);
    }
  );

  app.get(
    "/internal/agents/:agentId/versions",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z.object({ agentId: z.string().uuid() }).parse(request.params);

      const agentRes = await db.query(`select id, tenant_id from agents where id = $1`, [params.agentId]);
      if (agentRes.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Agent not found" });
        return;
      }

      const agent = agentRes.rows[0] as { tenant_id: string };
      if (auth.role !== "internal_admin" && agent.tenant_id !== auth.tenantId) {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant read blocked" });
        return;
      }

      const result = await db.query(
        `select av.id,
                av.agent_id,
                av.version,
                av.system_prompt,
                av.temperature,
                av.published_at,
                av.created_at,
                coalesce(array_agg(at.tool_id) filter (where at.tool_id is not null), '{}'::uuid[]) as tool_ids
         from agent_versions av
         left join agent_tools at on at.agent_version_id = av.id
         where av.agent_id = $1
         group by av.id
         order by av.version desc`,
        [params.agentId]
      );

      reply.send({ items: result.rows });
    }
  );

  app.post(
    "/internal/agents/:agentId/versions/:versionId/publish",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const params = z
        .object({
          agentId: z.string().uuid(),
          versionId: z.string().uuid()
        })
        .parse(request.params);

      await db.query("begin");
      try {
        await db.query(`update agent_versions set published_at = null where agent_id = $1`, [params.agentId]);
        const result = await db.query(
          `update agent_versions
           set published_at = now()
           where id = $1 and agent_id = $2
           returning id, agent_id, version, published_at`,
          [params.versionId, params.agentId]
        );
        await db.query("commit");
        reply.send(result.rows[0] ?? null);
      } catch (error) {
        await db.query("rollback");
        throw error;
      }
    }
  );

  app.post(
    "/internal/agents/:agentId/versions/:versionId/tools",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z
        .object({
          agentId: z.string().uuid(),
          versionId: z.string().uuid()
        })
        .parse(request.params);
      const body = SetVersionToolsSchema.parse(request.body);

      const versionRes = await db.query(
        `select av.id, av.agent_id, a.tenant_id
         from agent_versions av
         join agents a on a.id = av.agent_id
         where av.id = $1 and av.agent_id = $2
         limit 1`,
        [params.versionId, params.agentId]
      );

      if (versionRes.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Agent version not found" });
        return;
      }

      const version = versionRes.rows[0] as { id: string; agent_id: string; tenant_id: string };
      if (auth.role !== "internal_admin" && version.tenant_id !== auth.tenantId) {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant write blocked" });
        return;
      }

      if (body.tool_ids.length > 0) {
        const toolValidationRes = await db.query(
          `select id
           from tools
           where tenant_id = $1 and id = any($2::uuid[])`,
          [version.tenant_id, body.tool_ids]
        );
        if (toolValidationRes.rows.length !== body.tool_ids.length) {
          reply.code(400).send({
            error: "invalid_tool_set",
            message: "All tools must exist in the same tenant as the agent version"
          });
          return;
        }
      }

      await db.query("begin");
      try {
        await db.query(`delete from agent_tools where agent_version_id = $1`, [params.versionId]);

        if (body.tool_ids.length > 0) {
          await db.query(
            `insert into agent_tools (agent_version_id, tool_id)
             select $1, unnest($2::uuid[])`,
            [params.versionId, body.tool_ids]
          );
        }

        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw error;
      }

      reply.send({
        ok: true,
        agent_id: params.agentId,
        version_id: params.versionId,
        assigned_tool_ids: body.tool_ids
      });
    }
  );

  app.post(
    "/internal/integrations/n8n/test",
    { preHandler: [requireRole(["internal_admin"], true)] },
    async (request, reply) => {
      const body = CreateIntegrationSchema.parse(request.body);

      const testResult = await testN8nCloudConnection({
        baseUrl: body.base_url,
        authType: body.auth_type,
        secret: body.secret
      });

      if (!testResult.ok) {
        reply.code(400).send({
          ok: false,
          error: "n8n_connection_failed",
          details: testResult
        });
        return;
      }

      const encryptedSecret = encryptSecret(body.secret);
      const result = await db.query(
        `insert into tenant_integrations (tenant_id, type, base_url, auth_type, encrypted_secret, last_test_at)
         values ($1, 'n8n_cloud', $2, $3, $4, now())
         returning id, tenant_id, type, base_url, auth_type, status, last_test_at, created_at`,
        [body.tenant_id, body.base_url, body.auth_type, encryptedSecret]
      );
      reply.code(201).send({ ok: true, test: testResult, integration: result.rows[0] });
    }
  );

  app.post(
    "/internal/tools",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const body = CreateToolSchema.parse(request.body);

      if (!requireTenantMatch(body.tenant_id, auth.tenantId) && auth.role !== "internal_admin") {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant write blocked" });
        return;
      }

      const schemaIssues = validateSchemaDefinition(body.input_schema_json);
      if (schemaIssues.length > 0) {
        reply.code(400).send({
          error: "invalid_tool_schema",
          message: "input_schema_json contains unsupported or invalid JSON Schema fields",
          details: schemaIssues
        });
        return;
      }

      const result = await db.query(
        `insert into tools (tenant_id, name, description, input_schema_json, timeout_ms, max_retries)
         values ($1, $2, $3, $4::jsonb, $5, $6)
         returning id, tenant_id, name, description, input_schema_json, timeout_ms, max_retries, enabled, created_at`,
        [
          body.tenant_id,
          body.name,
          body.description,
          JSON.stringify(body.input_schema_json),
          body.timeout_ms,
          body.max_retries
        ]
      );

      reply.code(201).send(result.rows[0]);
    }
  );

  app.post(
    "/internal/tools/:toolId/endpoints",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z.object({ toolId: z.string().uuid() }).parse(request.params);
      const body = CreateToolEndpointSchema.parse(request.body);

      const toolResult = await db.query(`select id, tenant_id from tools where id = $1`, [params.toolId]);
      if (toolResult.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Tool not found" });
        return;
      }

      const tool = toolResult.rows[0] as { id: string; tenant_id: string };

      const integrationResult = await db.query(
        `select id, tenant_id from tenant_integrations where id = $1 and type = 'n8n_cloud'`,
        [body.integration_id]
      );
      if (integrationResult.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Integration not found" });
        return;
      }

      const integration = integrationResult.rows[0] as { id: string; tenant_id: string };
      if (integration.tenant_id !== tool.tenant_id) {
        reply.code(400).send({
          error: "tenant_mismatch",
          message: "Tool and integration must belong to same tenant"
        });
        return;
      }

      if (auth.role !== "internal_admin" && tool.tenant_id !== auth.tenantId) {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant write blocked" });
        return;
      }

      const result = await db.query(
        `insert into tool_endpoints (tool_id, integration_id, webhook_path, method, headers_template)
         values ($1, $2, $3, $4, $5::jsonb)
         returning id, tool_id, integration_id, webhook_path, method, headers_template, created_at`,
        [
          params.toolId,
          body.integration_id,
          body.webhook_path,
          body.method,
          JSON.stringify(body.headers_template)
        ]
      );

      reply.code(201).send(result.rows[0]);
    }
  );

  app.get(
    "/internal/automation/tools/catalog",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const query = AutomationToolCatalogQuerySchema.parse(request.query);

      const callResult = await db.query(`select id, tenant_id from calls where id = $1`, [query.call_id]);
      if (callResult.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Call not found" });
        return;
      }

      const call = callResult.rows[0] as { id: string; tenant_id: string };
      if (auth.role !== "internal_admin" && call.tenant_id !== auth.tenantId) {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant read blocked" });
        return;
      }

      const tenantId = auth.role === "internal_admin" ? call.tenant_id : auth.tenantId;

      const callAgentRes = await db.query(`select agent_id from calls where id = $1 and tenant_id = $2`, [
        query.call_id,
        tenantId
      ]);
      if (callAgentRes.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Call not found" });
        return;
      }
      const callAgent = callAgentRes.rows[0] as { agent_id: string };

      const mappingJoin =
        env.AUTOMATION_REQUIRE_AGENT_TOOL_MAPPING
          ? `join active_version av on true
             join agent_tools at on at.agent_version_id = av.id and at.tool_id = t.id`
          : "";

      const result = await db.query(
        `with active_version as (
           select id
           from agent_versions
           where agent_id = $2
             and published_at is not null
           order by published_at desc
           limit 1
         )
         select distinct on (t.id)
           t.id,
           t.name,
           t.description,
           t.input_schema_json,
           t.timeout_ms,
           t.max_retries,
           te.method,
           te.webhook_path,
           te.headers_template
         from tools t
         join tool_endpoints te on te.tool_id = t.id
         join tenant_integrations ti on ti.id = te.integration_id and ti.status = 'active'
         ${mappingJoin}
         where t.tenant_id = $1 and t.enabled = true
         order by t.id, te.created_at desc`,
        [tenantId, callAgent.agent_id]
      );

      reply.send({ items: result.rows });
    }
  );

  app.post(
    "/internal/automation/tools/by-name/:toolName/execute",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z
        .object({
          toolName: z
            .string()
            .min(2)
            .max(120)
            .regex(/^[a-zA-Z0-9_-]+$/, "toolName must use alphanumeric, _ or -")
        })
        .parse(request.params);
      const body = ExecuteAutomationToolBodySchema.parse(request.body);

      const callResult = await db.query(`select id, tenant_id from calls where id = $1`, [body.call_id]);
      if (callResult.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Call not found" });
        return;
      }

      const call = callResult.rows[0] as { id: string; tenant_id: string };
      if (auth.role !== "internal_admin" && call.tenant_id !== auth.tenantId) {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant execute blocked" });
        return;
      }

      const tenantId = auth.role === "internal_admin" ? call.tenant_id : auth.tenantId;

      try {
        const result = await executeAutomationTool({
          tenantId,
          callId: body.call_id,
          traceId: body.trace_id,
          toolName: params.toolName,
          inputJson: body.input_json
        });

        if (!result.ok) {
          const statusCode = result.status === "timeout" ? 504 : 422;
          reply.code(statusCode).send(result);
          return;
        }

        reply.send(result);
      } catch (error) {
        if (error instanceof AutomationToolNotFoundError) {
          reply.code(404).send({ error: "not_found", message: "Tool endpoint not configured" });
          return;
        }
        if (error instanceof AutomationToolForbiddenError) {
          reply.code(403).send({ error: "forbidden", message: "Tool is not allowed for this call agent" });
          return;
        }
        if (error instanceof AutomationRateLimitError) {
          reply.code(429).send({ error: "rate_limited", message: "Tool execution rate limit exceeded for call" });
          return;
        }
        throw error;
      }
    }
  );

  app.post(
    "/internal/automation/tools/:toolId/execute",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z.object({ toolId: z.string().uuid() }).parse(request.params);
      const body = ExecuteAutomationToolBodySchema.parse(request.body);

      const callResult = await db.query(`select id, tenant_id from calls where id = $1`, [body.call_id]);
      if (callResult.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Call not found" });
        return;
      }

      const call = callResult.rows[0] as { id: string; tenant_id: string };
      if (auth.role !== "internal_admin" && call.tenant_id !== auth.tenantId) {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant execute blocked" });
        return;
      }

      const tenantId = auth.role === "internal_admin" ? call.tenant_id : auth.tenantId;

      try {
        const result = await executeAutomationTool({
          tenantId,
          callId: body.call_id,
          traceId: body.trace_id,
          toolId: params.toolId,
          inputJson: body.input_json
        });

        if (!result.ok) {
          const statusCode = result.status === "timeout" ? 504 : 422;
          reply.code(statusCode).send(result);
          return;
        }

        reply.send(result);
      } catch (error) {
        if (error instanceof AutomationToolNotFoundError) {
          reply.code(404).send({ error: "not_found", message: "Tool endpoint not configured" });
          return;
        }
        if (error instanceof AutomationToolForbiddenError) {
          reply.code(403).send({ error: "forbidden", message: "Tool is not allowed for this call agent" });
          return;
        }
        if (error instanceof AutomationRateLimitError) {
          reply.code(429).send({ error: "rate_limited", message: "Tool execution rate limit exceeded for call" });
          return;
        }
        throw error;
      }
    }
  );

  app.post(
    "/internal/runtime/dispatches/claim",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const body = ClaimRuntimeDispatchSchema.parse(request.body);
      const auth = request.auth!;

      const claimResult = await db.query(
        `with candidate as (
           select
             id,
             call_id,
             tenant_id,
             agent_id,
             trace_id,
             room,
             twilio_call_sid,
             agent_join_token,
             expires_at
           from runtime_dispatches
           where id = $1
             and tenant_id = $2
             and status = 'pending'
             and expires_at > now()
           for update skip locked
         ), claimed as (
           update runtime_dispatches rd
           set status = 'claimed',
               claimed_at = now(),
               agent_join_token = ''
           from candidate c
           where rd.id = c.id
           returning rd.id
         )
         select
           c.id,
           c.call_id,
           c.tenant_id,
           c.agent_id,
           c.trace_id,
           c.room,
           c.twilio_call_sid,
           c.agent_join_token,
           c.expires_at
         from candidate c
         join claimed cl on cl.id = c.id`,
        [body.dispatch_id, auth.tenantId]
      );

      if (claimResult.rows.length === 0) {
        const stateResult = await db.query(
          `select id, status, expires_at
           from runtime_dispatches
           where id = $1 and tenant_id = $2`,
          [body.dispatch_id, auth.tenantId]
        );

        if (stateResult.rows.length === 0) {
          reply.code(404).send({ error: "not_found", message: "Dispatch not found" });
          return;
        }

        const state = stateResult.rows[0] as { status: string; expires_at: string };
        if (state.status !== "pending") {
          reply.code(409).send({ error: "dispatch_unavailable", message: `Dispatch is ${state.status}` });
          return;
        }

        reply.code(410).send({ error: "dispatch_expired", message: "Dispatch expired" });
        return;
      }

      const dispatch = claimResult.rows[0] as {
        id: string;
        call_id: string;
        tenant_id: string;
        agent_id: string;
        trace_id: string;
        room: string;
        twilio_call_sid: string;
        agent_join_token: string;
        expires_at: string;
      };

      reply.send({
        dispatch_id: dispatch.id,
        call_id: dispatch.call_id,
        tenant_id: dispatch.tenant_id,
        agent_id: dispatch.agent_id,
        trace_id: dispatch.trace_id,
        room: dispatch.room,
        twilio_call_sid: dispatch.twilio_call_sid,
        agent_join_token: dispatch.agent_join_token,
        expires_at: dispatch.expires_at
      });
    }
  );

  app.post(
    "/internal/calls/:callId/legal-hold",
    { preHandler: [requireRole(["internal_admin"], true)] },
    async (request, reply) => {
      const params = z.object({ callId: z.string().uuid() }).parse(request.params);
      const body = z.object({ legal_hold: z.boolean(), reason: z.string().min(3) }).parse(request.body);

      const updatedCall = await db.query(
        `update calls
         set legal_hold = $2
         where id = $1
         returning id, legal_hold`,
        [params.callId, body.legal_hold]
      );

      await db.query(
        `insert into audit_logs (action, resource_type, resource_id, reason, payload_json, actor_user_id)
         values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          "legal_hold.updated",
          "call",
          params.callId,
          body.reason,
          JSON.stringify({ legal_hold: body.legal_hold }),
          request.auth!.userId
        ]
      );

      reply.send({ ok: true, call: updatedCall.rows[0] ?? null });
    }
  );

  app.get(
    "/internal/calls/:callId/events",
    { preHandler: [requireRole(["internal_admin", "internal_operator"], true)] },
    async (request, reply) => {
      const auth = request.auth!;
      const params = z.object({ callId: z.string().uuid() }).parse(request.params);

      const callRes = await db.query(`select id, tenant_id from calls where id = $1`, [params.callId]);
      if (callRes.rows.length === 0) {
        reply.code(404).send({ error: "not_found", message: "Call not found" });
        return;
      }

      const call = callRes.rows[0] as { tenant_id: string };
      if (auth.role !== "internal_admin" && call.tenant_id !== auth.tenantId) {
        reply.code(403).send({ error: "forbidden", message: "Cross-tenant read blocked" });
        return;
      }

      const eventsRes = await db.query(
        `select id, ts, type, payload_json, processing_attempts, processed_at, last_error
         from call_events
         where call_id = $1
         order by ts asc`,
        [params.callId]
      );

      reply.send({ items: eventsRes.rows });
    }
  );
}
