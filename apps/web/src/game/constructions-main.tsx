import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConstructionsApp } from './constructions';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';

spawnStarfield();

const rootEl = document.getElementById('constructions-root');
if (!rootEl) {
  throw new Error('constructions root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <ConstructionsApp />
  </StrictMode>,
);
