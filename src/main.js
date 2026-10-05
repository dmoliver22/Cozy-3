import './style.css';
import { Game } from './game/game.js';
import { installDebug } from './game/debug.js';

function boot() {
  const canvas = document.getElementById('view');
  let game;
  try {
    game = new Game(canvas);
  } catch (err) {
    console.error(err);
    const card = document.querySelector('.title-card');
    if (card) {
      card.innerHTML = `<h1 class="logo"><span class="logo-suds">Suds</span><span class="logo-amp">&amp;</span><span class="logo-snips">Snips</span></h1>
        <p class="tagline">This salon needs WebGL, and this browser could not start it.</p>
        <p class="title-foot">Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration switched on.</p>`;
    }
    return;
  }
  installDebug(game);
}

boot();
