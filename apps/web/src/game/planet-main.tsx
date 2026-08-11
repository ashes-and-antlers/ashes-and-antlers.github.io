import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PlanetApp } from './planet';
import './game.css';

const rootEl = document.getElementById('planet-root');
if (!rootEl) {
  throw new Error('planet root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <PlanetApp />
  </StrictMode>,
);
