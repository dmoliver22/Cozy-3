// Keyboard, mouse (pointer lock with a drag-to-look fallback) and touch, collapsed into one state.
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // keys pressed this frame
    this.lookDX = 0;
    this.lookDY = 0;
    this.use = false;
    this.alt = false;
    this.altPressed = false;
    this.usePressed = false;
    this.wheel = 0;
    this.locked = false;
    this.lockFailed = false;
    this.enabled = false;
    this.cursorX = 0.5; // normalised aim when pointer lock is unavailable
    this.cursorY = 0.5;
    this.dragLook = false;
    this.touchMode = false;
    this.move = { x: 0, y: 0 }; // touch stick
    this.onLockChange = null;

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = e.code;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.use = false;
      this.alt = false;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.touchMode || e.sourceCapabilities?.firesTouchEvents) return;
      if (!this.locked && !this.lockFailed && e.button === 0) {
        this.requestLock();
      }
      if (e.button === 0) {
        this.use = true;
        this.usePressed = true;
      } else if (e.button === 2) {
        if (this.locked) {
          this.alt = true;
          this.altPressed = true;
        } else this.dragLook = true;
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.use = false;
      if (e.button === 2) {
        this.alt = false;
        this.dragLook = false;
      }
    });
    addEventListener('mousemove', (e) => {
      if (!this.enabled || this.touchMode) return;
      if (this.locked) {
        this.lookDX += e.movementX;
        this.lookDY += e.movementY;
      } else {
        const r = canvas.getBoundingClientRect();
        this.cursorX = (e.clientX - r.left) / r.width;
        this.cursorY = (e.clientY - r.top) / r.height;
        if (this.dragLook) {
          this.lookDX += e.movementX;
          this.lookDY += e.movementY;
        }
      }
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false }
    );

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.use = false;
        this.alt = false;
      }
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.lockFailed = true;
    });
  }

  requestLock() {
    if (this.touchMode || this.lockFailed) return;
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && p.catch) p.catch(() => (this.lockFailed = true));
      if (!this.canvas.requestPointerLock) this.lockFailed = true;
    } catch {
      this.lockFailed = true;
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  // Free-cursor aiming is used when the pointer is not locked (embedded frames).
  get freeAim() {
    return !this.locked && !this.touchMode;
  }

  // Aim from the cursor (mouse without lock) or from the grooming finger's reticle (touch). The
  // frame a finger lets go still aims where it was, so a dragged bow drops where it was released.
  get aimFromCursor() {
    return this.touchMode ? this.useFinger != null || this.released : !this.locked;
  }

  // Touch: every finger is classified when it lands. A finger on the tool in hand picks it up and
  // drags it (the tool aims at a reticle just above the fingertip, so the finger never hides what
  // you are grooming), a finger on an object is a tap, anything else drags the view around.
  setupTouch(els) {
    if (this.touchReady) return;
    this.touchReady = true;
    this.touchMode = true;
    this.use = false;
    const { stick, knob, turnL, turnR, crouch, canvas } = els;
    this.taps = [];
    this.useFinger = null;
    this.grabbing = false;
    this.released = false;
    this.fingerX = this.fingerY = 0.5;
    this.grabs = 0;
    this.crouch = false;
    const fingers = new Map();
    // Normalised finger and aim positions; a grabbed tool aims at the reticle above the finger.
    const norm = (e, grab) => {
      const r = canvas.getBoundingClientRect();
      this.fingerX = (e.clientX - r.left) / r.width;
      this.fingerY = (e.clientY - r.top) / r.height;
      const [ax, ay] = grab && this.reticle ? this.reticle(e.clientX, e.clientY) : [e.clientX, e.clientY];
      this.cursorX = (ax - r.left) / r.width;
      this.cursorY = (ay - r.top) / r.height;
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !this.enabled) return;
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      let mode = this.classify?.(e.clientX, e.clientY) ?? 'look';
      if ((mode === 'use' || mode === 'grab') && this.useFinger != null) mode = 'look';
      fingers.set(e.pointerId, { mode, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: 0, t: performance.now() });
      if (mode === 'use' || mode === 'grab') {
        this.useFinger = e.pointerId;
        this.grabbing = mode === 'grab';
        if (this.grabbing) this.grabs++;
        norm(e, this.grabbing);
        this.use = true;
        this.usePressed = true;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const f = fingers.get(e.pointerId);
      if (!f) return;
      e.preventDefault();
      const dx = e.clientX - f.x, dy = e.clientY - f.y;
      f.x = e.clientX;
      f.y = e.clientY;
      f.moved += Math.abs(dx) + Math.abs(dy);
      if (f.mode === 'use' || f.mode === 'grab') norm(e, f.mode === 'grab');
      else {
        if (f.mode === 'tap' && f.moved > 12) f.mode = 'look';
        if (f.mode === 'look') {
          this.lookDX += dx * 1.35;
          this.lookDY += dy * 1.35;
        }
      }
    });
    const end = (e) => {
      const f = fingers.get(e.pointerId);
      if (!f) return;
      fingers.delete(e.pointerId);
      if (f.mode === 'use' || f.mode === 'grab') {
        this.use = false;
        this.useFinger = null;
        this.grabbing = false;
        this.released = e.type === 'pointerup';
      } else if (f.moved < 12 && performance.now() - f.t < 450 && e.type === 'pointerup') {
        this.taps.push({ x: e.clientX, y: e.clientY });
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    // Walking stick.
    let stickId = null, sx = 0, sy = 0;
    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      stickId = e.pointerId;
      try { stick.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const r = stick.getBoundingClientRect();
      sx = r.left + r.width / 2;
      sy = r.top + r.height / 2;
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      const rad = stick.offsetWidth * 0.4;
      let dx = (e.clientX - sx) / rad, dy = (e.clientY - sy) / rad;
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      this.move.x = dx;
      this.move.y = dy;
      knob.style.transform = `translate(${dx * rad * 0.75}px, ${dy * rad * 0.75}px)`;
    });
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      this.move.x = this.move.y = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    const hold = (btn, on, off) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.classList.add('on');
        on();
      });
      const up = () => {
        btn.classList.remove('on');
        off?.();
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
    };
    hold(turnL, () => this.keys.add('KeyQ'), () => this.keys.delete('KeyQ'));
    hold(turnR, () => this.keys.add('KeyE'), () => this.keys.delete('KeyE'));
    crouch.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.crouch = !this.crouch;
      crouch.classList.toggle('on', this.crouch);
    });
  }

  takeTaps() {
    if (!this.taps?.length) return [];
    const t = this.taps;
    this.taps = [];
    return t;
  }

  consumeLook() {
    const d = [this.lookDX, this.lookDY];
    this.lookDX = this.lookDY = 0;
    return d;
  }

  endFrame() {
    this.pressed.clear();
    this.usePressed = false;
    this.released = false;
    this.altPressed = false;
    this.wheel = 0;
  }

  down(code) {
    return this.keys.has(code);
  }

  hit(code) {
    return this.pressed.has(code);
  }
}
