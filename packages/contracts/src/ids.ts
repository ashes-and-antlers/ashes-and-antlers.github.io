import { z } from 'zod';

/**
 * Branded identifiers. Branding is a compile-time contract only: every id is a
 * plain string at runtime, but branded types make it impossible to pass a
 * player id where a planet id is expected.
 */

export type WorldId = string & { readonly __brand: 'WorldId' };
export type PlayerId = string & { readonly __brand: 'PlayerId' };
export type PlanetId = string & { readonly __brand: 'PlanetId' };
export type FactionId = string & { readonly __brand: 'FactionId' };

export const WorldIdSchema = z.string().brand<'WorldId'>('WorldId');
export const PlayerIdSchema = z.string().brand<'PlayerId'>('PlayerId');
export const PlanetIdSchema = z.string().brand<'PlanetId'>('PlanetId');
export const FactionIdSchema = z.string().brand<'FactionId'>('FactionId');

export const worldId = (value: string): WorldId => value as WorldId;
export const playerId = (value: string): PlayerId => value as PlayerId;
export const planetId = (value: string): PlanetId => value as PlanetId;
export const factionId = (value: string): FactionId => value as FactionId;

/**
 * The world id is a pure function of the seed: `world:1337`. This keeps the
 * web client able to derive the world id from the URL seed parameter, and it
 * makes world creation idempotent per seed.
 */
export function worldIdFromSeed(seed: number): WorldId {
  return worldId(`world:${seed}`);
}
