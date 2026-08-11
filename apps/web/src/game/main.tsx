import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OverviewApp } from './overview';
import './game.css';

const rootEl = document.getElementById('game-root');
if (!rootEl) {
  throw new Error('game root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <OverviewApp />
  </StrictMode>,
);
