import { FastifyInstance } from "fastify";
import { healthcheckDb } from "../db.js";

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true }));

  app.get("/health/db", async (_request, reply) => {
    await healthcheckDb();
    reply.send({ ok: true });
  });
}
