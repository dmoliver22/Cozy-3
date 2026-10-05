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
      if (!this.enabled || this.touchMode) return;
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

  // Free-cursor aiming is used when the pointer is not locked (embedded frames, touch).
  get freeAim() {
    return !this.locked && !this.touchMode;
  }

  setupTouch(els) {
    this.touchMode = true;
    const { stick, knob, use, alt, turnL, turnR, act, canvas } = els;
    let stickId = null, sx = 0, sy = 0;
    stick.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      const r = stick.getBoundingClientRect();
      sx = r.left + r.width / 2;
      sy = r.top + r.height / 2;
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      let dx = (e.clientX - sx) / 45, dy = (e.clientY - sy) / 45;
      const l = Math.hypot(dx, dy);
      if (l > 1) { dx /= l; dy /= l; }
      this.move.x = dx;
      this.move.y = dy;
      knob.style.transform = `translate(${dx * 35}px, ${dy * 35}px)`;
    });
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      this.move.x = this.move.y = 0;
      knob.style.transform = '';
    };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    let lookId = null, lx = 0, ly = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || lookId !== null) return;
      lookId = e.pointerId;
      lx = e.clientX;
      ly = e.clientY;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== lookId) return;
      this.lookDX += (e.clientX - lx) * 1.4;
      this.lookDY += (e.clientY - ly) * 1.4;
      lx = e.clientX;
      ly = e.clientY;
    });
    const endLook = (e) => { if (e.pointerId === lookId) lookId = null; };
    canvas.addEventListener('pointerup', endLook);
    canvas.addEventListener('pointercancel', endLook);

    const hold = (btn, on, off) => {
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.classList.add('on'); on(); });
      const up = () => { btn.classList.remove('on'); off?.(); };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
    };
    hold(use, () => { this.use = true; this.usePressed = true; }, () => (this.use = false));
    hold(alt, () => { this.altPressed = true; });
    hold(turnL, () => this.keys.add('KeyQ'), () => this.keys.delete('KeyQ'));
    hold(turnR, () => this.keys.add('KeyE'), () => this.keys.delete('KeyE'));
    hold(act, () => this.pressed.add('KeyF'));
  }

  consumeLook() {
    const d = [this.lookDX, this.lookDY];
    this.lookDX = this.lookDY = 0;
    return d;
  }

  endFrame() {
    this.pressed.clear();
    this.usePressed = false;
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
