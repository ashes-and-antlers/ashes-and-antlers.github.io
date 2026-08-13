export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_COMMAND_KIND'
  | 'STALE_VERSION'
  | 'CONFLICT'
  | 'INTERNAL'
  | 'INSUFFICIENT_RESOURCES'
  | 'QUEUE_FULL'
  | 'MAX_LEVEL_REACHED'
  | 'NOT_OWNER'
  | 'UNKNOWN_BUILDING'
  | 'ORDER_NOT_FOUND'
  | 'CANNOT_CANCEL'
  // M2 research / shipyard / fleet
  | 'UNKNOWN_TECHNOLOGY'
  | 'PREREQUISITES_NOT_MET'
  | 'ALREADY_RESEARCHED'
  | 'HOST_PLANET_REQUIRES_LAB'
  | 'UNKNOWN_SHIP'
  | 'SHIP_LOCKED'
  | 'SHIPYARD_REQUIRED'
  | 'INVALID_QUANTITY'
  | 'FLEET_NOT_FOUND'
  | 'FLEETS_NOT_CO_LOCATED'
  | 'INSUFFICIENT_SHIPS'
  | 'CARGO_CAPACITY_EXCEEDED'
  | 'EMPTY_TRANSFER'
  | 'CANNOT_TRANSFER_TO_SELF'
  // M3 fleet movement
  | 'FLEET_NOT_ORBITING'
  | 'EMPTY_FLEET'
  | 'FLEET_NOT_MOVING'
  | 'ALREADY_RETURNING'
  | 'INVALID_DESTINATION'
  | 'SAME_LOCATION'
  | 'MISSION_UNSUPPORTED'
  | 'INSUFFICIENT_CARGO'
  // M3 scans
  | 'SCANNER_REQUIRED'
  | 'SCAN_LOCKED'
  | 'UNKNOWN_SCAN_KIND'
  | 'CANNOT_SCAN_OWN_PLANET'
  | 'OUT_OF_RANGE';

export type ApiError = {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
};

export function apiError(code: ApiErrorCode, message: string, details?: unknown): ApiError {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}
