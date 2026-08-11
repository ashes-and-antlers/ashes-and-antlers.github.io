import { spawnStarfield } from '../starfield';
import './style.css';
import './landing.css';

/**
 * Landing page ("The Sequence", seed dc472b5a).
 *
 * The cover is the brand mark, centered on the field, with one primary
 * action — Enter the world — beneath it. The premise unfolds as ledger
 * entries. No simulation state lives here: the enter action links to the
 * game page, which owns the worker and worlds.
 */

// The deep field: a cold nebula breathes behind the page (CSS body::before),
// and a scatter of stars twinkles across the void. Decorative, reduced-motion
// aware — under reduced motion the stars stay visible but hold still (CSS).
spawnStarfield();

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
