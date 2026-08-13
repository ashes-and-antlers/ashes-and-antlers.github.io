import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './admin';
import { spawnStarfield } from '../starfield';
import '../starfield.css';
import './game.css';

spawnStarfield();

const rootEl = document.getElementById('admin-root');
if (!rootEl) {
  throw new Error('admin root element missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
);
