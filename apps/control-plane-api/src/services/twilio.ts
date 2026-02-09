import { createHmac, timingSafeEqual } from "node:crypto";

function toFormValues(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const entries = Object.entries(payload as Record<string, unknown>);
  const result: Record<string, string> = {};

  for (const [key, value] of entries) {
    if (value === undefined || value === null) {
      continue;
    }
    result[key] = String(value);
  }

  return result;
}

export function buildTwilioSignaturePayload(url: string, payload: unknown): string {
  const params = toFormValues(payload);
  const keys = Object.keys(params).sort();
  let base = url;

  for (const key of keys) {
    base += key + params[key];
  }

  return base;
}

export function computeTwilioSignature(url: string, payload: unknown, authToken: string): string {
  const data = buildTwilioSignaturePayload(url, payload);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function isValidTwilioSignature(input: {
  url: string;
  payload: unknown;
  authToken: string;
  twilioSignature: string | undefined;
}): boolean {
  if (!input.twilioSignature) {
    return false;
  }

  const expected = computeTwilioSignature(input.url, input.payload, input.authToken);
  const provided = input.twilioSignature;

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}
