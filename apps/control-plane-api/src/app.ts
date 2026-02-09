import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import { ZodError } from "zod";
import { authenticate } from "./middleware/auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { registerClientRoutes } from "./routes/client.js";
import { registerTwilioRoutes } from "./routes/twilio.js";
import { registerDevRoutes } from "./routes/dev.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(sensible);
  app.register(cors, { origin: true });
  app.register(formbody);

  app.addHook("preHandler", async (request, reply) => {
    const openPathPrefixes = ["/health", "/twilio/webhook/inbound", "/internal/dev/token"];
    if (openPathPrefixes.some((prefix) => request.url.startsWith(prefix))) {
      return;
    }

    await authenticate(request, reply);
  });

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

  app.register(registerHealthRoutes);
  app.register(registerDevRoutes);
  app.register(registerTwilioRoutes);
  app.register(registerInternalRoutes);
  app.register(registerClientRoutes);

  return app;
}
