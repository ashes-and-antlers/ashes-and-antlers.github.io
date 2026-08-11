import type { PlanetView, PlanetWarning, ResourceKey } from '@ashes/contracts';

export const RESOURCE_LABELS: Array<[ResourceKey, string]> = [
  ['metal', 'M'],
  ['mineral', 'Mn'],
  ['food', 'F'],
  ['energy', 'E'],
];

export const RESOURCE_NAMES: Array<[ResourceKey, string]> = [
  ['metal', 'Metal'],
  ['mineral', 'Mineral'],
  ['food', 'Food'],
  ['energy', 'Energy'],
];

export function formatResources(resources: PlanetView['resources']): string {
  return RESOURCE_LABELS.map(([key, label]) => `${label} ${resources[key]}`).join(' · ');
}

export function formatNet(net: PlanetView['rates']['net']): string {
  return RESOURCE_LABELS.map(([key, label]) => {
    const n = net[key];
    return `${label} ${n > 0 ? `+${n}` : n}`;
  }).join(' · ');
}

const WARNING_LABELS: Record<PlanetWarning, string> = {
  storage_full: 'Storage full',
  food_deficit: 'Food deficit',
  energy_deficit: 'Energy deficit',
};

export function WarningsChips({ warnings }: { warnings: PlanetWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <ul className="warning-chips" aria-label="planet warnings">
      {warnings.map((w) => (
        <li key={w} className={`warning-chip warning-${w}`}>
          {WARNING_LABELS[w]}
        </li>
      ))}
    </ul>
  );
}

export function AbundanceBar({ planet }: { planet: PlanetView }) {
  return (
    <div className="abundance" aria-label="planet abundance">
      {RESOURCE_NAMES.map(([key, label]) => (
        <div className="abundance-row" key={key}>
          <span className="abundance-label">{label}</span>
          <div className="abundance-track" role="meter" aria-valuenow={planet.abundance[key]}>
            <div className="abundance-fill" style={{ width: `${planet.abundance[key]}%` }} />
          </div>
          <span className="abundance-value">{planet.abundance[key]}</span>
        </div>
      ))}
    </div>
  );
}
