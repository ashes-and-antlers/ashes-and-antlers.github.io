import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GlossaryApp } from './glossary';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';

spawnStarfield();

const rootEl = document.getElementById('glossary-root');
if (!rootEl) {
  throw new Error('glossary root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <GlossaryApp />
  </StrictMode>,
);
