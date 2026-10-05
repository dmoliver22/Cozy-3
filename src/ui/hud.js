import { Spring } from '../core/springs.js';
import { ICONS, starSVG } from './icons.js';
import { TOOL_DEFS } from '../tools/tools.js';

const $ = (id) => document.getElementById(id);

// DOM overlay. Even the UI moves on springs: toasts pop, slots bounce, money jiggles.
export class Hud {
  constructor() {
    this.el = {
      hud: $('hud'), day: $('hud-day'), clock: $('hud-clock'), money: $('hud-money'),
      job: $('job'), jobDog: $('job-dog'), jobReq: $('job-req'), steps: $('job-steps'),
      cross: $('crosshair'), hint: $('hint'), toasts: $('toasts'), prompt: $('prompt'),
      speech: $('speech'), hotbar: $('hotbar'), guard: $('guard'), flash: $('flash'), finger: $('finger'), grab: $('grab'),
    };
    this.slots = [];
    this.slotSprings = [];
    TOOL_DEFS.forEach((def, i) => {
      const b = document.createElement('button');
      b.className = 'slot';
      b.title = `${def.name} (${i + 1}): ${def.verb}`;
      b.setAttribute('aria-label', def.name);
      b.innerHTML = `<span class="num">${i + 1}</span>${ICONS[def.id]}`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSlot?.(i);
      });
      this.el.hotbar.appendChild(b);
      this.slots.push(b);
      this.slotSprings.push(new Spring(0, 260, 12));
    });
    this.toastList = [];
    this.moneySpring = new Spring(1, 300, 10);
    this.flashSpring = new Spring(0, 30, 9);
    this.selected = -1;
    this.promptCb = null;
    this.el.prompt.addEventListener('click', (e) => {
      e.stopPropagation();
      this.promptCb?.();
    });
    this.lastSteps = '';
  }

  show(on) {
    this.el.hud.hidden = !on;
  }

  selectTool(i) {
    if (this.selected >= 0) this.slots[this.selected].classList.remove('selected');
    this.selected = i;
    this.slots[i].classList.add('selected');
    this.slotSprings[i].velocity -= 9;
  }

  suggest(ids) {
    TOOL_DEFS.forEach((d, i) => this.slots[i].classList.toggle('suggest', ids.includes(d.id)));
  }

  setGuard(label) {
    this.el.guard.hidden = !label;
    this.el.guard.textContent = label;
  }

  setMoney(v, bump = false) {
    this.el.money.textContent = `$${Math.round(v)}`;
    if (bump) this.moneySpring.velocity += 6;
  }

  setDay(day, clock) {
    this.el.day.textContent = `Day ${day}`;
    this.el.clock.textContent = clock;
  }

  setJob(dogName, req) {
    this.el.job.hidden = !dogName;
    this.el.jobDog.textContent = dogName || '';
    this.el.jobReq.textContent = req || '';
  }

  // steps: [{label, val, pct (0..1|null), state, swatch}]
  setSteps(steps) {
    const key = JSON.stringify(steps.map((s) => [s.label, s.val, s.state, s.swatch, s.pct == null ? null : Math.round(s.pct * 50)]));
    if (key === this.lastSteps) return;
    this.lastSteps = key;
    this.el.steps.innerHTML = steps
      .map(
        (s) => `<li class="${s.state}"><span class="tick"></span><span>${s.label}</span><span class="val">${s.swatch ? `<i class="swatch" style="background:${s.swatch}"></i> ` : ''}${s.val ?? ''}</span>${
          s.pct != null && s.state === 'active' ? `<span class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, s.pct)) * 100)}%"></i></span>` : ''
        }</li>`
      )
      .join('');
  }

  // x/y place the hint above a finger (touch); without them it sits under the crosshair.
  setHint(text, x, y) {
    if (text !== this._hint) {
      this._hint = text;
      this.el.hint.textContent = text || '';
      this.el.hint.classList.toggle('show', !!text);
    }
    if (x != null) {
      const w = this.el.hint.offsetWidth || 200;
      this.el.hint.style.left = `${Math.min(Math.max(x, w / 2 + 8), innerWidth - w / 2 - 8)}px`;
      this.el.hint.style.top = `${Math.max(8, y)}px`;
    } else if (this.el.hint.style.left) {
      this.el.hint.style.left = '';
      this.el.hint.style.top = '';
    }
  }

  setFinger(x, y, hot) {
    const f = this.el.finger;
    if (x == null) {
      f.hidden = true;
      return;
    }
    f.hidden = false;
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    f.style.borderColor = hot ? 'rgba(242, 179, 139, 0.95)' : 'rgba(247, 250, 250, 0.9)';
  }

  // The "pick me up" ring around the tool in hand on touch screens.
  setGrab(x, y, r, label) {
    const g = this.el.grab;
    if (x == null) {
      if (!g.hidden) g.hidden = true;
      return;
    }
    g.hidden = false;
    const d = Math.round(r * 1.5);
    g.style.left = `${Math.round(x - d / 2)}px`;
    g.style.top = `${Math.round(y - d / 2)}px`;
    g.style.width = g.style.height = `${d}px`;
    if (label !== this._grabLabel) {
      this._grabLabel = label;
      g.firstElementChild.textContent = label;
      g.firstElementChild.hidden = !label;
    }
  }

  setCrosshair(hot, free) {
    this.el.cross.classList.toggle('hot', !!hot);
    this.el.cross.classList.toggle('free', !!free);
  }

  toast(text, big = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (big ? ' big' : '');
    el.textContent = text;
    this.el.toasts.appendChild(el);
    const t = { el, scale: new Spring(0.2, 320, 14), life: big ? 2.6 : 1.8 };
    t.scale.target = 1;
    this.toastList.push(t);
    while (this.toastList.length > 4) {
      const old = this.toastList.shift();
      old.el.remove();
    }
  }

  prompt(text, key, cb) {
    this.promptCb = cb;
    this.el.prompt.hidden = !text;
    if (text) this.el.prompt.innerHTML = `${key ? `<kbd>${key}</kbd>` : ''}${text}`;
  }

  speech(text, x, y) {
    if (!text) {
      this.el.speech.hidden = true;
      return;
    }
    this.el.speech.hidden = false;
    if (this.el.speech.textContent !== text) this.el.speech.textContent = text;
    // Keep the bubble on screen even when the owner's head is near an edge.
    const w = this.el.speech.offsetWidth || 220, h = this.el.speech.offsetHeight || 60;
    x = Math.min(Math.max(x, w / 2 + 12), innerWidth - w / 2 - 12);
    y = Math.min(Math.max(y, h + 64), innerHeight - 140);
    this.el.speech.style.left = `${x}px`;
    this.el.speech.style.top = `${y}px`;
  }

  flash() {
    this.flashSpring.value = 1;
    this.flashSpring.velocity = 0;
  }

  update(dt) {
    this.slotSprings.forEach((s, i) => {
      s.update(dt);
      const lift = this.selected === i ? -6 : 0;
      this.slots[i].style.transform = `translateY(${lift + s.value}px) scale(${1 - s.value * 0.01})`;
    });
    this.moneySpring.target = 1;
    this.moneySpring.update(dt);
    this.el.money.style.transform = `scale(${this.moneySpring.value})`;
    for (let i = this.toastList.length - 1; i >= 0; i--) {
      const t = this.toastList[i];
      t.life -= dt;
      if (t.life < 0.25) t.scale.target = 0;
      t.scale.update(dt);
      t.el.style.transform = `scale(${Math.max(0, t.scale.value)})`;
      t.el.style.opacity = Math.min(1, t.life * 4);
      if (t.life <= 0) {
        t.el.remove();
        this.toastList.splice(i, 1);
      }
    }
    this.flashSpring.target = 0;
    this.flashSpring.update(dt);
    this.el.flash.style.opacity = Math.max(0, this.flashSpring.value);
  }
}

// ---------------------------------------------------------------------
// Modal screens.

export function showScreen(id, on) {
  $(id).hidden = !on;
}

// Cards drop in on a spring, like a ticket slapped on the counter.
export function springIn(el) {
  const s = new Spring(-40, 220, 13);
  s.target = 0;
  const r = new Spring(-4, 160, 8);
  r.target = 0;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    s.update(dt);
    r.update(dt);
    el.style.transform = `translateY(${s.value}px) rotate(${r.value}deg)`;
    if (Math.abs(s.value) > 0.05 || Math.abs(s.velocity) > 0.05 || Math.abs(r.value) > 0.02) requestAnimationFrame(tick);
    else el.style.transform = '';
  };
  requestAnimationFrame(tick);
}

export function fillTicket(appt, no) {
  $('tk-no').textContent = `No. ${String(no).padStart(3, '0')}`;
  $('tk-dog').textContent = appt.name;
  $('tk-breed').textContent = appt.breedName;
  $('tk-owner').textContent = appt.owner.name;
  $('tk-temper').textContent = appt.temperament;
  $('tk-coat').textContent = appt.coat;
  const bow = $('tk-bow');
  bow.textContent = appt.bow ? appt.bow.name : 'No bow';
  bow.style.setProperty('--bow', appt.bow ? appt.bow.hex : 'transparent');
  $('tk-cut').textContent = appt.cut.name;
  $('tk-cut-detail').textContent = appt.cut.detail;
  $('tk-note').textContent = `“${appt.note}”`;
  springIn(document.querySelector('#ticket .intake'));
}

export function fillCheckout(result, photoCanvas) {
  $('co-title').textContent = result.title;
  $('co-stars').innerHTML = Array.from({ length: 5 }, (_, i) => starSVG(i < result.stars)).join('');
  $('co-lines').innerHTML = result.lines.map(([a, b]) => `<li><span>${a}</span><span>${b}</span></li>`).join('');
  $('co-total').textContent = `$${result.total}`;
  $('co-quote').textContent = `“${result.quote}”`;
  const c = $('co-photo');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  if (photoCanvas) g.drawImage(photoCanvas, 0, 0, c.width, c.height);
  springIn(document.querySelector('#checkout .receipt'));
  // Stars pop in one after another.
  document.querySelectorAll('#co-stars .star').forEach((st, i) => {
    const s = new Spring(0, 260, 9);
    s.target = 1;
    let last = performance.now();
    let delay = 0.25 + i * 0.14;
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      delay -= dt;
      if (delay <= 0) s.update(dt);
      st.style.transform = `scale(${Math.max(0, s.value)})`;
      if (delay > 0 || Math.abs(s.value - 1) > 0.002 || Math.abs(s.velocity) > 0.01) requestAnimationFrame(tick);
    };
    st.style.transform = 'scale(0)';
    requestAnimationFrame(tick);
  });
}

export function buildShop(upgrades, owned, money, onBuy) {
  $('shop-money').textContent = `$${Math.round(money)}`;
  for (const [kind, id] of [['tool', 'shop-tools'], ['salon', 'shop-salon']]) {
    const list = $(id);
    list.innerHTML = '';
    for (const u of upgrades.filter((x) => x.kind === kind)) {
      const has = !!owned[u.id];
      const div = document.createElement('div');
      div.className = 'item' + (has ? ' owned' : '');
      div.innerHTML = `<h4>${u.name}</h4><p>${u.desc}</p>`;
      const b = document.createElement('button');
      b.className = 'btn btn-peach buy';
      b.textContent = has ? 'Owned' : `$${u.cost}`;
      b.disabled = !has && money < u.cost;
      if (!has) b.addEventListener('click', () => onBuy(u));
      div.appendChild(b);
      list.appendChild(div);
    }
  }
  springIn(document.querySelector('#shop .catalogue'));
}
