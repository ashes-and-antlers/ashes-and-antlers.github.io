/**
 * Starfield — scatters twinkling stars across `#star-field` (the landing page
 * and both game pages share this generator; the nebula paint lives in each
 * page's CSS `body::before`). Purely decorative and reduced-motion aware:
 * under reduced motion the CSS holds the stars perfectly still, so the field
 * stays visible without motion.
 */
export function spawnStarfield(): void {
  const starField = document.getElementById('star-field');
  if (!starField) return;
  const starCount = Math.min(140, Math.max(70, Math.floor(window.innerWidth / 11)));
  for (let i = 0; i < starCount; i++) {
    const star = document.createElement('span');
    star.className = 'star';
    const roll = Math.random();
    if (roll < 0.1) star.classList.add('is-ice');
    else if (roll > 0.96) star.classList.add('is-bright');
    const size = star.classList.contains('is-bright')
      ? 1.8 + Math.random() * 0.9
      : 1 + Math.random() * 1.2;
    star.style.left = `${Math.random() * 100}%`;
    star.style.top = `${Math.random() * 100}%`;
    star.style.width = `${size}px`;
    star.style.height = `${size}px`;
    star.style.animationDelay = `${Math.random() * 6}s`;
    star.style.animationDuration = `${2.5 + Math.random() * 4.5}s`;
    starField.appendChild(star);
  }
}
