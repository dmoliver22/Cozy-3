import * as THREE from 'three';
import { STATIONS, TUB, TABLE } from '../world/salon.js';
import { Dog } from '../dog/dog.js';
import { CUTS, BREEDS, BOW_COLORS } from '../dog/breeds.js';

// A small console/test hook: window.__suds. Handy for poking at the simulation and for smoke tests.
export function installDebug(game) {
  const wait = (s) => new Promise((r) => setTimeout(r, s * 1000));
  const api = {
    game,
    stats: () => game.dog?.refreshStats(),
    stage: () => game.stage,
    fps: () => game._fps,
    // Look at a world point (or the dog's torso / head).
    lookAt(target = 'torso', offset = [0, 0, 0]) {
      const d = game.dog;
      const p = target === 'head' ? d.head.pos.clone() : target === 'torso' ? d.torso.pos.clone() : new THREE.Vector3(...target);
      p.add(new THREE.Vector3(...offset));
      game.player.face(p);
      game.player.update(0.001, game.input, false);
    },
    face(x, y, z) {
      game.player.face(new THREE.Vector3(x, y, z));
    },
    stand(x, z) {
      game.player.pos.set(x, 0, z);
      game.player.vel.set(0, 0, 0);
    },
    // Hold the tool button for a while, optionally sweeping the aim around a target.
    async use(tool, seconds, sweep = null) {
      game.tools.select(['hands', 'spray', 'shampoo', 'dryer', 'brush', 'clippers', 'bow', 'camera'].indexOf(tool));
      game.input.use = true;
      game.input.usePressed = true;
      // Seconds of simulation time, so slow (software-rendered) runs behave like real ones.
      const t0 = game.time;
      while (game.time - t0 < seconds) {
        if (sweep) sweep(game.time - t0);
        game.input.use = true;
        await wait(1 / 60);
      }
      game.input.use = false;
    },
    async skipToBath() {
      if (game.stage === 'title') game.startGame(false);
      while (game.stage !== 'checkin') await wait(0.1);
      game._takeLeash();
      while (game.stage !== 'bath') await wait(0.1);
    },
    async skipToGroom() {
      game._toTable();
      while (game.stage !== 'groom') await wait(0.1);
    },
    wash() {
      const f = game.dog.fur;
      for (let s = 0; s < f.S; s++) {
        f.dirt[s] = f.loose[s] = f.lather[s] = f.soap[s] = 0;
        f.wet[s] = 1;
      }
      game.salon.tubDirt = 0;
    },
    dry() {
      const f = game.dog.fur;
      for (let s = 0; s < f.S; s++) {
        f.wet[s] = 0;
        f.blown[s] = 1;
      }
    },
    demat() {
      for (const m of game.dog.fur.mats) m.health = 0;
    },
    clip() {
      const f = game.dog.fur;
      for (let s = 0; s < f.S; s++) f.len[s] = f.target[s];
    },
    // Fast-forward: step the simulation without rendering (tests on software GL).
    fast(on = true) {
      clearInterval(api._fastTimer);
      game.skipRender = on;
      if (on) {
        api._fastTimer = setInterval(() => {
          for (let i = 0; i < 6; i++) {
            game.time += 1 / 30;
            game.update(1 / 30);
          }
        }, 0);
      }
    },
    // Put a dog straight onto the tub or table for quick looks.
    lab(breedKey = 'sheepdog', where = 'table', cutKey) {
      document.getElementById('title').hidden = true;
      game.hud.show(true);
      game.input.enabled = true;
      game.audio.init();
      game._clearDog();
      const B = BREEDS[breedKey];
      cutKey = cutKey ?? B.cuts[0];
      const dog = new Dog({ breedKey, seed: 42, cutKey, name: 'Lab' });
      const st = where === 'tub' ? STATIONS.tub : STATIONS.table;
      dog.place(st.x, st.y, st.z, where === 'tub' ? Math.PI / 2 : -Math.PI / 2);
      dog.growFur(game.furMaterial);
      dog.windAt = game.tools.windAt;
      dog.onEvent = (t, d) => game._dogEvent(t, d);
      game.scene.add(dog.group);
      game.dog = dog;
      game.dogFear = { dryer: 1, water: 1 };
      game.appt = { name: 'Lab', cut: CUTS[cutKey], cutKey, bow: BOW_COLORS[0], breedKey, temperament: 'Wiggly', owner: { name: 'Lab' } };
      game.stage = where === 'tub' ? 'bath' : 'groom';
      game.bathStart = game.time;
      game.flags = {};
      game.player.pos.set(st.x, 0, st.z + 0.95);
      game.player.face(new THREE.Vector3(st.x, st.y + B.stand, st.z));
      return dog.fur.S;
    },
    STATIONS, TUB, TABLE,
  };
  window.__suds = api;
  // Rolling FPS estimate for the debug overlay.
  let frames = 0, last = performance.now();
  const tick = () => {
    frames++;
    const now = performance.now();
    if (now - last > 1000) {
      game._fps = (frames * 1000) / (now - last);
      frames = 0;
      last = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
