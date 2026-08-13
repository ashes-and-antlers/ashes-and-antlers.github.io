import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ScansApp } from './scans';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';

spawnStarfield();

const rootEl = document.getElementById('scans-root');
if (!rootEl) {
  throw new Error('scans root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <ScansApp />
  </StrictMode>,
);
