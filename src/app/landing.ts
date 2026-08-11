import '@fontsource/cinzel/600.css';
import '@fontsource/cinzel/700.css';
import './style.css';
import './landing.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RepoInfo } from '../components/RepoInfo';

/**
 * Landing page ("The Sequence", seed dc472b5a).
 *
 * The cover is the brand mark, centered on the field, with one primary
 * action — Enter the world — beneath it. The premise unfolds as ledger
 * entries. No simulation state lives here: the enter action links to the
 * game page, which owns the worker and worlds.
 */

// The burning field: a fire breathes at the bottom edge (warm glow in CSS),
// a few sparks rise from it, and ash drifts back down through the night.
// Decorative, reduced-motion aware.
const ashField = document.getElementById('ash-field');
if (
  ashField &&
  window.matchMedia &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches
) {
  // Falling ash — grey motes populating the whole field, drifting downward.
  const ashCount = Math.min(26, Math.max(14, Math.floor(window.innerWidth / 60)));
  for (let i = 0; i < ashCount; i++) {
    const ash = document.createElement('span');
    ash.className = 'ash';
    const size = 1.5 + Math.random() * 2.2;
    ash.style.left = `${Math.random() * 100}%`;
    ash.style.top = `${Math.random() * 100}%`;
    ash.style.width = `${size}px`;
    ash.style.height = `${size}px`;
    ash.style.animationDelay = `${Math.random() * 14}s`;
    ash.style.animationDuration = `${10 + Math.random() * 14}s`;
    ashField.appendChild(ash);
  }
  // Rising sparks — sparse, bright embers climbing from the bottom edge.
  const sparkCount = Math.max(3, Math.floor(window.innerWidth / 260));
  for (let i = 0; i < sparkCount; i++) {
    const spark = document.createElement('span');
    spark.className = 'spark';
    const size = 1.5 + Math.random() * 1.5;
    spark.style.left = `${4 + Math.random() * 92}%`;
    spark.style.width = `${size}px`;
    spark.style.height = `${size}px`;
    spark.style.animationDelay = `${Math.random() * 8}s`;
    spark.style.animationDuration = `${4 + Math.random() * 5}s`;
    ashField.appendChild(spark);
  }
}

// Live GitHub widget — mounts React RepoInfo into #repo-root (no rewrite of the page).
const repoRoot = document.getElementById('repo-root');
if (repoRoot) {
  // nordicnode/ashes-and-antlers is the connected repo; works unauthenticated
  // for public repos, uses VITE_GITHUB_TOKEN when set for higher rate limits.
  createRoot(repoRoot).render(
    React.createElement(RepoInfo, { owner: 'nordicnode', repo: 'ashes-and-antlers' }),
  );
}

// Scroll reveals — the archive opens entry by entry.
const revealEls = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
  );
  for (const el of revealEls) {
    io.observe(el);
  }
} else {
  for (const el of revealEls) {
    el.classList.add('in');
  }
}
