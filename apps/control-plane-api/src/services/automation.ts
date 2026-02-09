import { db } from "../db.js";
import { env } from "../config.js";
import { decryptSecret } from "../security/crypto.js";
import { validateInputAgainstSchema } from "./json-schema.js";

type IntegrationAuthType = "api_key" | "bearer";
type ToolExecutionStatus = "success" | "error" | "timeout";

interface ToolRuntimeConfig {
  toolId: string;
  toolName: string;
  timeoutMs: number;
  maxRetries: number;
  inputSchemaJson: unknown;
  method: string;
  webhookPath: string;
  headersTemplate: unknown;
  baseUrl: string;
  authType: IntegrationAuthType;
  encryptedSecret: string;
}

interface ExecuteToolInput {
  tenantId: string;
  callId: string;
  traceId?: string;
  toolId?: string;
  toolName?: string;
  inputJson: unknown;
}

interface ToolExecutionResult {
  ok: boolean;
  tool_id: string;
  tool_name: string;
  execution_id: string;
  status: ToolExecutionStatus;
  attempts: number;
  latency_ms: number;
  response_json: unknown;
  error_code: string | null;
}

interface OutboundAttemptResult {
  status: ToolExecutionStatus;
  responseJson: unknown;
  errorCode: string | null;
  attempts: number;
  latencyMs: number;
}

export class AutomationToolNotFoundError extends Error {
  constructor(message = "automation_tool_not_found") {
    super(message);
    this.name = "AutomationToolNotFoundError";
  }
}

export class AutomationToolForbiddenError extends Error {
  constructor(message = "automation_tool_forbidden") {
    super(message);
    this.name = "AutomationToolForbiddenError";
  }
}

export class AutomationRateLimitError extends Error {
  constructor(message = "automation_rate_limit_exceeded") {
    super(message);
    this.name = "AutomationRateLimitError";
  }
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeWebhookPath(value: string): string {
  if (value.startsWith("/")) {
    return value;
  }
  return `/${value}`;
}

function buildIntegrationHeaders(authType: IntegrationAuthType, secret: string): Record<string, string> {
  if (authType === "api_key") {
    return {
      "X-N8N-API-KEY": secret,
      Accept: "application/json"
    };
  }

  return {
    Authorization: `Bearer ${secret}`,
    Accept: "application/json"
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function templateHeaders(headersTemplate: unknown): Record<string, string> {
  if (!isPlainObject(headersTemplate)) {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersTemplate)) {
    if (typeof value === "string") {
      headers[key] = value;
      continue;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      headers[key] = String(value);
    }
  }

  return headers;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return { parse_error: "invalid_json_response" };
    }
  }

  const text = await response.text();
  if (!text) {
    return null;
  }
  return { text };
}

function buildUrl(runtime: ToolRuntimeConfig, inputJson: unknown): string {
  const endpoint = `${normalizeBaseUrl(runtime.baseUrl)}${normalizeWebhookPath(runtime.webhookPath)}`;
  const method = runtime.method.toUpperCase();
  if (method !== "GET" || !isPlainObject(inputJson)) {
    return endpoint;
  }

  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(inputJson)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      url.searchParams.set(key, String(value));
      continue;
    }

    url.searchParams.set(key, JSON.stringify(value));
  }

  return url.toString();
}

async function runOutboundRequest(runtime: ToolRuntimeConfig, inputJson: unknown): Promise<OutboundAttemptResult> {
  const method = runtime.method.toUpperCase();
  const timeoutMs = Math.max(100, runtime.timeoutMs);
  const maxRetries = Math.max(0, runtime.maxRetries);
  const secret = decryptSecret(runtime.encryptedSecret);
  const baseHeaders = {
    ...buildIntegrationHeaders(runtime.authType, secret),
    ...templateHeaders(runtime.headersTemplate)
  };
  const url = buildUrl(runtime, inputJson);
  const overallStartedAt = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        url,
        {
          method,
          headers:
            method === "GET"
              ? baseHeaders
              : {
                  ...baseHeaders,
                  "Content-Type": "application/json"
                },
          body: method === "GET" ? undefined : JSON.stringify(inputJson)
        },
        timeoutMs
      );

      const parsedBody = await parseResponseBody(response);
      if (response.ok) {
        return {
          status: "success",
          responseJson: parsedBody,
          errorCode: null,
          attempts: attempt + 1,
          latencyMs: Date.now() - overallStartedAt
        };
      }

      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        continue;
      }

      return {
        status: "error",
        responseJson: {
          http_status: response.status,
          body: parsedBody
        },
        errorCode: `http_${response.status}`,
        attempts: attempt + 1,
        latencyMs: Date.now() - overallStartedAt
      };
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError";
      if (attempt < maxRetries) {
        continue;
      }

      return {
        status: isTimeout ? "timeout" : "error",
        responseJson: {
          message: error instanceof Error ? error.message : "network_error"
        },
        errorCode: isTimeout ? "request_timeout" : "network_error",
        attempts: attempt + 1,
        latencyMs: Date.now() - overallStartedAt
      };
    }
  }

  return {
    status: "error",
    responseJson: { message: "unknown_gateway_error" },
    errorCode: "unknown_gateway_error",
    attempts: maxRetries + 1,
    latencyMs: Date.now() - overallStartedAt
  };
}

async function loadToolRuntimeConfig(input: ExecuteToolInput): Promise<ToolRuntimeConfig> {
  if (!input.toolId && !input.toolName) {
    throw new AutomationToolNotFoundError("tool_selector_missing");
  }

  const filterSql = input.toolId ? "t.id = $3::uuid" : "t.name = $3";
  const filterValue = input.toolId ?? input.toolName;
  const mappingJoin = env.AUTOMATION_REQUIRE_AGENT_TOOL_MAPPING
    ? `join active_version av on true
       join agent_tools at on at.agent_version_id = av.id and at.tool_id = t.id`
    : "left join active_version av on true";

  const result = await db.query(
    `with call_context as (
       select id, tenant_id, agent_id
       from calls
       where id = $2 and tenant_id = $1
       limit 1
     ), active_version as (
       select av.id
       from agent_versions av
       join call_context c on c.agent_id = av.agent_id
       where av.published_at is not null
       order by av.published_at desc
       limit 1
     )
     select
       t.id as tool_id,
       t.name as tool_name,
       t.timeout_ms,
       t.max_retries,
       t.input_schema_json,
       te.method,
       te.webhook_path,
       te.headers_template,
       ti.base_url,
       ti.auth_type,
       ti.encrypted_secret
     from call_context c
     join tools t on t.tenant_id = c.tenant_id
     join tool_endpoints te on te.tool_id = t.id
     join tenant_integrations ti on ti.id = te.integration_id and ti.status = 'active'
     ${mappingJoin}
     where t.enabled = true
       and ${filterSql}
     order by te.created_at desc
     limit 1`,
    [input.tenantId, input.callId, filterValue]
  );

  if (result.rows.length === 0) {
    if (env.AUTOMATION_REQUIRE_AGENT_TOOL_MAPPING) {
      const visibilityCheck = await db.query(
        `select t.id
         from calls c
         join tools t on t.tenant_id = c.tenant_id
         where c.id = $2
           and c.tenant_id = $1
           and t.enabled = true
           and ${filterSql}
         limit 1`,
        [input.tenantId, input.callId, filterValue]
      );

      if (visibilityCheck.rows.length > 0) {
        throw new AutomationToolForbiddenError("tool_not_mapped_to_active_agent_version");
      }
    }

    throw new AutomationToolNotFoundError();
  }

  const row = result.rows[0] as {
    tool_id: string;
    tool_name: string;
    timeout_ms: number;
    max_retries: number;
    input_schema_json: unknown;
    method: string;
    webhook_path: string;
    headers_template: unknown;
    base_url: string;
    auth_type: IntegrationAuthType;
    encrypted_secret: string;
  };

  return {
    toolId: row.tool_id,
    toolName: row.tool_name,
    timeoutMs: row.timeout_ms,
    maxRetries: row.max_retries,
    inputSchemaJson: row.input_schema_json,
    method: row.method,
    webhookPath: row.webhook_path,
    headersTemplate: row.headers_template,
    baseUrl: row.base_url,
    authType: row.auth_type,
    encryptedSecret: row.encrypted_secret
  };
}

async function assertRateLimit(callId: string): Promise<void> {
  const result = await db.query(
    `select count(*)::int as executions_last_minute
     from tool_executions
     where call_id = $1
       and created_at >= now() - interval '1 minute'`,
    [callId]
  );

  const executionsLastMinute = Number((result.rows[0] as { executions_last_minute: number }).executions_last_minute);
  if (executionsLastMinute >= env.AUTOMATION_MAX_EXECUTIONS_PER_MINUTE) {
    throw new AutomationRateLimitError();
  }
}

async function storeToolExecution(input: {
  callId: string;
  toolId: string;
  requestJson: unknown;
  responseJson: unknown;
  status: ToolExecutionStatus;
  latencyMs: number;
  errorCode: string | null;
}): Promise<string> {
  const result = await db.query(
    `insert into tool_executions (call_id, tool_id, request_json, response_json, status, latency_ms, error_code)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
     returning id`,
    [
      input.callId,
      input.toolId,
      JSON.stringify(input.requestJson),
      JSON.stringify(input.responseJson),
      input.status,
      input.latencyMs,
      input.errorCode
    ]
  );
  return (result.rows[0] as { id: string }).id;
}

async function appendToolEvent(input: {
  callId: string;
  type: string;
  payload: unknown;
}): Promise<void> {
  await db.query(
    `insert into call_events (call_id, type, payload_json)
     values ($1, $2, $3::jsonb)`,
    [input.callId, input.type, JSON.stringify(input.payload)]
  );
}

export async function executeAutomationTool(input: ExecuteToolInput): Promise<ToolExecutionResult> {
  await assertRateLimit(input.callId);
  const runtime = await loadToolRuntimeConfig(input);
  const validationIssues = validateInputAgainstSchema(runtime.inputSchemaJson, input.inputJson);

  if (validationIssues.length > 0) {
    const responseJson = {
      validation_errors: validationIssues
    };
    const executionId = await storeToolExecution({
      callId: input.callId,
      toolId: runtime.toolId,
      requestJson: input.inputJson,
      responseJson,
      status: "error",
      latencyMs: 0,
      errorCode: "schema_validation_failed"
    });

    await appendToolEvent({
      callId: input.callId,
      type: "runtime.tool_execution_failed",
      payload: {
        trace_id: input.traceId ?? null,
        tool_id: runtime.toolId,
        tool_name: runtime.toolName,
        execution_id: executionId,
        error_code: "schema_validation_failed",
        details: responseJson
      }
    });

    return {
      ok: false,
      tool_id: runtime.toolId,
      tool_name: runtime.toolName,
      execution_id: executionId,
      status: "error",
      attempts: 0,
      latency_ms: 0,
      response_json: responseJson,
      error_code: "schema_validation_failed"
    };
  }

  const outbound = await runOutboundRequest(runtime, input.inputJson);
  const executionId = await storeToolExecution({
    callId: input.callId,
    toolId: runtime.toolId,
    requestJson: input.inputJson,
    responseJson: outbound.responseJson,
    status: outbound.status,
    latencyMs: outbound.latencyMs,
    errorCode: outbound.errorCode
  });

  await appendToolEvent({
    callId: input.callId,
    type: outbound.status === "success" ? "runtime.tool_execution_succeeded" : "runtime.tool_execution_failed",
    payload: {
      trace_id: input.traceId ?? null,
      tool_id: runtime.toolId,
      tool_name: runtime.toolName,
      execution_id: executionId,
      attempts: outbound.attempts,
      latency_ms: outbound.latencyMs,
      status: outbound.status,
      error_code: outbound.errorCode
    }
  });

  return {
    ok: outbound.status === "success",
    tool_id: runtime.toolId,
    tool_name: runtime.toolName,
    execution_id: executionId,
    status: outbound.status,
    attempts: outbound.attempts,
    latency_ms: outbound.latencyMs,
    response_json: outbound.responseJson,
    error_code: outbound.errorCode
  };
}
