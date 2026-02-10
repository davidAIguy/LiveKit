import { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db.js";
import type { AppRole } from "../types/http.js";
import { hashPassword, verifyPassword } from "../security/password.js";

const RegisterFirstAdminSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(10),
  tenant_name: z.string().min(2).default("Default Tenant"),
  timezone: z.string().default("UTC"),
  plan: z.string().default("starter")
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenant_id: z.string().uuid().optional()
});

const BootstrapCreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  password: z.string().min(10),
  tenant_id: z.string().uuid(),
  role: z.enum(["internal_admin", "internal_operator", "client_viewer"]),
  is_internal: z.boolean().default(false)
});

interface UserRecord {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  is_internal: boolean;
}

interface MembershipRecord {
  tenant_id: string;
  role: AppRole;
}

function signAccessToken(input: { userId: string; tenantId: string; role: AppRole; isInternal: boolean }): string {
  const signOptions: jwt.SignOptions = {
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: env.AUTH_JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"]
  };

  return jwt.sign(
    {
      sub: input.userId,
      tenant_id: input.tenantId,
      role: input.role,
      is_internal: input.isInternal
    },
    env.JWT_SECRET,
    signOptions
  );
}

function readBootstrapHeader(header: string | string[] | undefined): string | null {
  if (!header) {
    return null;
  }

  return Array.isArray(header) ? header[0] : header;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register-first-admin", async (request, reply) => {
    const body = RegisterFirstAdminSchema.parse(request.body);

    const countResult = await db.query(`select count(*)::int as total from users`);
    const totalUsers = Number((countResult.rows[0] as { total: number }).total);
    if (totalUsers > 0) {
      reply.code(409).send({ error: "bootstrap_closed", message: "Initial admin is already registered" });
      return;
    }

    const passwordHash = await hashPassword(body.password);

    await db.query("begin");
    try {
      const tenantResult = await db.query(
        `insert into tenants (name, timezone, plan)
         values ($1, $2, $3)
         returning id, name`,
        [body.tenant_name, body.timezone, body.plan]
      );
      const tenant = tenantResult.rows[0] as { id: string; name: string };

      const userResult = await db.query(
        `insert into users (email, name, password_hash, is_internal)
         values ($1, $2, $3, true)
         returning id, email, name, is_internal`,
        [body.email.toLowerCase(), body.name, passwordHash]
      );
      const user = userResult.rows[0] as { id: string; email: string; name: string; is_internal: boolean };

      await db.query(
        `insert into memberships (user_id, tenant_id, role)
         values ($1, $2, 'internal_admin')`,
        [user.id, tenant.id]
      );

      await db.query("commit");

      const token = signAccessToken({
        userId: user.id,
        tenantId: tenant.id,
        role: "internal_admin",
        isInternal: true
      });

      reply.code(201).send({
        ok: true,
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          is_internal: user.is_internal
        },
        membership: {
          tenant_id: tenant.id,
          role: "internal_admin"
        }
      });
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });

  app.post("/auth/login", async (request, reply) => {
    const body = LoginSchema.parse(request.body);

    const userResult = await db.query(
      `select id, email, name, password_hash, is_internal
       from users
       where lower(email) = lower($1)
       limit 1`,
      [body.email]
    );

    if (userResult.rows.length === 0) {
      reply.code(401).send({ error: "invalid_credentials", message: "Invalid email or password" });
      return;
    }

    const user = userResult.rows[0] as UserRecord;
    const validPassword = await verifyPassword(body.password, user.password_hash);
    if (!validPassword) {
      reply.code(401).send({ error: "invalid_credentials", message: "Invalid email or password" });
      return;
    }

    const membershipsResult = await db.query(
      `select tenant_id, role
       from memberships
       where user_id = $1
       order by created_at asc`,
      [user.id]
    );

    const memberships = membershipsResult.rows as MembershipRecord[];
    if (memberships.length === 0) {
      reply.code(403).send({ error: "no_membership", message: "User has no tenant membership" });
      return;
    }

    const selectedMembership = body.tenant_id
      ? memberships.find((membership) => membership.tenant_id === body.tenant_id) ?? null
      : memberships[0];

    if (!selectedMembership) {
      reply.code(403).send({ error: "tenant_access_denied", message: "User does not belong to tenant" });
      return;
    }

    const token = signAccessToken({
      userId: user.id,
      tenantId: selectedMembership.tenant_id,
      role: selectedMembership.role,
      isInternal: user.is_internal
    });

    reply.send({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        is_internal: user.is_internal
      },
      active_membership: selectedMembership,
      memberships
    });
  });

  app.post("/auth/bootstrap/user", async (request, reply) => {
    if (!env.AUTH_BOOTSTRAP_KEY) {
      reply.code(403).send({
        error: "forbidden",
        message: "AUTH_BOOTSTRAP_KEY is not configured"
      });
      return;
    }

    const providedKey = readBootstrapHeader(request.headers["x-auth-bootstrap-key"]);
    if (!providedKey || providedKey !== env.AUTH_BOOTSTRAP_KEY) {
      reply.code(403).send({ error: "forbidden", message: "Invalid bootstrap key" });
      return;
    }

    const body = BootstrapCreateUserSchema.parse(request.body);

    const tenantResult = await db.query(`select id from tenants where id = $1`, [body.tenant_id]);
    if (tenantResult.rows.length === 0) {
      reply.code(404).send({ error: "not_found", message: "Tenant not found" });
      return;
    }

    const passwordHash = await hashPassword(body.password);

    await db.query("begin");
    try {
      const userResult = await db.query(
        `insert into users (email, name, password_hash, is_internal)
         values ($1, $2, $3, $4)
         returning id, email, name, is_internal`,
        [body.email.toLowerCase(), body.name, passwordHash, body.is_internal]
      );

      const user = userResult.rows[0] as { id: string; email: string; name: string; is_internal: boolean };

      await db.query(
        `insert into memberships (user_id, tenant_id, role)
         values ($1, $2, $3)`,
        [user.id, body.tenant_id, body.role]
      );

      await db.query("commit");

      reply.code(201).send({
        ok: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          is_internal: user.is_internal
        },
        membership: {
          tenant_id: body.tenant_id,
          role: body.role
        }
      });
    } catch (error) {
      await db.query("rollback");

      if (typeof error === "object" && error && "code" in error && error.code === "23505") {
        reply.code(409).send({ error: "conflict", message: "User or membership already exists" });
        return;
      }

      throw error;
    }
  });
}
