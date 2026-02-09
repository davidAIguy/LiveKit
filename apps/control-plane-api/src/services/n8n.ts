import { env } from "../config.js";

type N8nAuthType = "api_key" | "bearer";

interface TestN8nParams {
  baseUrl: string;
  authType: N8nAuthType;
  secret: string;
  timeoutMs?: number;
  retries?: number;
}

interface TestN8nResult {
  ok: boolean;
  endpoint?: string;
  status?: number;
  reason?: string;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildHeaders(authType: N8nAuthType, secret: string): Record<string, string> {
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

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function testN8nCloudConnection(params: TestN8nParams): Promise<TestN8nResult> {
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const timeoutMs = params.timeoutMs ?? env.N8N_TEST_TIMEOUT_MS;
  const retries = params.retries ?? env.N8N_TEST_RETRIES;
  const headers = buildHeaders(params.authType, params.secret);
  const endpoints = ["/api/v1/workflows?limit=1", "/rest/workflows?limit=1"];

  let lastReason = "unknown";

  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint}`;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetchWithTimeout(url, { method: "GET", headers }, timeoutMs);

        if (response.status >= 200 && response.status < 300) {
          return { ok: true, endpoint, status: response.status };
        }

        if (response.status === 401 || response.status === 403) {
          return { ok: false, endpoint, status: response.status, reason: "auth_failed" };
        }

        if (response.status === 404) {
          lastReason = "endpoint_not_found";
          break;
        }

        if (response.status >= 500 && attempt < retries) {
          lastReason = "remote_server_error";
          continue;
        }

        return {
          ok: false,
          endpoint,
          status: response.status,
          reason: `unexpected_status_${response.status}`
        };
      } catch (error) {
        lastReason = error instanceof Error ? error.name : "network_error";
        if (attempt >= retries) {
          break;
        }
      }
    }
  }

  return { ok: false, reason: lastReason };
}
