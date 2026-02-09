import { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config.js";

const IssueTokenSchema = z.object({
  user_id: z.string().min(1),
  tenant_id: z.string().min(1),
  role: z.enum(["internal_admin", "internal_operator", "client_viewer"]),
  is_internal: z.boolean(),
  expires_in: z.string().default("1h")
});

export async function registerDevRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/dev/token", async (request, reply) => {
    if (env.NODE_ENV === "production") {
      reply.code(404).send({ error: "not_found" });
      return;
    }

    if (!env.DEV_BOOTSTRAP_KEY) {
      reply.code(403).send({
        error: "forbidden",
        message: "DEV_BOOTSTRAP_KEY is not configured"
      });
      return;
    }

    const providedKey = request.headers["x-dev-bootstrap-key"];
    const bootstrapKey = Array.isArray(providedKey) ? providedKey[0] : providedKey;
    if (!bootstrapKey || bootstrapKey !== env.DEV_BOOTSTRAP_KEY) {
      reply.code(403).send({
        error: "forbidden",
        message: "Invalid bootstrap key"
      });
      return;
    }

    const body = IssueTokenSchema.parse(request.body);
    const signOptions: jwt.SignOptions = {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      expiresIn: body.expires_in as jwt.SignOptions["expiresIn"]
    };

    const token = jwt.sign(
      {
        sub: body.user_id,
        tenant_id: body.tenant_id,
        role: body.role,
        is_internal: body.is_internal
      },
      env.JWT_SECRET,
      signOptions
    );

    reply.send({ token });
  });
}
