#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "$ROOT_DIR/apps/control-plane-api/.env" ]; then
  echo "Missing env file: apps/control-plane-api/.env" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/apps/agent-connector/.env" ]; then
  echo "Missing env file: apps/agent-connector/.env" >&2
  exit 1
fi

set -a
source "$ROOT_DIR/apps/control-plane-api/.env"
source "$ROOT_DIR/apps/agent-connector/.env"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required in apps/control-plane-api/.env" >&2
  exit 1
fi

if [ -z "${ENCRYPTION_KEY:-}" ]; then
  echo "ENCRYPTION_KEY is required in apps/control-plane-api/.env" >&2
  exit 1
fi

INTEGRATION_BASE_URL="${INTEGRATION_BASE_URL:-http://localhost:4200/mock-n8n}"
MOCK_SECRET="${MOCK_N8N_AUTH_SECRET:-local-dev-secret}"

echo "Provisioning demo automation tools..."
pushd "$ROOT_DIR/apps/control-plane-api" >/dev/null

RESULT="$({
  DATABASE_URL="$DATABASE_URL" \
  ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  INTEGRATION_BASE_URL="$INTEGRATION_BASE_URL" \
  MOCK_SECRET="$MOCK_SECRET" \
  TENANT_ID="${TENANT_ID:-}" \
  node <<'NODE'
(async () => {
  const pgMod = await import("pg");
  const cryptoMod = await import("node:crypto");
  const Pool = pgMod.default.Pool;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    let tenantId = process.env.TENANT_ID || "";
    if (!tenantId) {
      const callRes = await pool.query("select tenant_id from calls order by started_at desc limit 1");
      if (callRes.rows.length > 0) {
        tenantId = callRes.rows[0].tenant_id;
      }
    }
    if (!tenantId) {
      const tenantRes = await pool.query("select id from tenants order by created_at asc limit 1");
      if (tenantRes.rows.length > 0) {
        tenantId = tenantRes.rows[0].id;
      }
    }
    if (!tenantId) {
      const tenantIns = await pool.query(
        "insert into tenants (name, timezone, plan, status) values ($1, 'UTC', 'starter', 'active') returning id",
        ["Demo Tenant"]
      );
      tenantId = tenantIns.rows[0].id;
    }

    let agentId = "";
    const recentCall = await pool.query(
      "select agent_id from calls where tenant_id = $1 order by started_at desc limit 1",
      [tenantId]
    );
    if (recentCall.rows.length > 0) {
      agentId = recentCall.rows[0].agent_id;
    }
    if (!agentId) {
      const existingAgent = await pool.query(
        "select id from agents where tenant_id = $1 order by created_at asc limit 1",
        [tenantId]
      );
      if (existingAgent.rows.length > 0) {
        agentId = existingAgent.rows[0].id;
      }
    }
    if (!agentId) {
      const agentIns = await pool.query(
        "insert into agents (tenant_id, name, status, language, llm_model, stt_provider, tts_provider) values ($1, $2, 'draft', 'es', 'gpt-4o-mini', 'deepgram', 'rime') returning id",
        [tenantId, "Demo Automation Agent"]
      );
      agentId = agentIns.rows[0].id;
    }

    const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
    const iv = cryptoMod.randomBytes(12);
    const cipher = cryptoMod.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(process.env.MOCK_SECRET, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedSecret = `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;

    const baseUrl = process.env.INTEGRATION_BASE_URL;
    const integrationRes = await pool.query(
      "select id from tenant_integrations where tenant_id = $1 and type = 'n8n_cloud' and base_url = $2 order by created_at desc limit 1",
      [tenantId, baseUrl]
    );

    let integrationId = "";
    if (integrationRes.rows.length > 0) {
      integrationId = integrationRes.rows[0].id;
      await pool.query(
        "update tenant_integrations set auth_type = 'bearer', encrypted_secret = $2, status = 'active', last_test_at = now() where id = $1",
        [integrationId, encryptedSecret]
      );
    } else {
      const integrationIns = await pool.query(
        "insert into tenant_integrations (tenant_id, type, base_url, auth_type, encrypted_secret, status, last_test_at) values ($1, 'n8n_cloud', $2, 'bearer', $3, 'active', now()) returning id",
        [tenantId, baseUrl, encryptedSecret]
      );
      integrationId = integrationIns.rows[0].id;
    }

    const toolDefs = [
      {
        name: "lookup_customer_profile",
        description: "Busca perfil del cliente por customer_id, email o phone",
        schema: {
          type: "object",
          properties: {
            customer_id: { type: "string" },
            email: { type: "string" },
            phone: { type: "string" }
          },
          additionalProperties: false
        },
        method: "POST",
        path: "/customer-lookup"
      },
      {
        name: "fetch_order_status",
        description: "Obtiene estado de un pedido por order_id",
        schema: {
          type: "object",
          required: ["order_id"],
          properties: {
            order_id: { type: "string", minLength: 3 }
          },
          additionalProperties: false
        },
        method: "POST",
        path: "/order-status"
      },
      {
        name: "create_support_ticket",
        description: "Crea ticket de soporte con prioridad",
        schema: {
          type: "object",
          required: ["subject", "message", "priority"],
          properties: {
            customer_id: { type: "string" },
            subject: { type: "string", minLength: 3 },
            message: { type: "string", minLength: 3 },
            priority: { type: "string", enum: ["low", "medium", "high"] }
          },
          additionalProperties: false
        },
        method: "POST",
        path: "/create-ticket"
      }
    ];

    const toolIds = [];
    const toolsOut = [];
    for (const def of toolDefs) {
      const toolRes = await pool.query("select id from tools where tenant_id = $1 and name = $2 limit 1", [
        tenantId,
        def.name
      ]);

      let toolId = "";
      if (toolRes.rows.length > 0) {
        toolId = toolRes.rows[0].id;
        await pool.query(
          "update tools set description = $2, input_schema_json = $3::jsonb, timeout_ms = 5000, max_retries = 1, enabled = true where id = $1",
          [toolId, def.description, JSON.stringify(def.schema)]
        );
      } else {
        const toolIns = await pool.query(
          "insert into tools (tenant_id, name, description, input_schema_json, timeout_ms, max_retries, enabled) values ($1, $2, $3, $4::jsonb, 5000, 1, true) returning id",
          [tenantId, def.name, def.description, JSON.stringify(def.schema)]
        );
        toolId = toolIns.rows[0].id;
      }

      const endpointRes = await pool.query(
        "select id from tool_endpoints where tool_id = $1 and integration_id = $2 and webhook_path = $3 and method = $4 limit 1",
        [toolId, integrationId, def.path, def.method]
      );

      let endpointId = "";
      if (endpointRes.rows.length > 0) {
        endpointId = endpointRes.rows[0].id;
        await pool.query("update tool_endpoints set headers_template = '{}'::jsonb where id = $1", [endpointId]);
      } else {
        const endpointIns = await pool.query(
          "insert into tool_endpoints (tool_id, integration_id, webhook_path, method, headers_template) values ($1, $2, $3, $4, '{}'::jsonb) returning id",
          [toolId, integrationId, def.path, def.method]
        );
        endpointId = endpointIns.rows[0].id;
      }

      toolIds.push(toolId);
      toolsOut.push({
        tool_name: def.name,
        tool_id: toolId,
        endpoint_id: endpointId,
        webhook_path: def.path
      });
    }

    const versionRes = await pool.query(
      "select id from agent_versions where agent_id = $1 and published_at is not null order by published_at desc limit 1",
      [agentId]
    );

    let versionId = "";
    if (versionRes.rows.length > 0) {
      versionId = versionRes.rows[0].id;
    } else {
      const nextVersionRes = await pool.query(
        "select coalesce(max(version), 0) + 1 as next_version from agent_versions where agent_id = $1",
        [agentId]
      );
      const nextVersion = Number(nextVersionRes.rows[0].next_version);

      const versionIns = await pool.query(
        "insert into agent_versions (agent_id, version, system_prompt, temperature, published_at) values ($1, $2, $3, 0.3, now()) returning id",
        [
          agentId,
          nextVersion,
          "Eres un agente de soporte operativo. Usa herramientas cuando aporten precision y confirma datos clave al usuario."
        ]
      );
      versionId = versionIns.rows[0].id;
    }

    await pool.query("delete from agent_tools where agent_version_id = $1", [versionId]);
    await pool.query(
      "insert into agent_tools (agent_version_id, tool_id) select $1, unnest($2::uuid[])",
      [versionId, toolIds]
    );

    console.log(
      JSON.stringify(
        {
          tenant_id: tenantId,
          agent_id: agentId,
          active_version_id: versionId,
          integration_id: integrationId,
          tools: toolsOut
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE
} )"

popd >/dev/null

echo "$RESULT"
echo "Done. Demo tools are provisioned and mapped to the active agent version."
