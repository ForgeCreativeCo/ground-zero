import './style.css';
import { Game } from './core/game';
import { installTestHooks } from './core/testHooks';

async function boot() {
  const root = document.getElementById('app')!;
  const status = document.getElementById('boot-status')!;
  try {
    const game = new Game(root);
    await game.init();
    installTestHooks(game);
    status.remove();
    console.info(`[ground-zero] ready: ${game.renderer.backendName}, seed ${game.seed}`);
  } catch (err) {
    console.error(err);
    status.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
    status.classList.add('error');
  }
}

void boot();
