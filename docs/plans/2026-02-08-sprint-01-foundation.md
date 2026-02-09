# Sprint 01 - Foundation

## Objective

Deliver the backend foundation for multi-tenant control-plane capabilities and production-safe data modeling.

## Stories

### S1 - Tenancy and RBAC base

- As an internal admin, I can create tenants.
- As an internal admin, I can assign user memberships with roles.
- As an API consumer, all reads and writes enforce tenant boundaries.

Acceptance criteria:

- Tenant CRUD works through internal endpoints.
- Membership role validation supports `internal_admin`, `internal_operator`, `client_viewer`.
- Authorization middleware rejects cross-tenant access.

### S2 - Agent configuration model

- As an internal operator, I can create an agent.
- As an internal operator, I can create versioned agent configs.
- As an internal operator, I can publish one version as active.

Acceptance criteria:

- Agent and version records are persisted with audit entries.
- Only one published version is active per agent.
- Version history remains immutable.

### S3 - Integration and tools model

- As an internal admin, I can register a tenant n8n Cloud integration.
- As an internal operator, I can define tools and link them to agent versions.

Acceptance criteria:

- Integration secrets are encrypted before persistence.
- Tool input schema is valid JSON Schema.
- Agent-version to tool assignment is many-to-many.

### S4 - Compliance base

- As a compliance operator, I can mark a call with legal hold.
- As the platform, I can purge sensitive data older than 30 days when not on hold.

Acceptance criteria:

- `legal_hold` is toggleable with audit trail.
- Retention cleanup query excludes legal-hold calls.
- Cleanup execution result is persisted in `deletion_jobs`.

## Definition of done

- Migration `db/migrations/0001_init.sql` applies cleanly.
- Retention SQL exists and is executable on schedule.
- PRD and sprint plan are versioned under `docs/plans`.
