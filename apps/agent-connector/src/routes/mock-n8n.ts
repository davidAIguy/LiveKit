import { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config.js";

function isAuthorized(
  authorizationHeader: string | undefined,
  apiKeyHeader: string | undefined,
  expectedSecret: string
): boolean {
  if (authorizationHeader) {
    const [scheme, token] = authorizationHeader.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token === expectedSecret) {
      return true;
    }
  }

  if (apiKeyHeader && apiKeyHeader === expectedSecret) {
    return true;
  }

  return false;
}

function stableHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 100000;
  }
  return hash;
}

const CustomerLookupSchema = z
  .object({
    customer_id: z.string().min(2).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(5).optional()
  })
  .refine((value) => Boolean(value.customer_id || value.email || value.phone), {
    message: "At least one of customer_id, email, phone is required"
  });

const OrderStatusSchema = z.object({
  order_id: z.string().min(3)
});

const CreateTicketSchema = z.object({
  customer_id: z.string().min(2).optional(),
  subject: z.string().min(3),
  message: z.string().min(3),
  priority: z.enum(["low", "medium", "high"])
});

export async function registerMockN8nRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/mock-n8n/")) {
      return;
    }

    const apiKeyHeader = request.headers["x-n8n-api-key"];
    const providedApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    const allowed = isAuthorized(
      request.headers.authorization,
      providedApiKey,
      env.MOCK_N8N_AUTH_SECRET
    );

    if (!allowed) {
      reply.code(401).send({ error: "unauthorized", message: "Invalid mock n8n credentials" });
      return;
    }
  });

  app.get("/mock-n8n/api/v1/workflows", async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().positive().max(50).default(1) }).parse(request.query);
    reply.send({
      data: [
        {
          id: "wf_mock_01",
          name: "mock-workflow"
        }
      ].slice(0, query.limit),
      nextCursor: null
    });
  });

  app.get("/mock-n8n/rest/workflows", async (_request, reply) => {
    reply.send({
      data: [
        {
          id: "wf_mock_01",
          name: "mock-workflow"
        }
      ]
    });
  });

  app.get("/mock-n8n/health", async (_request, reply) => {
    reply.send({ ok: true, service: "mock-n8n", ts: new Date().toISOString() });
  });

  app.post("/mock-n8n/customer-lookup", async (request, reply) => {
    const body = CustomerLookupSchema.parse(request.body);
    const key = body.customer_id ?? body.email ?? body.phone ?? "unknown";
    const fingerprint = stableHash(key);
    reply.send({
      ok: true,
      customer: {
        customer_id: body.customer_id ?? `cust_${fingerprint}`,
        email: body.email ?? `customer${fingerprint}@demo.local`,
        phone: body.phone ?? `+1555${String(fingerprint).padStart(7, "0")}`,
        tier: fingerprint % 2 === 0 ? "gold" : "standard",
        account_status: "active"
      }
    });
  });

  app.post("/mock-n8n/order-status", async (request, reply) => {
    const body = OrderStatusSchema.parse(request.body);
    const states = ["received", "preparing", "in_transit", "delivered"] as const;
    const index = stableHash(body.order_id) % states.length;
    reply.send({
      ok: true,
      order_id: body.order_id,
      status: states[index],
      estimated_minutes: index === 3 ? 0 : 10 + index * 8
    });
  });

  app.post("/mock-n8n/create-ticket", async (request, reply) => {
    const body = CreateTicketSchema.parse(request.body);
    const ticketId = `TCK-${Date.now().toString().slice(-8)}`;
    reply.send({
      ok: true,
      ticket_id: ticketId,
      status: "queued",
      priority: body.priority,
      customer_id: body.customer_id ?? null,
      ack: `Ticket ${ticketId} queued`
    });
  });
}
