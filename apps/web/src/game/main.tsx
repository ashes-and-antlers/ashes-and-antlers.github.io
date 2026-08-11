import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OverviewApp } from './overview';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';

spawnStarfield();

const rootEl = document.getElementById('game-root');
if (!rootEl) {
  throw new Error('game root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <OverviewApp />
  </StrictMode>,
);
