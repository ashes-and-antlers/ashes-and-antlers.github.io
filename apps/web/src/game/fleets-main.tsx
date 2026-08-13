import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FleetsApp } from './fleets';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';

spawnStarfield();

const rootEl = document.getElementById('fleets-root');
if (!rootEl) {
  throw new Error('fleets root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <FleetsApp />
  </StrictMode>,
);
