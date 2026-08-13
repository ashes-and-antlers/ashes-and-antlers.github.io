/**
 * Reports (DEVELOPMENT_PLAN.md §2, M2): the recent-completions feed shown on
 * the command overview. Derived from the world's immutable order history
 * (completed research, ships, and buildings) — never new authoritative state.
 */
export type ReportView = {
  id: string;
  tick: number;
  kind: 'research_completed' | 'ships_completed' | 'building_completed';
  /** Human-readable subject, e.g. "Deep Extraction" or "Scout × 3". */
  label: string;
  planetId: string | null;
  planetName: string | null;
};
