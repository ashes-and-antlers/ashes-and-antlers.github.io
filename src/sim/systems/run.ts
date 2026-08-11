import type { SimWorld } from '../ecs/world';
import { runAlerts } from './alerts';
import { runMovement } from './movement';
import { runNeeds } from './needs';
import { runOwnership } from './ownership';
import { runResources } from './resources';
import { runTaskClaim, runTaskDemand, runTaskExecution } from './tasks';

/**
 * Fixed system schedule (deterministic order; see DEVELOPMENT_PLAN §7:
 * every system declares its read/write components in its own doc comment).
 *
 * 1. needs        — hunger/energy/morale, eating, starvation
 * 2. resources    — renewable node regrowth
 * 3. tasks:demand — create work orders from needs and stock levels
 * 4. tasks:claim  — assign orders to citizens (ascending id order)
 * 5. tasks:exec   — advance task phases (arrival, harvest, deposit)
 * 6. movement     — walk citizens along paths toward task goals
 * 7. ownership    — recompute faction control (every N ticks)
 * 8. alerts       — detect food shortages etc.
 */
export function runSystems(world: SimWorld): void {
  runNeeds(world);
  runResources(world);
  runTaskDemand(world);
  runTaskClaim(world);
  runTaskExecution(world);
  runMovement(world);
  runOwnership(world);
  runAlerts(world);
}
