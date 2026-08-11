import { z } from 'zod';

/**
 * Command envelope (DEVELOPMENT_PLAN.md §9). M0 implements the envelope
 * contract but no command kinds: every submission is validated for shape and
 * then rejected as unsupported. The kinds arrive with M1+ systems.
 */
export type GameCommand = { kind: string } & Record<string, unknown>;

export type CommandEnvelope = {
  idempotencyKey: string;
  expectedVersion: number;
  /** ISO-8601 timestamp submitted by the client; treated as untrusted. */
  submittedAt: string;
  command: GameCommand;
};

export const CommandEnvelopeSchema = z
  .object({
    idempotencyKey: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9._-]+$/),
    expectedVersion: z.number().int().nonnegative(),
    submittedAt: z.string().datetime({ offset: true }),
    command: z.object({ kind: z.string().min(1) }).passthrough(),
  })
  .strict();
