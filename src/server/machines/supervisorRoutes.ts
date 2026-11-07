import type { FastifyInstance } from "fastify";
import { UnitSupervisorClient, type UnitSupervisorDelegate } from "./unitSupervisorClient.js";

/**
 * Same-origin proxy routes for the session supervisor. The browser talks to
 * the web/API process only; these handlers forward unit lifecycle requests
 * (create, add worktree, unit lookup, generation status) to the supervisor's
 * loopback endpoint. Supervisor status codes pass through; an unreachable
 * supervisor surfaces as HTTP 502.
 */
export function registerSupervisorRoutes(app: FastifyInstance, supervisor: UnitSupervisorDelegate = new UnitSupervisorClient()): void {
  app.post("/api/supervisor/create", async (request, reply) => {
    try {
      const response = await supervisor.create(request.body);
      return await reply.code(response.status).send(response.body);
    } catch (error) {
      return reply.code(502).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/supervisor/worktree", async (request, reply) => {
    try {
      const response = await supervisor.addWorktree(request.body);
      return await reply.code(response.status).send(response.body);
    } catch (error) {
      return reply.code(502).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Querystring: { cwd?: string } }>("/api/supervisor/unit", async (request, reply) => {
    try {
      const response = await supervisor.unitByCwd(request.query.cwd ?? "");
      return await reply.code(response.status).send(response.body);
    } catch (error) {
      return reply.code(502).send({ error: errorMessage(error) });
    }
  });

  app.get<{ Querystring: Record<string, string> }>("/api/supervisor/unit-status", async (request, reply) => {
    try {
      const response = await supervisor.unitStatus(request.query);
      return await reply.code(response.status).send(response.body);
    } catch (error) {
      return reply.code(502).send({ error: errorMessage(error) });
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
