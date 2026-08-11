import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MapApp } from './map';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';

spawnStarfield();

const rootEl = document.getElementById('map-root');
if (!rootEl) {
  throw new Error('map root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <MapApp />
  </StrictMode>,
);
