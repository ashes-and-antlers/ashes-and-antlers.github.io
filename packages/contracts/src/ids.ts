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
export type SymbolId = string & { readonly __brand: 'SymbolId' };
export type OrderId = string & { readonly __brand: 'OrderId' };
export type FleetId = string & { readonly __brand: 'FleetId' };
export type TechnologyId = string & { readonly __brand: 'TechnologyId' };

export const WorldIdSchema = z.string().brand<'WorldId'>('WorldId');
export const PlayerIdSchema = z.string().brand<'PlayerId'>('PlayerId');
export const PlanetIdSchema = z.string().brand<'PlanetId'>('PlanetId');
export const FactionIdSchema = z.string().brand<'FactionId'>('FactionId');
export const SymbolIdSchema = z.string().brand<'SymbolId'>('SymbolId');
export const OrderIdSchema = z.string().brand<'OrderId'>('OrderId');
export const FleetIdSchema = z.string().brand<'FleetId'>('FleetId');
export const TechnologyIdSchema = z.string().brand<'TechnologyId'>('TechnologyId');

export const worldId = (value: string): WorldId => value as WorldId;
export const playerId = (value: string): PlayerId => value as PlayerId;
export const planetId = (value: string): PlanetId => value as PlanetId;
export const factionId = (value: string): FactionId => value as FactionId;
export const symbolId = (value: string): SymbolId => value as SymbolId;
export const orderId = (value: string): OrderId => value as OrderId;
export const fleetId = (value: string): FleetId => value as FleetId;
export const technologyId = (value: string): TechnologyId => value as TechnologyId;

/**
 * The world id is a pure function of the seed: `world:1337`. This keeps the
 * web client able to derive the world id from the URL seed parameter, and it
 * makes world creation idempotent per seed.
 */
export function worldIdFromSeed(seed: number): WorldId {
  return worldId(`world:${seed}`);
}
