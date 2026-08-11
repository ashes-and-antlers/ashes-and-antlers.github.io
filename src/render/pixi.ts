import { Application } from 'pixi.js';

/**
 * Create and mount the PixiJS 8 renderer inside `container`.
 * The simulation stays in its worker; this canvas only shows derived state.
 */
export async function createRenderer(container: HTMLElement): Promise<Application> {
  const app = new Application();
  await app.init({
    background: 0x162218,
    antialias: false,
    resizeTo: container,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  container.appendChild(app.canvas);
  return app;
}
