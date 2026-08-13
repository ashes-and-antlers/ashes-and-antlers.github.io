import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountApp } from './account';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';
import './account.css';

spawnStarfield();

const rootEl = document.getElementById('account-root');
if (!rootEl) {
  throw new Error('account root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <AccountApp />
  </StrictMode>,
);
