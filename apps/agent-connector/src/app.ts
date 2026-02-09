import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { ZodError } from "zod";
import { healthcheckDb } from "./db.js";
import { registerMockN8nRoutes } from "./routes/mock-n8n.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
import { registerTwilioMediaRoutes } from "./routes/twilio-media.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(sensible);
  app.register(cors, { origin: true });
  app.register(websocket);

  app.get("/health", async () => ({ ok: true }));
  app.get("/health/db", async (_request, reply) => {
    await healthcheckDb();
    reply.send({ ok: true });
  });
  app.register(registerMockN8nRoutes);
  app.register(registerRuntimeRoutes);
  app.register(registerTwilioMediaRoutes);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: "bad_request",
        message: "Validation failed",
        details: error.issues
      });
      return;
    }

    app.log.error(error);
    reply.code(500).send({ error: "internal_error", message: "Unexpected server error" });
  });

  return app;
}
