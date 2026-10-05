import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Input } from '../core/input.js';
import { SalonAudio } from '../audio/audio.js';
import { Salon, STATIONS, TUB, TABLE, COUNTER, SUPPORTS, OBSTACLES } from '../world/salon.js';
import { Player } from '../player/player.js';
import { Tools, TOOL_DEFS } from '../tools/tools.js';
import { Dog } from '../dog/dog.js';
import { Bow } from '../dog/bow.js';
import { makeFurMaterial, REGION } from '../dog/fur.js';
import { setHairPixelScale, setHairDensity, hairDensity } from '../dog/hair.js';
import { BREEDS, CUTS, BOW_COLORS, DOG_NAMES, OWNERS, TEMPERAMENTS, NOTES, GUARDS } from '../dog/breeds.js';
import { Water, Gel } from '../fx/water.js';
import { Bubbles } from '../fx/bubbles.js';
import { Tufts } from '../fx/tufts.js';
import { Sparkles } from '../fx/sparkles.js';
import { Coins } from '../fx/coins.js';
import { Owner } from './owner.js';
import { PhotoWall, capturePolaroid, canvasToDataURL } from './photo.js';
import { UPGRADES, cozyBonus } from './upgrades.js';
import { loadSave, writeSave, defaultSave, clearSave } from './save.js';
import { Hud, showScreen, fillTicket, fillCheckout, buildShop } from '../ui/hud.js';
import { clamp, pick } from '../core/math.js';
import { Spring } from '../core/springs.js';
import { QUALITY, TOUCH_FIRST, IS_PHONE } from '../core/quality.js';

const $ = (id) => document.getElementById(id);
const _v = new THREE.Vector3();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _to = new THREE.Vector3();
const _td = new THREE.Vector3();
const col3 = [0, 0, 0];
const APPTS_PER_DAY = 3;
const DESHED_DONE = 0.85;
const _grab = {};

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY.startDpr));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color('#cfe3df');
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.03, 60);
    scene.add(this.camera);

    // Light: cool rainy daylight from the window, warm pendants, soft sky fill.
    this.hemi = new THREE.HemisphereLight('#eef8f4', '#d6c4ae', 1.25);
    scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight('#e4f0f4', 1.6));
    sun.position.set(-6.5, 4.2, -0.6);
    sun.target.position.set(0.5, 0.6, -1.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(QUALITY.shadow, QUALITY.shadow);
    const sc = sun.shadow.camera;
    sc.left = -3.6; sc.right = 3.6; sc.top = 3; sc.bottom = -2.5; sc.near = 1; sc.far = 14;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);

    this.salon = new Salon(scene);
    this.input = new Input(canvas);
    this.audio = new SalonAudio();
    this.hud = new Hud();
    this.player = new Player(this.camera, this.salon);
    this.player.onStep = () => {};

    this.furMaterial = makeFurMaterial();
    this.water = new Water(scene);
    this.gel = new Gel(scene);
    this.bubbles = new Bubbles(scene);
    this.tufts = new Tufts(scene, this.furMaterial);
    this.sparkles = new Sparkles(scene);
    this.coins = new Coins(scene, this.salon.tipJar, this.audio);
    this.photoWall = new PhotoWall(this.salon);
    this.treats = [];

    this.save = loadSave() ?? defaultSave();
    this.hasSave = !!loadSave();
    this.upgrades = this.save.upgrades;
    this.salon.setUpgrades(this.upgrades);
    this.photoWall.load(this.save.photos);
    this.hud.setMoney(this.save.money);
    this.audio.musicOn = this.save.music !== false;

    this.tools = new Tools(this);
    this.hud.onSlot = (i) => this.tools.select(i);
    this.tools.select(1);
    this.tools.select(0);

    this.dog = null;
    this.owner = null;
    this.appt = null;
    this.stage = 'title';
    this.modal = null;
    this.time = 0;
    this.statTimer = 0;
    this.stats = null;
    this.flags = {};
    this.titleSway = new Spring(0, 8, 3);
    this.clockStart = 9 * 3600;
    this.apptClock = 0;

    this._bindUI();
    this._resize();
    addEventListener('resize', () => this._resize());
    this.last = performance.now();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);

    // Something to look at behind the title card: a dog already waiting in the lobby.
    this._spawnTitleDog();
  }

  // ------------------------------------------------------------------
  // Keep the frame rate up on modest GPUs by trading resolution and hair density, a step at a time.
  _adaptResolution(dt) {
    if (this.skipRender || this.stage === 'title') return;
    this._frameEma = (this._frameEma ?? 0.016) * 0.95 + Math.min(dt, 0.2) * 0.05;
    this._adaptTimer = (this._adaptTimer ?? 0) + dt;
    if (this._adaptTimer < 2) return;
    this._adaptTimer = 0;
    const max = Math.min(window.devicePixelRatio || 1, QUALITY.maxDpr);
    let pr = this.renderer.getPixelRatio();
    const hd = hairDensity();
    if (this._frameEma > 0.028) {
      if (hd > 0.35) setHairDensity(hd * 0.85);
      if (pr > 0.6) pr = Math.max(0.6, pr * 0.88);
    } else if (this._frameEma < 0.018) {
      if (hd < 1) setHairDensity(hd * 1.1);
      if (pr < max) pr = Math.min(max, pr * 1.1);
    } else return;
    if (pr !== this.renderer.getPixelRatio()) {
      this.renderer.setPixelRatio(pr);
      this._resize();
    }
  }

  _resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 0.8 ? 82 : 70;
    this.camera.updateProjectionMatrix();
    setHairPixelScale(this.camera, this.renderer.domElement.height);
  }

  _bindUI() {
    $('btn-start').addEventListener('click', () => this.startGame(false));
    $('btn-reset').addEventListener('click', () => this.startGame(true));
    if (this.hasSave && (this.save.served > 0 || this.save.money > 0)) {
      $('btn-start').textContent = `Continue · day ${this.save.day}`;
      $('btn-reset').hidden = false;
    }
    $('btn-take').addEventListener('click', () => this._takeLeash());
    $('btn-next').addEventListener('click', () => this._nextAppointment());
    $('btn-shop').addEventListener('click', () => this.openShop('checkout'));
    $('btn-shop-close').addEventListener('click', () => this.closeShop());
    $('btn-resume').addEventListener('click', () => this.resume());
    $('btn-pause-shop').addEventListener('click', () => this.openShop('pause'));
    $('btn-music').addEventListener('click', () => {
      this.audio.setMusic(!this.audio.musicOn);
      this.save.music = this.audio.musicOn;
      this._persist();
      this._musicLabel();
    });
    this._musicLabel();
    this.input.onLockChange = (locked) => {
      if (!locked && this.playing && !this.modal && !this.input.lockFailed) this.pause();
      this.hud.setCrosshair(false, this.input.freeAim);
    };
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this.playing && !this.modal && this.input.lockFailed) this.pause();
      else if (e.code === 'Escape' && this.modal === 'pause') this.resume();
      else if (e.code === 'Escape' && this.modal === 'shop') this.closeShop();
    });
    $('hud-pause').addEventListener('click', () => this.pause());
    $('hud-shop').addEventListener('click', () => {
      if (!this.modal && this.stage !== 'title') this.openShop('play');
    });
    // Touch-first devices start in touch mode; hybrids switch over on their first touch.
    if (TOUCH_FIRST) this._enableTouch();
    else addEventListener('pointerdown', (e) => e.pointerType === 'touch' && this._enableTouch(), { capture: true });
  }

  _enableTouch() {
    if (this.input.touchReady) return;
    document.body.classList.add('is-touch');
    $('touch').hidden = false;
    this.input.classify = (x, y) => this._classifyTouch(x, y);
    // The aim reticle floats just above and left of the fingertip, out from under the finger.
    this.input.reticle = (x, y) => {
      const off = clamp(0.14 * Math.min(innerWidth, innerHeight), 80, 120);
      return [x - off * 0.25, Math.max(16, y - off)];
    };
    this.input.setupTouch({
      stick: $('stick'), knob: document.querySelector('.stick-knob'),
      turnL: $('t-turn-l'), turnR: $('t-turn-r'), crouch: $('t-crouch'), canvas: this.canvas,
    });
    // On touch screens the tool's option label is its own button.
    $('guard').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!this.modal && this.stage !== 'title') this.tools.alt();
    });
    this.tools._optionLabel();
  }

  // How the tool option is triggered, for hints.
  get optKey() {
    return this.input.touchMode ? 'tap the tool label' : 'R';
  }

  _rayAt(clientX, clientY, origin, dir) {
    const r = this.canvas.getBoundingClientRect();
    this.camera.getWorldPosition(origin);
    dir.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1, 0.5).unproject(this.camera).sub(origin).normalize();
  }

  // A finger landing on the tool in hand picks it up, on an object taps it, anywhere else (the dog
  // included) looks around. With the camera out, a tap anywhere takes the photo.
  _classifyTouch(cx, cy) {
    if (this.modal || this.stage === 'title') return 'look';
    const tool = this.tools.id;
    if (tool === 'camera' && this.stage === 'groom') return 'use';
    if (tool !== 'camera' && this.playing) {
      const t = this.tools.screenPos(_grab);
      if (Math.hypot(cx - t.x, cy - t.y) < t.r) return 'grab';
    }
    const o = new THREE.Vector3(), d = new THREE.Vector3();
    this._rayAt(cx, cy, o, d);
    if (this._interact(o, d, 8)) return 'tap';
    return 'look';
  }

  // Touch play: glide to a good viewpoint for each part of the appointment.
  _frameStation(where) {
    if (!this.input.touchMode) return;
    const portrait = this.camera.aspect < 0.8;
    const back = portrait ? 0.4 : 0;
    // Upright phones keep their buttons down the left edge, so frame the dog a little right of centre.
    const nudge = portrait ? 0.12 : 0;
    const P = this.player;
    // Stand off to the side of the dog's run-up so it does not hop through the camera.
    if (where === 'tub') P.glideTo(new THREE.Vector3(TUB.x + 0.42, 0, -1.45 + back), new THREE.Vector3(TUB.x - 0.08 - nudge, TUB.floor + 0.42, TUB.z));
    else if (where === 'table') P.glideTo(new THREE.Vector3(TABLE.x - 0.05, 0, -1.25 + back), new THREE.Vector3(TABLE.x - nudge, TABLE.y + 0.38, TABLE.z));
    else if (where === 'lobby') P.glideTo(new THREE.Vector3(0.2, 0, -0.1 + back * 0.5), new THREE.Vector3(1.2, 0.95, 1.7));
  }

  // A little haptic tick on phones that support it.
  buzz(pattern) {
    if (!this.input.touchMode) return;
    const now = performance.now();
    if (now - (this._lastBuzz || 0) < 70) return;
    this._lastBuzz = now;
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* not allowed here */
    }
  }

  _musicLabel() {
    $('btn-music').textContent = `Music: ${this.audio.musicOn ? 'on' : 'off'}`;
  }

  get playing() {
    return ['arrive', 'checkin', 'toTub', 'bath', 'bathDone', 'toTable', 'groom', 'handback', 'leaving'].includes(this.stage);
  }

  _persist() {
    this.save.upgrades = this.upgrades;
    writeSave(this.save);
  }

  // ------------------------------------------------------------------
  _spawnTitleDog() {
    const dog = new Dog({ breedKey: 'sheepdog', seed: 7, cutKey: 'teddy', name: 'Biscuit' });
    dog.place(0.4, 0, -0.75, -0.35);
    dog.growFur();
    dog.windAt = this.tools.windAt;
    this.scene.add(dog.group);
    this.dog = dog;
    this.player.pos.set(-0.45, 0, 1.5);
    this.player.face(new THREE.Vector3(-1.0, 0.45, -2.2), 0);
    this.titleYaw = this.player.yaw;
  }

  startGame(fresh) {
    this.audio.init();
    this.audio.setMusic(this.audio.musicOn);
    if (fresh) {
      clearSave();
      this.save = defaultSave();
      this.upgrades = this.save.upgrades;
      this.salon.setUpgrades(this.upgrades);
      this.photoWall.load([]);
      this.hud.setMoney(0);
    }
    showScreen('title', false);
    this.hud.show(true);
    this.input.enabled = true;
    this.input.requestLock();
    this.hud.setCrosshair(false, this.input.freeAim);
    this._clearDog();
    this.player.pos.set(0.1, 0, -0.4);
    this.player.yaw = 0;
    this.player.pitch = -0.3;
    // Phones get the whole screen when the browser allows it.
    if (IS_PHONE && !document.fullscreenElement) {
      try {
        document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {});
      } catch {
        /* not allowed in this frame */
      }
    }
    this._beginAppointment();
  }

  // ------------------------------------------------------------------
  // Appointments.
  _makeAppointment() {
    const n = this.save.appt;
    const rng = Math.random;
    let breedKey, name, ownerSpec, cutKey, bow, temperament, note;
    if (n === 0) {
      breedKey = 'sheepdog';
      name = 'Biscuit';
      ownerSpec = OWNERS[0];
      cutKey = 'teddy';
      bow = BOW_COLORS[0];
      temperament = 'Dramatic';
      note = NOTES.sheepdog[0];
    } else {
      // Meet every breed before repeats: the golden retriever first, then anyone not seen yet.
      const seen = (this.save.seen ??= ['sheepdog']);
      const fresh = Object.keys(BREEDS).filter((k) => !seen.includes(k));
      const keys = Object.keys(BREEDS).filter((k) => k !== this.lastBreed);
      breedKey = fresh.includes('golden') ? 'golden' : fresh.length ? pick(fresh, rng) : pick(keys, rng);
      name = pick(DOG_NAMES[breedKey], rng);
      ownerSpec = pick(OWNERS, rng);
      cutKey = pick(BREEDS[breedKey].cuts, rng);
      bow = rng() < 0.8 ? pick(BOW_COLORS, rng) : null;
      temperament = pick(TEMPERAMENTS, rng);
      note = pick(NOTES[breedKey], rng);
    }
    this.lastBreed = breedKey;
    if (!(this.save.seen ??= []).includes(breedKey)) this.save.seen.push(breedKey);
    const B = BREEDS[breedKey];
    const muddy = B.dirt > 0.85 ? 'Very muddy' : B.dirt > 0.72 ? 'Muddy' : 'Grubby';
    return {
      no: n + 1, breedKey, name, owner: ownerSpec, cutKey, cut: CUTS[cutKey], bow, temperament, note,
      breedName: B.name, coat: `${muddy}, ${B.mats} mat${B.mats === 1 ? '' : 's'}`, seed: 1000 + n * 37 + Math.floor(rng() * 1000),
    };
  }

  _clearDog() {
    if (this.dog) {
      this.dog.bow?.dispose();
      this.dog.dispose();
      this.dog = null;
    }
    if (this.owner) {
      this.owner.dispose();
      this.owner = null;
    }
    this.water.clear();
    this.bubbles.items.length = 0;
  }

  async _beginAppointment() {
    const slot = this.save.appt % APPTS_PER_DAY;
    this.apptClock = this.clockStart + slot * 2.5 * 3600;
    this.salon.setDayPhase(slot / (APPTS_PER_DAY - 1));
    this.hud.setDay(this.save.day, this._clockText());
    this.appt = this._makeAppointment();
    this.flags = {};
    const A = this.appt;
    this.hud.setJob(A.name, `${A.cut.name}${A.bow ? ` · ${A.bow.name} bow` : ''}`);
    const dog = new Dog({ breedKey: A.breedKey, seed: A.seed, cutKey: A.cutKey, name: A.name });
    dog.place(STATIONS.outside.x - 0.3, 0, STATIONS.outside.z, Math.PI);
    dog.growFur();
    dog.windAt = this.tools.windAt;
    dog.onEvent = (t, d) => this._dogEvent(t, d);
    this.dogFear = {
      dryer: A.temperament === 'Nervous of dryers' ? 2 : 1,
      water: A.temperament === 'Dramatic' ? 1.6 : 1,
    };
    if (A.temperament === 'A total angel') dog.happiness = 0.6;
    this.scene.add(dog.group);
    this.dog = dog;
    const owner = new Owner(A.owner);
    owner.place(STATIONS.ownerOut, Math.PI);
    this.scene.add(owner.group);
    this.owner = owner;
    this.stage = 'arrive';
    this._updateSteps();
    this._frameStation('lobby');

    await this._wait(0.6);
    this.salon.openDoor(true);
    this.audio.bell();
    this.toast(`Ding! ${A.name} is here`);
    const ownerWalk = owner.walk([STATIONS.doorway.clone().add(new THREE.Vector3(0.25, 0, 0)), STATIONS.owner]);
    const dogWalk = (async () => {
      await this._wait(0.4);
      await dog.do({ type: 'walk', to: STATIONS.doorway });
      await dog.do({ type: 'walk', to: STATIONS.lobby });
    })();
    await Promise.all([ownerWalk, dogWalk]);
    this.salon.openDoor(false);
    this.audio.bark(dog.B.bark, 2);
    this.speechText = A.note;
    this.speechTimer = 5;
    await this._wait(1.2);
    this.stage = 'checkin';
    this._openModal('ticket');
    fillTicket(A, A.no);
  }

  async _takeLeash() {
    this._closeModal();
    this.audio.click();
    this.stage = 'toTub';
    this.toast(`Off to the tub, ${this.appt.name}!`);
    const dog = this.dog;
    this.hud.suggest(['spray']);
    this._frameStation('tub');
    await dog.do({ type: 'walk', to: STATIONS.tubFront });
    await dog.do({ type: 'jump', to: STATIONS.tub, groundY: TUB.floor, support: SUPPORTS.tub, over: OBSTACLES.tub });
    await dog.do({ type: 'turn', yaw: Math.PI / 2 });
    this.stage = 'bath';
    this.bathStart = this.time;
    this.toast('Soak, lather, rinse until the water runs clear');
  }

  async _toTable() {
    if (this.stage !== 'bathDone' && this.stage !== 'bath') return;
    this.hud.prompt('');
    this.stage = 'toTable';
    const dog = this.dog;
    this.bubbles.releaseAll();
    this._frameStation('table');
    await dog.do({ type: 'jump', to: STATIONS.tubFront, groundY: 0, over: OBSTACLES.tub, rear: true });
    await dog.do({ type: 'walk', to: STATIONS.tableFront });
    await dog.do({ type: 'jump', to: STATIONS.table, groundY: TABLE.y, support: SUPPORTS.table, over: OBSTACLES.table });
    await dog.do({ type: 'turn', yaw: -Math.PI / 2 });
    this.stage = 'groom';
    this.toast('Blow-dry, brush out mats, then clip the cut');
  }

  async _handback() {
    this.stage = 'handback';
    this.hud.prompt('');
    const dog = this.dog;
    this.tools.select(0);
    await this._wait(1.2);
    await dog.do({ type: 'jump', to: STATIONS.tableFront, groundY: 0, over: OBSTACLES.table });
    this._frameStation('lobby');
    await dog.do({ type: 'walk', to: new THREE.Vector3(STATIONS.lobby.x, 0, STATIONS.lobby.z - 0.1) });
    await dog.do({ type: 'turn', yaw: Math.atan2(this.owner.group.position.x - dog.torso.pos.x, this.owner.group.position.z - dog.torso.pos.z) });
    // The proud shake.
    dog.excited = 3;
    await dog.do({ type: 'shake', amp: 0.8 });
    this.audio.bark(dog.B.bark, 2);
    this.owner.hop(3);
    this.owner.happy = 3;
    for (let i = 0; i < 8; i++) this.sparkles.emit('heart', this.owner.group.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 1.7 + Math.random() * 0.3, 0)), { v: new THREE.Vector3(0, 0.4, 0), size: 0.07, life: 2 });
    const result = this._score();
    this.result = result;
    await this._wait(0.6);
    this.coins.toss(this.owner.group.position.clone().add(new THREE.Vector3(0.1, 1.2, -0.2)), result.coins);
    this.save.money += result.total;
    this.save.served += 1;
    this.save.best = Math.max(this.save.best || 0, result.stars);
    this.save.photos.push({ img: this.photoData, name: this.appt.name, stars: result.stars });
    if (this.save.photos.length > 12) this.save.photos.shift();
    this.save.appt += 1;
    const dayDone = this.save.appt % APPTS_PER_DAY === 0;
    if (dayDone) this.save.day += 1;
    this._persist();
    await this._wait(1.6);
    this.hud.setMoney(this.save.money, true);
    this.audio.chime([0, 4, 7, 12, 16]);
    this.stage = 'checkout';
    this._openModal('checkout');
    fillCheckout(result, this.photoCanvas);
    if (dayDone) $('btn-next').textContent = `Closing time · start day ${this.save.day}`;
    else $('btn-next').textContent = 'Next appointment';
  }

  async _nextAppointment() {
    this._closeModal();
    this.stage = 'leaving';
    const dog = this.dog, owner = this.owner;
    this.salon.openDoor(true);
    this.audio.bell();
    const w1 = owner.walk([STATIONS.doorway, STATIONS.ownerOut]);
    const w2 = (async () => {
      await dog.do({ type: 'walk', to: STATIONS.doorway });
      await dog.do({ type: 'walk', to: STATIONS.outside });
    })();
    await Promise.race([Promise.all([w1, w2]), this._wait(7)]);
    this.salon.openDoor(false);
    this._clearDog();
    // Sweep up the clippings between dogs.
    this.tufts.clear();
    await this._wait(0.8);
    this._beginAppointment();
  }

  // ------------------------------------------------------------------
  _score() {
    const A = this.appt, dog = this.dog;
    const st = dog.refreshStats();
    const clean = clamp(st.clean, 0, 1);
    const dry = clamp(st.dry, 0, 1);
    const mats = st.matsTotal ? 1 - st.matsLeft / st.matsTotal : 1;
    // A shedding coat shares the "coat work" score between mats and undercoat.
    const deshed = st.sheds ? clamp(st.deshed / DESHED_DONE, 0, 1) : 1;
    const coatWork = st.sheds ? (st.matsTotal ? (mats + deshed) / 2 : deshed) : mats;
    const wantsCut = A.cut.lengths.some((x) => x != null);
    const cut = clamp(st.cut, 0, 1);
    let bow = 1;
    if (A.bow) bow = dog.bow ? (dog.bow.color === A.bow.hex ? 1 : 0.6) : 0;
    const happy = dog.happiness;
    let fluff = 0;
    for (let s = 0; s < dog.fur.S; s++) fluff += dog.fur.blown[s];
    fluff /= dog.fur.S;
    const score = clean * 0.26 + dry * 0.2 + coatWork * 0.14 + cut * (wantsCut ? 0.24 : 0.1) + bow * 0.06 + happy * 0.1 + (wantsCut ? 0 : 0.14 * fluff);
    const stars = clamp(Math.round(score * 5.6 - 0.6), 1, 5);
    const B = dog.B;
    const sizeBonus = B.mass > 20 ? 10 : B.mass > 10 ? 5 : 0;
    const price = A.cut.price + sizeBonus + (st.matsTotal ? 5 : 0);
    const cozy = cozyBonus(this.upgrades);
    const tip = Math.round(price * Math.max(0, stars - 2) * 0.12 * (1 + cozy) + (stars === 5 ? 5 : 0));
    const total = price + tip;
    const pct = (x) => `${Math.round(x * 100)}%`;
    const lines = [
      ['Clean', pct(clean)],
      ['Dry & fluffed', pct(dry)],
      ['Mats brushed out', st.matsTotal ? `${st.matsTotal - st.matsLeft} of ${st.matsTotal}` : 'none'],
      ...(st.sheds ? [['Undercoat out', pct(clamp(st.deshed, 0, 1))]] : []),
      [wantsCut ? `${A.cut.name} match` : 'Fluff factor', wantsCut ? pct(cut) : pct(fluff)],
      ['Bow', A.bow ? (dog.bow ? (bow === 1 ? `${A.bow.name}, perfect` : 'wrong colour') : 'forgot it') : dog.bow ? 'a nice surprise' : 'none asked'],
      ['Happiness', '♥'.repeat(Math.max(1, Math.round(happy * 5)))],
      [`${A.cut.name}${sizeBonus ? ' (big dog)' : ''}`, `$${price}`],
      ['Tip', `$${tip}`],
    ];
    const titles = {
      5: fluff > 0.5 ? `${A.name} is a cloud!` : `${A.name} looks perfect`,
      4: `${A.name} looks fabulous`,
      3: `${A.name} is fresh and clean`,
      2: `${A.name} is… mostly clean`,
      1: `${A.name} is still a bit swampy`,
    };
    const quotes = {
      5: ['I could cry. Look at that FLOOF.', 'Is that even my dog? It is! It is!', 'Same time next month. Forever.'],
      4: ['Oh, they look wonderful!', 'So soft! Thank you so much!', 'They smell like a cupcake.'],
      3: ['Nice and clean, thank you.', 'Much better than this morning!'],
      2: ['Hmm. Still a bit damp?', 'Well… they seem happy.'],
      1: ['Was there a bath in there somewhere?', 'We will… try again next time.'],
    };
    return { stars, lines, total, tip, price, title: titles[stars], quote: pick(quotes[stars]), coins: Math.min(18, Math.ceil(total / 4)) };
  }

  // ------------------------------------------------------------------
  // Hooks from tools.
  cutName() {
    return this.appt?.cut.name ?? 'cut';
  }

  placeBow(point, hex) {
    const dog = this.dog;
    if (!dog) return;
    const local = point.clone().sub(dog.head.pos).applyQuaternion(dog.head.quat.clone().invert());
    // Snap the bow to just above the head surface.
    const r = dog.B.head.r;
    const n = local.clone().set(local.x / r[0], local.y / r[1], local.z / r[2]).normalize();
    local.set(n.x * r[0], n.y * r[1], n.z * r[2]).multiplyScalar(1.05);
    if (local.y < r[1] * 0.2) local.y = r[1] * 0.7;
    const furLift = Math.min(0.06, dog.fur.natLen[0] * 0.3);
    local.addScaledVector(n, furLift);
    if (dog.bow) dog.bow.dispose();
    const size = Math.max(0.7, Math.min(1.3, dog.B.head.r[0] / 0.09));
    dog.bow = new Bow(hex, local, size);
    dog.bow.attach(this.scene);
    this.audio.chime([0, 7, 12], 0.07, 0.07);
    this.buzz(20);
    this.sparkles.burst('star', point, 8, 0.6, { color: hex, size: 0.03 });
    dog.please(0.05);
    dog.excited = 1;
    if (!this.flags.bowToast) {
      this.flags.bowToast = true;
      this.toast(this.appt.bow && this.appt.bow.hex === hex ? 'Perfect bow!' : 'Bow tied');
    }
  }

  popBubble(p, r) {
    this.audio.pop();
    this.sparkles.emit('mist', p, { size: r * 2.2, life: 0.25 });
    for (let i = 0; i < 3; i++) this.water.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 0.8, Math.random() * 0.5, (Math.random() - 0.5) * 0.8, 0, 0.003);
  }

  onMatCleared(mi) {
    const dog = this.dog;
    const mat = dog.fur.mats[mi];
    const p = new THREE.Vector3(mat.cx, mat.cy, mat.cz);
    this.audio.boing(1.2);
    this.buzz(40);
    this.sparkles.burst('star', p, 10, 0.8, { color: '#f6d68a', size: 0.035 });
    // A few clumps of shed undercoat fly off.
    for (let i = 0; i < 6; i++) {
      const s = mat.strands[Math.floor(Math.random() * mat.strands.length)];
      dog.fur.strandColor(s, false, col3);
      this.tufts.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 1.2, Math.random() * 1.2, (Math.random() - 0.5) * 1.2, dog.fur.puff[s] * 1.2, [...col3]);
    }
    dog.please(0.06);
    const left = dog.fur.matsLeft;
    this.toast(left ? `Mat brushed out! ${left} to go` : 'No more mats!');
  }

  maybeSneeze(dog) {
    if (this.time - (this.lastSneeze || 0) < 3) return;
    if (Math.random() > 0.35 * this.dogFear.dryer) return;
    this.lastSneeze = this.time;
    // Achoo: a sharp head pitch impulse.
    dog.head.angVel.addScaledVector(_v.set(1, 0, 0).applyQuaternion(dog.head.quat), 14);
    dog.upset(0.02 * this.dogFear.dryer);
    this.audio.bark(dog.B.bark * 0.3 + 0.2, 1);
    this.sparkles.burst('mist', dog.head.pos.clone().add(_v.set(0, -0.02, 0.12).applyQuaternion(dog.head.quat)), 4, 0.4, { size: 0.03 });
  }

  takePhoto() {
    if (this.stage !== 'groom') {
      this.toast(this.stage === 'bath' ? 'Save the photo for when they are fluffy' : 'Nothing to photograph yet');
      return;
    }
    const st = this.dog.refreshStats();
    if (st.dry < 0.6 && !this.flags.dryWarn) {
      this.flags.dryWarn = true;
      this.toast('Still soggy! Click again to finish anyway');
      return;
    }
    this.hud.flash();
    this.audio.shutter();
    this.buzz(30);
    this.tools.rig.visible = false;
    this.dog.squint = 0;
    const A = this.appt;
    const dog = this.dog;
    const center = dog.torso.pos.clone().lerp(dog.head.pos, 0.35);
    const radius = dog.B.torso[2] + dog.B.fur.len + 0.12;
    const canvas = capturePolaroid(this.renderer, this.scene, this.camera, A.name, `${A.cut.name} · day ${this.save.day}`, { center, radius });
    this.tools.rig.visible = true;
    this.photoCanvas = canvas;
    this.photoData = canvasToDataURL(canvas);
    const from = new THREE.Vector3();
    this.tools.models.camera.g.getWorldPosition(from);
    this.photoWall.addFresh(canvas, from);
    this._handback();
  }

  // ------------------------------------------------------------------
  _dogEvent(type, dog) {
    if (type === 'land') {
      this.audio.boing(0.6);
      if (dog.groundY === TUB.floor) this.sparkles.burst('mist', dog.torso.pos.clone().setY(TUB.floor + 0.05), 6, 0.6, { size: 0.06 });
    } else if (type === 'jump') {
      this.audio.boing(1);
    } else if (type === 'shake') {
      const wet = dog.fur.stats().wetAvg;
      this.audio.shakeRattle(0.4 + wet);
    } else if (type === 'pawstep') {
      if (Math.random() < 0.4) this.audio.clink(0.12);
    }
  }

  _interact(origin, dir, range = 2.2) {
    const ray = new THREE.Raycaster(origin, dir, 0, range);
    const objs = this.salon.interactables.filter((i) => i.object.visible && (i.id !== 'radio' || this.upgrades.radio));
    const hits = ray.intersectObjects(objs.map((i) => i.object), false);
    if (!hits.length) return null;
    return objs.find((i) => i.object === hits[0].object);
  }

  _doInteract(item) {
    if (!item) return false;
    switch (item.id) {
      case 'treat':
        this._tossTreat();
        break;
      case 'shop':
        this.openShop('play');
        break;
      case 'bell':
        this.salon.pressServiceBell();
        this.audio.bell();
        if (this.dog) {
          this.dog.lookAt(this.salon.serviceBell.g.position, 1);
          this.dog.excited = 1;
        }
        break;
      case 'radio':
        this.audio.setMusic(!this.audio.musicOn);
        this.save.music = this.audio.musicOn;
        this._musicLabel();
        this._persist();
        this.toast(this.audio.musicOn ? 'Radio on' : 'Radio off');
        break;
    }
    return true;
  }

  _tossTreat() {
    const dog = this.dog;
    if (!dog || this.stage === 'arrive' || this.stage === 'leaving') {
      this.toast('No one here to spoil yet');
      return;
    }
    const start = this.camera.position.clone().add(new THREE.Vector3(0, -0.15, 0));
    const tgt = dog.head.pos.clone().add(new THREE.Vector3(0, 0.05, 0));
    const T = 0.55 + start.distanceTo(tgt) * 0.12;
    const v = new THREE.Vector3((tgt.x - start.x) / T, (tgt.y - start.y + 0.5 * 9.81 * T * T) / T, (tgt.z - start.z) / T);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.035, 3, 6), new THREE.MeshStandardMaterial({ color: '#d9a066', roughness: 0.8 }));
    m.position.copy(start);
    this.scene.add(m);
    this.treats.push({ m, p: start, v, t: 0, spin: new THREE.Vector3(Math.random() * 10, Math.random() * 10, 0) });
    this.audio.click();
  }

  _updateTreats(dt) {
    for (let i = this.treats.length - 1; i >= 0; i--) {
      const t = this.treats[i];
      t.t += dt;
      t.v.y -= 9.81 * dt;
      t.p.addScaledVector(t.v, dt);
      t.m.position.copy(t.p);
      t.m.rotation.x += t.spin.x * dt;
      t.m.rotation.y += t.spin.y * dt;
      const dog = this.dog;
      if (dog) {
        dog.lookAt(t.p, 0.3);
        // Snap! The head lunges toward a close treat.
        const d = dog.head.pos.distanceTo(t.p);
        if (d < 0.35) dog.head.vel.addScaledVector(_v.subVectors(t.p, dog.head.pos), dt * 40);
        if (d < 0.12) {
          this.scene.remove(t.m);
          this.treats.splice(i, 1);
          dog.please(this.upgrades.treats ? 0.25 : 0.14);
          dog.stress = 0;
          dog.excited = 2.5;
          this.audio.boing(1.6);
          this.sparkles.burst('heart', dog.head.pos.clone().add(_v.set(0, 0.12, 0)), 5, 0.4, { size: 0.045 });
          continue;
        }
      }
      if (t.t > 3 || this.salon.surface(t.p.x, t.p.y, t.p.z)) {
        this.scene.remove(t.m);
        this.treats.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------------
  // Modals and pausing.
  _openModal(id) {
    this.modal = id;
    showScreen(id, true);
    this.input.exitLock();
    this.input.use = false;
  }

  _closeModal() {
    if (this.modal) showScreen(this.modal, false);
    this.modal = null;
    this.input.requestLock();
  }

  pause() {
    if (this.modal) return;
    this._openModal('pause');
  }

  resume() {
    this._closeModal();
  }

  openShop(from) {
    if (this.modal) showScreen(this.modal, false);
    this.shopFrom = from === 'checkout' ? 'checkout' : null;
    this.modal = 'shop';
    showScreen('shop', true);
    this.input.exitLock();
    this._renderShop();
  }

  _renderShop() {
    buildShop(UPGRADES, this.upgrades, this.save.money, (u) => {
      if (this.save.money < u.cost || this.upgrades[u.id]) return;
      this.save.money -= u.cost;
      this.upgrades[u.id] = true;
      this.salon.setUpgrades(this.upgrades);
      this.photoWall.load(this.save.photos);
      this._persist();
      this.hud.setMoney(this.save.money, true);
      this.audio.chime([0, 4, 7]);
      this.toast(`${u.name} added!`);
      this._renderShop();
    });
  }

  closeShop() {
    showScreen('shop', false);
    this.modal = null;
    if (this.shopFrom === 'checkout') {
      this.modal = 'checkout';
      showScreen('checkout', true);
    } else this.input.requestLock();
  }

  toast(text, big = false) {
    this.hud.toast(text, big);
  }

  _wait(s) {
    return new Promise((r) => setTimeout(r, s * 1000));
  }

  _clockText() {
    const t = this.apptClock;
    const h = Math.floor(t / 3600) % 24, m = Math.floor((t % 3600) / 60);
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
  }

  // ------------------------------------------------------------------
  // HUD checklist.
  _updateSteps() {
    const A = this.appt, dog = this.dog;
    if (!A || !dog) return;
    const st = this.stats ?? dog.refreshStats();
    const stage = this.stage;
    const after = (s) => ['bathDone', 'toTable', 'groom', 'handback', 'checkout', 'leaving'].includes(s);
    const runoff = this.salon.tubDirt;
    const runCol = `#${new THREE.Color('#bfe6ef').lerp(new THREE.Color('#7A5A3C'), Math.min(1, runoff * 1.2)).getHexString()}`;
    const rinsing = this.salon.tubFlow > 0.05 || this.flags.rinsed;
    if (this.salon.tubFlow > 0.05) this.flags.rinsed = true;
    const runLabel = !rinsing ? 'not yet' : runoff < 0.12 ? 'clear' : runoff < 0.35 ? 'cloudy' : 'muddy';
    const wantsCut = A.cut.lengths.some((x) => x != null);
    const steps = [];
    const bathDone = after(stage);
    steps.push({ label: 'Check in', state: stage === 'arrive' || stage === 'checkin' ? 'active' : 'done' });
    steps.push({
      label: 'Bath until clean', val: `${Math.round(clamp(st.clean, 0, 1) * 100)}%`, pct: clamp(st.clean / 0.8, 0, 1),
      state: bathDone ? 'done' : stage === 'bath' || stage === 'toTub' ? 'active' : 'todo',
    });
    steps.push({
      label: 'Rinse: water runs clear', val: st.lather > 0.03 && rinsing ? 'soapy' : runLabel, swatch: rinsing ? runCol : null,
      state: bathDone ? 'done' : stage === 'bath' ? 'active' : 'todo',
    });
    const groomActive = stage === 'groom' || stage === 'toTable';
    const groomSeen = groomActive || stage === 'handback' || stage === 'checkout';
    const dryDone = st.dry >= 0.95;
    steps.push({ label: 'Blow-dry', val: groomSeen ? `${Math.round(st.dry * 100)}%` : '', pct: groomSeen ? st.dry : null, state: dryDone && bathDone ? 'done' : groomActive ? 'active' : 'todo' });
    if (st.matsTotal) steps.push({ label: 'Brush out mats', val: `${st.matsTotal - st.matsLeft}/${st.matsTotal}`, pct: groomSeen ? 1 - st.matsLeft / st.matsTotal : null, state: st.matsLeft === 0 ? 'done' : groomActive ? 'active' : 'todo' });
    if (st.sheds) steps.push({ label: 'De-shed the undercoat', val: groomSeen ? `${Math.round(st.deshed * 100)}%` : '', pct: groomSeen ? clamp(st.deshed / DESHED_DONE, 0, 1) : null, state: st.deshed >= DESHED_DONE ? 'done' : groomActive ? 'active' : 'todo' });
    if (wantsCut) steps.push({ label: `Clip: ${A.cut.name}`, val: groomSeen ? `${Math.round(clamp(st.cut, 0, 1) * 100)}%` : '', pct: groomSeen ? st.cut : null, state: st.cut >= 0.85 ? 'done' : groomActive ? 'active' : 'todo' });
    if (A.bow) steps.push({ label: `${A.bow.name} bow`, swatch: A.bow.hex, state: dog.bow ? 'done' : groomActive ? 'active' : 'todo' });
    steps.push({ label: 'Photo & hand back', state: stage === 'handback' || stage === 'checkout' ? 'done' : groomActive ? 'active' : 'todo' });
    this.hud.setSteps(steps);

    // Nudge the right tools.
    let sug = [];
    if (stage === 'bath') {
      if (st.wetAvg < 0.5) sug = ['spray'];
      else if (st.clean < 0.8 && st.lather + st.soap < 0.15) sug = ['shampoo', 'hands'];
      else if (st.clean < 0.8) sug = ['hands', 'spray'];
      else sug = ['spray'];
    } else if (stage === 'groom') {
      if (!dryDone || (st.sheds && st.deshed < DESHED_DONE)) sug.push('dryer');
      if (st.matsLeft || (st.sheds && st.deshed < DESHED_DONE && dryDone)) sug.push('brush');
      if (wantsCut && st.cut < 0.85) sug.push('clippers');
      if (A.bow && !dog.bow) sug.push('bow');
      if (!sug.length) sug = ['camera'];
    }
    this.hud.suggest(sug);
  }

  // ------------------------------------------------------------------
  frame(now) {
    requestAnimationFrame(this.frame);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) return;
    this._adaptResolution(dt);
    dt = Math.min(dt, 1 / 30);
    this.time += dt;
    const t0 = performance.now();
    this.update(dt);
    const t1 = performance.now();
    if (!this.skipRender) this.renderer.render(this.scene, this.camera);
    const t2 = performance.now();
    this._tUpdate = (this._tUpdate ?? 0) * 0.9 + (t1 - t0) * 0.1;
    this._tRender = (this._tRender ?? 0) * 0.9 + (t2 - t1) * 0.1;
  }

  update(dt) {
    const input = this.input;
    const frozen = !!this.modal || this.stage === 'title';
    const dog = this.dog;

    // Player & camera.
    if (this.stage === 'title') {
      // A slow, springy drift around the salon behind the title card.
      this.titleSway.target = Math.sin(this.time * 0.25) * 0.12;
      this.titleSway.update(dt);
      this.player.yaw = this.titleYaw + this.titleSway.value;
      input.consumeLook();
      this.player.update(dt, input, true);
    } else this.player.update(dt, input, frozen);

    // Aim.
    this.player.aim(input, _o, _d);
    const canUse = !frozen && input.enabled;

    // Without pointer lock (some embeds), the cursor aims and right-drag looks.
    if (input.lockFailed && this.playing && !this.lookHintShown && !input.touchMode) {
      this.lookHintShown = true;
      this.toast('Aim with the cursor. Right-drag or arrow keys to look around');
    }

    // Hotkeys.
    if (!frozen) {
      if (input.hit('KeyB')) this.openShop('play');
      if (input.hit('KeyM')) {
        this.audio.setMusic(!this.audio.musicOn);
        this.save.music = this.audio.musicOn;
        this._musicLabel();
      }
      if (input.hit('KeyF')) {
        const item = this._interact(_o, _d);
        if (!this._doInteract(item) && this.promptAction) this.promptAction();
      }
      if (dog && (this.stage === 'bath' || this.stage === 'bathDone' || this.stage === 'groom') && !dog.busy) {
        const turn = (input.down('KeyE') ? 1 : 0) - (input.down('KeyQ') ? 1 : 0);
        if (turn && dog.support.walls) {
          // The tub is too narrow to pivot in: hop up and turn around in the air.
          dog.do({ type: 'jump', to: dog.targetPos.clone(), groundY: dog.groundY, support: dog.support, small: true, time: 0.5, yawInAir: dog.heading + Math.PI });
        } else dog.heading -= turn * dt * 1.6;
      }
    }

    // Touch controls only while actually playing.
    const showTouch = input.touchMode && !this.modal && this.stage !== 'title';
    if (showTouch !== this._touchShown) {
      this._touchShown = showTouch;
      $('touch').hidden = !showTouch;
    }

    // Tools.
    const stageForTools = this.stage;
    if (!frozen) {
      const res = this.tools.update(dt, { input, dog: this.playing ? dog : null, origin: _o, dir: _d, canUse, stage: stageForTools });
      let hint = this.tools.hint;
      if (input.touchMode) {
        // The reticle and hint ride above the finger holding the tool; taps poke objects.
        const r = this.canvas.getBoundingClientRect();
        if (input.useFinger != null) {
          const ax = r.left + input.cursorX * r.width, ay = r.top + input.cursorY * r.height;
          this.hud.setFinger(ax, ay, !!res.hit);
          this.hud.setHint(hint, ax, ay - 64);
          if (input.grabbing) this._edgePan(dt, input);
        } else {
          this.hud.setFinger(null);
          this.hud.setHint('');
        }
        // A soft ring round the tool says "pick me up" until you have the hang of it.
        const offerGrab = !input.grabbing && this.tools.id !== 'camera' && ['bath', 'bathDone', 'groom'].includes(this.stage);
        if (offerGrab) {
          const t = this.tools.screenPos(_grab);
          this.hud.setGrab(t.x, t.y, t.r, input.grabs < 3 ? `Drag the ${TOOL_DEFS[this.tools.index].name.toLowerCase()}` : '');
        } else this.hud.setGrab(null);
        for (const t of input.takeTaps()) {
          this._rayAt(t.x, t.y, _to, _td);
          this._doInteract(this._interact(_to, _td, 8));
        }
      } else {
        if (!hint) {
          const item = this._interact(_o, _d);
          if (item) hint = `F · ${item.label}`;
          this.hud.setCrosshair(!!item || !!res.hit, input.freeAim);
        } else this.hud.setCrosshair(true, input.freeAim);
        this.hud.setHint(hint);
        // Hands can click things too.
        if (this.tools.id === 'hands' && input.usePressed && !res.hit) this._doInteract(this._interact(_o, _d));
      }
    } else {
      input.takeTaps();
      if (input.touchMode) {
        this.hud.setFinger(null);
        this.hud.setGrab(null);
      }
      this.tools.dryerOn = 0;
      if (this.audio.ctx) for (const k of ['spray', 'dryer', 'clip', 'scrub']) this.audio.setLoop(k, 0);
    }

    // Dog physics.
    const wind = this.tools.windAt;
    if (dog) {
      const hint = this.stage === 'groom' ? (this.tools.id === 'clippers' ? 'clip' : this.tools.id === 'brush' ? 'brush' : null) : null;
      dog.update(dt, { camera: this.camera, hint });
    }
    if (this.owner) this.owner.update(dt, this.player.pos.clone().setY(1.6));

    // Shake: fling water from a wet coat.
    if (dog && dog.shakeT >= 0) this._shakeFling(dog);
    // Drips from a soaked dog.
    if (dog && this.stats && this.stats.wetAvg > 0.3 && Math.random() < dt * 30 * this.stats.wetAvg) {
      const s = Math.floor(Math.random() * dog.fur.S);
      if (dog.fur.wet[s] > 0.5) {
        const i3 = dog.fur.tipIndex(s) * 3;
        this.water.spawn(dog.fur.pos[i3], dog.fur.pos[i3 + 1] - 0.01, dog.fur.pos[i3 + 2], 0, -0.2, 0, Math.min(1, dog.fur.dirt[s] + dog.fur.loose[s] * 2), 0.006, 2);
      }
    }

    // Effects.
    this.water.update(dt, this.salon, this.playing ? dog : null, {
      onDogHit: (x, y, z) => {
        if (Math.random() < 0.06) this.sparkles.emit('mist', _v.set(x, y, z), { size: 0.035, life: 0.35, color: '#e8f8fc' });
      },
      onSplash: (x, y, z, dirt, kind) => {
        if (kind === 'floor' && Math.random() < 0.3) this.salon.splashFloor(x, z);
      },
    });
    const ev = this.water.events;
    this.salon.addRunoff(ev.tub, ev.tubDirt);
    this.audio.ctx && this.audio.setLoop('drain', Math.min(0.08, this.salon.tubFlow * 0.08));
    this.gel.update(dt, this.salon, this.playing ? dog : null, (p, kind) => {
      this.audio.splat();
      if (kind === 'dog' && dog) {
        dog.fur.soapAt(p.x, p.y, p.z, 0.11, 1.1 * (this.upgrades.bubbly ? 1.3 : 1));
        for (let i = 0; i < 3; i++) {
          const s = Math.floor(Math.random() * dog.fur.S);
          const i3 = dog.fur.tipIndex(s) * 3;
          if (Math.hypot(dog.fur.pos[i3] - p.x, dog.fur.pos[i3 + 1] - p.y, dog.fur.pos[i3 + 2] - p.z) < 0.12) this.bubbles.stick(dog.fur.tipIndex(s), dog.fur);
        }
        this.bubbles.free(p.clone(), new THREE.Vector3(0, 0.3, 0), 0.015);
      } else this.sparkles.emit('mist', p, { size: 0.04, color: '#f6a8c8', life: 0.4 });
    });
    this.bubbles.update(dt, this.time, this.salon, wind, (p, r) => {
      this.audio.pop(0.6);
      this.sparkles.emit('mist', p, { size: r * 2, life: 0.2 });
    });
    this.tufts.update(dt, this.time, this.salon, dog, wind);
    this.sparkles.update(dt, this.time);
    this.coins.update(dt);
    this.photoWall.update(dt, wind);
    this._updateTreats(dt);

    // Salon ambience.
    if (this.playing && this.stage !== 'checkin') this.apptClock += dt * 6;
    this.salon.update(dt, {
      wind,
      musicOn: this.audio.musicOn,
      clockSeconds: this.apptClock,
      dog: this.playing ? dog : null,
      sprayEnd: this.tools.id === 'spray' ? this.tools.hoseEnd : null,
      dryerEnd: this.tools.id === 'dryer' ? this.tools.hoseEnd : null,
    });

    // Stats & stage goals (a few times a second).
    this.statTimer -= dt;
    if (dog && this.statTimer <= 0) {
      this.statTimer = 0.2;
      this.stats = dog.refreshStats();
      this._checkGoals();
      this._updateSteps();
      this.hud.setDay(this.save.day, this._clockText());
    }

    // Speech bubble over the owner.
    if (this.owner && this.speechTimer > 0) {
      this.speechTimer -= dt;
      const p = this.owner.speechAnchor(new THREE.Vector3()).project(this.camera);
      if (p.z < 1 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1) this.hud.speech(this.speechText, (p.x * 0.5 + 0.5) * innerWidth, (-p.y * 0.5 + 0.5) * innerHeight);
      else this.hud.speech('');
    } else this.hud.speech('');

    this.hud.update(dt);
    input.endFrame();
  }

  // Dragging a tool towards the screen edge turns the view that way, so a held tool can reach
  // the far end of the dog without letting go.
  _edgePan(dt, input) {
    const x = input.fingerX, y = input.fingerY;
    const P = this.player;
    if (x < 0.1) P.yaw += ((0.1 - x) / 0.1) * 1.3 * dt;
    else if (x > 0.9) P.yaw -= ((x - 0.9) / 0.1) * 1.3 * dt;
    if (y < 0.14) P.pitch = clamp(P.pitch + ((0.14 - y) / 0.14) * 0.9 * dt, -1.4, 1.35);
    P.glide = null;
  }

  _shakeFling(dog) {
    const f = dog.fur;
    for (let n = 0; n < 40; n++) {
      const s = Math.floor(Math.random() * f.S);
      const i3 = f.tipIndex(s) * 3;
      const vx = (f.pos[i3] - f.prev[i3]) * 120, vy = (f.pos[i3 + 1] - f.prev[i3 + 1]) * 120, vz = (f.pos[i3 + 2] - f.prev[i3 + 2]) * 120;
      if (f.wet[s] > 0.25) {
        this.water.spawn(f.pos[i3], f.pos[i3 + 1], f.pos[i3 + 2], vx * 1.4, vy * 1.4 + 0.5, vz * 1.4, Math.min(1, f.dirt[s] * 0.8), 0.007, 2);
        f.wet[s] = Math.max(0, f.wet[s] - 0.04);
      } else if (Math.random() < 0.08) {
        this.sparkles.emit('star', new THREE.Vector3(f.pos[i3], f.pos[i3 + 1], f.pos[i3 + 2]), { v: new THREE.Vector3(vx * 0.3, vy * 0.3 + 0.3, vz * 0.3), size: 0.025, life: 0.6 });
      }
    }
  }

  _checkGoals() {
    const st = this.stats, dog = this.dog;
    this.promptAction = null;
    if (this.stage === 'bath') {
      const clean = st.clean >= 0.8 && st.lather < 0.03 && st.soap < 0.08 && this.salon.tubDirt < 0.12;
      if (clean) {
        this.stage = 'bathDone';
        this.audio.squeak();
        this.buzz([20, 40, 20]);
        this.toast('Squeaky clean!', true);
        this.sparkles.burst('star', dog.torso.pos.clone().add(_v.set(0, 0.2, 0)), 16, 1.0, { size: 0.035 });
        dog.please(0.08);
        dog.do({ type: 'wait', time: 0.4 }).then(() => dog.do({ type: 'shake', amp: 1 }));
      } else if (st.clean >= 0.6 && this.time - this.bathStart > 20) {
        this._prompt('Move to the table early', 'F', () => this._toTable());
      } else this.hud.prompt('');
      if (st.wetAvg < 0.2 && st.soap > 0.2 && !this.flags.wetHint) {
        this.flags.wetHint = true;
        this.toast('Soak the coat first so the shampoo can lather');
      }
    }
    if (this.stage === 'bathDone') this._prompt(`Move ${this.appt.name} to the table`, 'F', () => this._toTable());
    if (this.stage === 'groom') {
      const A = this.appt;
      let fluffy = 0;
      for (let s = 0; s < dog.fur.S; s += 4) fluffy += dog.fur.blown[s];
      fluffy /= dog.fur.S / 4;
      if (!this.flags.cloud && st.dry > 0.92 && fluffy > 0.45) {
        this.flags.cloud = true;
        this.toast(dog.B.fur.len > 0.075 ? 'Perfect cloud!' : 'So fluffy!', true);
        this.audio.chime([0, 4, 7, 11, 14]);
        this.audio.bark(dog.B.bark, 2);
        this.buzz([30, 50, 30, 50, 60]);
        dog.excited = 4;
        dog.please(0.15);
        this.sparkles.burst('star', dog.torso.pos.clone().add(_v.set(0, 0.25, 0)), 24, 1.2, { size: 0.04 });
        this.sparkles.burst('heart', dog.head.pos.clone().add(_v.set(0, 0.15, 0)), 4, 0.3, { size: 0.05 });
      }
      if (!this.flags.dryToast && st.dry >= 0.95) {
        this.flags.dryToast = true;
        if (this.flags.cloud) this.toast('Bone dry');
      }
      const wantsCut = A.cut.lengths.some((x) => x != null);
      if (wantsCut && !this.flags.cutToast && st.cut >= 0.85) {
        this.flags.cutToast = true;
        this.toast(`${A.cut.name} looks right!`);
        this.audio.chime([0, 7, 12]);
      }
      if (st.sheds && !this.flags.deshedToast && st.deshed >= DESHED_DONE) {
        this.flags.deshedToast = true;
        this.toast('Undercoat all out! Look at that pile');
        this.audio.chime([0, 5, 9]);
        this.buzz([20, 30, 20]);
        dog.please(0.08);
      } else if (st.sheds && !this.flags.shedHint && st.dry > 0.7 && st.deshed < 0.3 && this.tools.id !== 'brush') {
        this.flags.shedHint = true;
        this.toast('Loose undercoat! Blow it out on high, then brush');
      }
      const ready = st.dry >= 0.95 && st.matsLeft === 0 && (!st.sheds || st.deshed >= DESHED_DONE) && (!wantsCut || st.cut >= 0.85) && (!A.bow || dog.bow);
      if (ready) {
        this._prompt(this.input.touchMode ? 'All done! Tap for the camera' : 'All done! Grab the camera for the photo', '8', () => this.tools.select(7));
        if (!this.flags.readyToast) {
          this.flags.readyToast = true;
          this.toast('Ready for the Wall of Fluff', true);
        }
      } else if (st.dry >= 0.6) this._prompt(this.input.touchMode ? 'Done? Tap for the camera' : 'Finish with a photo whenever you like', '8', () => this.tools.select(7));
      else this.hud.prompt('');
    }
  }

  _prompt(text, key, action) {
    this.promptAction = action;
    this.hud.prompt(text, key, action);
  }
}
