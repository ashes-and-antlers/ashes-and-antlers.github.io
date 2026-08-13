import { z } from 'zod';
import type { CancelConstructionCommand, StartBuildingCommand } from './construction';
import type { CancelResearchCommand, StartResearchCommand } from './research';
import type { CancelShipOrderCommand, QueueShipCommand } from './shipyard';
import type {
  LoadCargoCommand,
  RecallFleetCommand,
  SendFleetCommand,
  SplitFleetCommand,
  TransferFleetCommand,
  UnloadCargoCommand,
} from './fleet';
import type { RunScanCommand } from './scan';

/**
 * Command envelope (DEVELOPMENT_PLAN.md §9). M0 rejected every kind;
 * M1 implemented the first real kinds (StartBuilding, CancelConstruction);
 * M2 adds research, shipyard, and fleet commands; M3 adds fleet movement
 * (SendFleet/RecallFleet), cargo handling (LoadCargo/UnloadCargo), and
 * scans (RunScan).
 */
export type GameCommand =
  | StartBuildingCommand
  | CancelConstructionCommand
  | StartResearchCommand
  | CancelResearchCommand
  | QueueShipCommand
  | CancelShipOrderCommand
  | TransferFleetCommand
  | SplitFleetCommand
  | SendFleetCommand
  | RecallFleetCommand
  | LoadCargoCommand
  | UnloadCargoCommand
  | RunScanCommand;

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
