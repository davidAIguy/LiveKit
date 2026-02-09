import { env } from "../config.js";

interface ParsedToolCommand {
  toolName: string;
  inputJson: unknown;
}

interface ExecuteToolCommandInput {
  callId: string;
  traceId: string;
  toolName: string;
  inputJson: unknown;
}

interface ExecuteToolCommandResult {
  ok: boolean;
  status: string;
  execution_id?: string;
  response_json?: unknown;
  error_code?: string;
}

export interface AutomationToolCatalogItem {
  id: string;
  name: string;
  description: string;
  input_schema_json: unknown;
}

interface FetchToolCatalogResult {
  ok: boolean;
  items: AutomationToolCatalogItem[];
  error_code?: string;
}

export class ToolCommandSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCommandSyntaxError";
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseToolCommand(text: string): ParsedToolCommand | null {
  const trimmed = text.trim();
  const prefix = env.AUTOMATION_TOOL_COMMAND_PREFIX.trim();
  if (!prefix || !trimmed.startsWith(prefix)) {
    return null;
  }

  const pattern = new RegExp(`^${escapeRegex(prefix)}\\s+([a-zA-Z0-9_-]+)\\s+([\\s\\S]+)$`);
  const match = trimmed.match(pattern);
  if (!match) {
    throw new ToolCommandSyntaxError(
      `Formato invalido. Usa: ${prefix} <tool_name> <json_input>. Ejemplo: ${prefix} buscar_cliente {\"email\":\"ana@demo.com\"}`
    );
  }

  const [, toolName, inputJsonRaw] = match;

  let inputJson: unknown;
  try {
    inputJson = JSON.parse(inputJsonRaw);
  } catch {
    throw new ToolCommandSyntaxError("JSON invalido en comando de herramienta");
  }

  return {
    toolName,
    inputJson
  };
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

function resolveGatewayConfig(): { baseUrl: string; token: string } | null {
  const baseUrl = env.AUTOMATION_GATEWAY_BASE_URL;
  const token = env.AUTOMATION_GATEWAY_BEARER_TOKEN;
  if (!baseUrl || !token) {
    return null;
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

export async function fetchToolCatalog(callId: string): Promise<FetchToolCatalogResult> {
  const gateway = resolveGatewayConfig();
  if (!gateway) {
    return {
      ok: false,
      items: [],
      error_code: "automation_gateway_unconfigured"
    };
  }

  const endpoint = `${gateway.baseUrl}/internal/automation/tools/catalog?call_id=${encodeURIComponent(callId)}`;

  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${gateway.token}`,
          Accept: "application/json"
        }
      },
      env.AUTOMATION_GATEWAY_TIMEOUT_MS
    );

    if (!response.ok) {
      return {
        ok: false,
        items: [],
        error_code: `tool_catalog_http_${response.status}`
      };
    }

    const payload = (await response.json().catch(() => ({ items: [] }))) as {
      items?: Array<Record<string, unknown>>;
    };

    const items = Array.isArray(payload.items)
      ? payload.items
          .map((item) => {
            if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.description !== "string") {
              return null;
            }

            return {
              id: item.id,
              name: item.name,
              description: item.description,
              input_schema_json: item.input_schema_json
            } satisfies AutomationToolCatalogItem;
          })
          .filter((item): item is AutomationToolCatalogItem => item !== null)
      : [];

    return {
      ok: true,
      items
    };
  } catch (error) {
    return {
      ok: false,
      items: [],
      error_code: error instanceof Error && error.name === "AbortError" ? "request_timeout" : "gateway_network_error"
    };
  }
}

export async function executeToolCommand(
  input: ExecuteToolCommandInput
): Promise<ExecuteToolCommandResult> {
  const gateway = resolveGatewayConfig();
  if (!gateway) {
    return {
      ok: false,
      status: "error",
      error_code: "automation_gateway_unconfigured",
      response_json: {
        message: "AUTOMATION_GATEWAY_BASE_URL y AUTOMATION_GATEWAY_BEARER_TOKEN son requeridos"
      }
    };
  }

  const endpoint = `${gateway.baseUrl}/internal/automation/tools/by-name/${encodeURIComponent(input.toolName)}/execute`;

  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gateway.token}`
        },
        body: JSON.stringify({
          call_id: input.callId,
          trace_id: input.traceId,
          input_json: input.inputJson
        })
      },
      env.AUTOMATION_GATEWAY_TIMEOUT_MS
    );

    const data = (await response.json().catch(() => ({ message: "invalid_json_response" }))) as Record<
      string,
      unknown
    >;

    return {
      ok: response.ok,
      status: typeof data.status === "string" ? data.status : response.ok ? "success" : "error",
      execution_id: typeof data.execution_id === "string" ? data.execution_id : undefined,
      response_json: data.response_json,
      error_code: typeof data.error_code === "string" ? data.error_code : undefined
    };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof Error && error.name === "AbortError" ? "timeout" : "error",
      error_code: error instanceof Error && error.name === "AbortError" ? "request_timeout" : "gateway_network_error",
      response_json: {
        message: error instanceof Error ? error.message : "network_error"
      }
    };
  }
}
