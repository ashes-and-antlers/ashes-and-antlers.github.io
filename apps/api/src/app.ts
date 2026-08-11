import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { apiError, CommandEnvelopeSchema, type ApiError, type WorldId } from '@ashes/contracts';
import type { TickEngine } from '@ashes/db';

/**
 * M0 dev identity baseline: a bearer token authenticates as the seeded
 * player. Real authentication/authorization arrives in M1; this exists so
 * that every route has an enforced auth boundary now.
 */
export type AuthConfig = {
  /** The seeded player's token (shared with the world's player). */
  playerToken: string;
  /** Token required for dev/admin endpoints (world creation, tick trigger). */
  adminToken: string;
};

export const CreateWorldSchema = z.object({
  seed: z.number().int().nonnegative(),
});

export function createApi(engine: TickEngine, auth: AuthConfig): Hono {
  const app = new Hono();

  // The web client is served from a different origin in dev/e2e builds.
  // M0 dev posture: allow any origin so the command dashboard can reach the
  // API; real origins are locked down with authentication in M1.
  app.use('*', cors({ origin: '*' }));

  app.get('/healthz', (c) => c.json({ ok: true, service: 'ashes-api' }));

  // -- dev/admin: world creation + tick trigger ---------------------------

  app.post('/api/v1/dev/worlds', bearer(auth.adminToken), async (c) => {
    const body = await readJson(c);
    const parsed = CreateWorldSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        apiError('VALIDATION_ERROR', 'malformed request body', parsed.error.issues),
        400,
      );
    }
    const world = engine.createWorld({
      seed: parsed.data.seed,
      playerToken: auth.playerToken,
    });
    return c.json(engine.getWorldView(world.id), 200);
  });

  app.post('/api/v1/dev/worlds/:worldId/tick', bearer(auth.adminToken), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!engine.getWorld(worldId)) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    try {
      const resolution = await engine.resolveNextTick(worldId);
      return c.json(
        {
          tick: resolution.tick,
          seed: resolution.seed,
          planetStateHash: resolution.planetStateHash,
          resolvedAt: resolution.resolvedAt,
          status: resolution.status,
        },
        200,
      );
    } catch (err) {
      return c.json(engine.toApiError(err), 500);
    }
  });

  // -- player-facing: overview, planets, commands -------------------------

  app.get('/api/v1/worlds/:worldId/overview', bearer(auth.playerToken), (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!engine.getWorld(worldId)) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    return c.json(engine.getWorldView(worldId), 200);
  });

  app.get('/api/v1/worlds/:worldId/planets', bearer(auth.playerToken), (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!engine.getWorld(worldId)) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    const view = engine.getWorldView(worldId);
    return c.json({ planets: view.planets }, 200);
  });

  /**
   * M0 command submission: the envelope is validated strictly (idempotency
   * key, expected version, submitted timestamp, command shape), then every
   * submission is rejected because no command kinds exist yet. The acceptance
   * guarantee is "unauthenticated or malformed commands are rejected safely".
   */
  app.post('/api/v1/worlds/:worldId/commands', bearer(auth.playerToken), async (c) => {
    const worldId = c.req.param('worldId') as WorldId;
    if (!engine.getWorld(worldId)) {
      return c.json(apiError('NOT_FOUND', `world ${worldId} not found`), 404);
    }
    const body = await readJson(c);
    const envelope = CommandEnvelopeSchema.safeParse(body);
    if (!envelope.success) {
      return c.json(
        apiError('VALIDATION_ERROR', 'malformed command envelope', envelope.error.issues),
        400,
      );
    }
    return c.json(
      apiError(
        'UNSUPPORTED_COMMAND_KIND',
        `command kind '${envelope.data.command.kind}' is not supported yet (M0 has no command kinds)`,
      ),
      400,
    );
  });

  return app;
}

/**
 * Bearer-token middleware. Returns 401 with a typed error body when the
 * authorization header is missing or does not match the expected token.
 */
function bearer(token: string): MiddlewareHandler {
  return async (c: Context, next) => {
    const header = c.req.header('authorization');
    if (header !== `Bearer ${token}`) {
      const body: ApiError = apiError('UNAUTHENTICATED', 'a valid bearer token is required');
      return c.json(body, 401);
    }
    await next();
  };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}
