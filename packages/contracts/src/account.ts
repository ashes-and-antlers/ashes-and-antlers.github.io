import { z } from 'zod';
import type { FactionId, PlanetId, PlayerId, SymbolId, WorldId } from './ids';

/**
 * A player account: the identity behind a bearer session. The account owns a
 * player in one world (its home world) and a chosen faction symbol — the
 * emblem that represents the commander in the game UI.
 *
 * The password hash and session token live only in the db layer; this module
 * carries the public view and the register/login wire schemas.
 */
export type AccountView = {
  id: string;
  username: string;
  /** Commander name shown in-game; defaults to the username. */
  name: string;
  factionId: FactionId;
  /** The chosen emblem from the faction's symbol bank (content). */
  symbolId: SymbolId;
  worldId: WorldId;
  playerId: PlayerId;
  homePlanetId: PlanetId;
  createdAt: number;
};

/** The response both register and login return: a session token + account. */
export type SessionResponse = {
  token: string;
  account: AccountView;
};

export const RegisterSchema = z.object({
  username: z
    .string()
    .min(3, 'username must be 3–24 letters, numbers, or underscores')
    .max(24, 'username must be 3–24 letters, numbers, or underscores')
    .regex(/^[A-Za-z0-9_]+$/, 'username may only contain letters, numbers, and underscores'),
  password: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .max(200, 'password is too long'),
  /** Commander name; defaults to the username. */
  name: z.string().min(1, 'name cannot be empty').max(40, 'name is too long').optional(),
  // A plain string on the wire; the API validates it against the emblem bank
  // and casts to the branded id. The faction itself is assigned server-side
  // (the least-populated power, for balance) — never chosen.
  symbolId: z.string().min(1, 'an emblem is required'),
});

export const LoginSchema = z.object({
  username: z.string().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;

/**
 * Profile update from the control panel. Both fields are optional so a form
 * can send exactly what changed; the API validates the emblem against the
 * content bank and re-checks name constraints.
 */
export const UpdateProfileSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').max(40, 'name is too long').optional(),
  symbolId: z.string().min(1, 'an emblem is required').optional(),
});

export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

/**
 * Password change from the control panel. `revokeOthers` signs out every
 * other active session after the new password is set (optional, default
 * false — the UI offers it as a checkbox).
 */
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'current password is required'),
  newPassword: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .max(200, 'password is too long'),
  revokeOthers: z.boolean().optional(),
});

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

/**
 * One active (or historical) session on the account, as shown in the control
 * panel's device list. `isCurrent` marks the session that issued the list
 * request so the panel can label it and never offer to sign it out as
 * "another device".
 */
export type AccountSessionView = {
  id: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  userAgent: string | null;
  ipAddress: string | null;
  isCurrent: boolean;
};

export type SessionsResponse = {
  sessions: AccountSessionView[];
};
