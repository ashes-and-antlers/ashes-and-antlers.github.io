import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ResearchApp } from './research';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';

spawnStarfield();

const rootEl = document.getElementById('research-root');
if (!rootEl) {
  throw new Error('research root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <ResearchApp />
  </StrictMode>,
);
