export type AppRole = "internal_admin" | "internal_operator" | "client_viewer";

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: AppRole;
  isInternal: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
