import { useMemo } from 'react';
import { GameHeader, HeaderMeta, useWorldMeta } from './header';
import { sessionWorldId } from './session';

type GlossaryEntry = { id: string; term: string; definition: string };

/** The archive's working vocabulary, in one place. Keep each entry to one
 *  plain sentence where possible; the section explainers expand on them. */
const ENTRIES: GlossaryEntry[] = [
  {
    id: 'tick',
    term: 'Tick',
    definition:
      'One fixed beat of the simulation. Each tick the world advances by exactly one step, and every order issued before its cutoff is applied in that same beat. The countdown in the header is the time until the next tick resolves.',
  },
  {
    id: 'abundance',
    term: 'Abundance',
    definition:
      'How rich a planet is in each resource by nature. It sets the ceiling on what extraction can pull from the land: a planet rich in metal will out-produce a poor one.',
  },
  {
    id: 'resources',
    term: 'Resources',
    definition:
      'The four materials of the archive — Metal, Mineral, Food, and Energy. Planets hold them in storage and spend them on upkeep and construction.',
  },
  {
    id: 'stored',
    term: 'Stored',
    definition:
      'What a planet holds of each resource right now, capped per resource by its storage cap.',
  },
  {
    id: 'storage-cap',
    term: 'Storage cap',
    definition:
      'How much of each resource a planet can hold at once. Anything produced beyond the cap is wasted.',
  },
  {
    id: 'production',
    term: 'Production',
    definition: "What a planet's population and buildings yield each tick.",
  },
  {
    id: 'upkeep',
    term: 'Upkeep',
    definition:
      "What a planet's buildings consume each tick to keep running. Net is production minus upkeep.",
  },
  {
    id: 'net',
    term: 'Net',
    definition:
      'Production minus upkeep — the trend of a stock. A green surplus grows the stock; a red deficit drains it.',
  },
  {
    id: 'population',
    term: 'Population',
    definition: "The world's headcount — the hands that work your buildings.",
  },
  {
    id: 'buildings',
    term: 'Buildings',
    definition:
      'Facilities raised on a world, each a data-defined kind with its own effect on production, storage, or population. Level shows how far it has been raised.',
  },
  {
    id: 'warnings',
    term: 'Warnings',
    definition:
      'Flags the archive raises when a world needs attention: a full stock that is wasting production, or a food or energy deficit that will bite at resolution.',
  },
  {
    id: 'coordinate',
    term: 'Coordinate',
    definition: "A planet's address in the galaxy, read galaxy:sector:system:planet.",
  },
  {
    id: 'home-planet',
    term: 'Home planet',
    definition:
      'The world your archive was founded on. It is marked with a crown in the known-planets list.',
  },
  {
    id: 'orders',
    term: 'Orders',
    definition: 'Commands you issue. They wait in the pending list and resolve at the next tick.',
  },
  {
    id: 'faction',
    term: 'Faction',
    definition: 'The people your archive belongs to.',
  },
  {
    id: 'research',
    term: 'Research',
    definition:
      'Account-wide studies run on a planet with a Research Lab. One study at a time, a small queue behind it, and the full cost is reserved when you commit.',
  },
  {
    id: 'technology',
    term: 'Technology',
    definition:
      'A completed study, permanently recorded for the account. Effects are additive and apply from the next tick — extraction and storage bonuses, fleet speed, and new ship unlocks.',
  },
  {
    id: 'shipyard',
    term: 'Shipyard',
    definition:
      "The building that builds hulls into a planet's local fleet. One order builds at a time; completed ships arrive at the next tick boundary, exactly once.",
  },
  {
    id: 'fleet',
    term: 'Fleet',
    definition:
      'A stack of ships orbiting a planet. Shipyards deliver into the local fleet, and you can split detachments off or transfer ships and cargo between co-located fleets.',
  },
  {
    id: 'drive-tier',
    term: 'Drive tier',
    definition:
      'A ship class travel capability. A fleet moves no faster than its slowest ship; navigation research multiplies every fleet speed.',
  },
];

export function GlossaryApp() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const seed = params.get('seed') ?? '1337';
  const worldMeta = useWorldMeta(sessionWorldId(seed));

  return (
    <div className="game-shell">
      <GameHeader
        seed={seed}
        title="Glossary"
        current="glossary"
        meta={worldMeta && <HeaderMeta meta={worldMeta} />}
      />

      <main className="glossary-grid">
        <section className="panel glossary-panel" aria-labelledby="glossary-heading">
          <h2 id="glossary-heading" className="panel-title">
            Glossary
          </h2>
          <dl className="glossary-list">
            {ENTRIES.map(({ id, term, definition }) => (
              <div className="glossary-entry" key={id}>
                <dt data-testid={`glossary-term-${id}`}>{term}</dt>
                <dd>{definition}</dd>
              </div>
            ))}
          </dl>
        </section>
      </main>

      <footer className="game-footer">
        <span>deterministic core · versioned protocol</span>
        <span>ashfield command archive</span>
      </footer>
    </div>
  );
}
