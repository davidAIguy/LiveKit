import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerRuntimeRoutes } from "./routes/runtime.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(sensible);
  app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true }));
  app.register(registerRuntimeRoutes);

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
