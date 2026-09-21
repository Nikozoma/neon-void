/* ============================================================
   NEON VOID — twin-stick neon arena survival
   Single-file game. Canvas 2D. No dependencies.
   ============================================================ */
'use strict';

/* ---------------- utils ---------------- */
const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const irand = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/* ---------------- config ---------------- */
const CFG = {
  step: 1 / 60,
  maxEnemies: 90,
  maxParts: 340,
  maxFloats: 40,
  world: { w: 2200, h: 1500 },  // arena is ~2.5-3x a phone viewport
  camZoom: 0.85,                // zoomed out slightly
  // ---- dev-tunable pacing params (functions below derive from these) ----
  spawnBase: 1.15,              // spawn interval at t=0 (s)
  spawnDecay: 0.0058,           // interval shrink per second
  spawnMin: 0.26,               // fastest spawn interval (s)
  batchEvery: 55,               // +1 enemy per batch every N seconds
  hpRate: 70,                   // enemy HP doubles every N seconds
  spdRate: 280,                 // enemy speed ramps over N seconds
  spdCap: 0.45,                 // max speed growth (+45%)
  dmgRate: 240,                 // enemy damage doubles every N seconds
  xpBase: 8, xpPow: 1.42,       // xpNeed = xpBase * lvl^xpPow
  eliteEvery: 42,               // seconds between elites
  firstElite: 50,               // first elite at this time (s)
  bossEvery: 150,               // seconds between bosses
  firstBoss: 150,
  eliteNukeCh: 0.22,            // elite nuke drop chance
  eliteHealCh: 0.35,            // elite heal drop chance
};
CFG.xpNeed = (lvl) => Math.round(CFG.xpBase * Math.pow(lvl, CFG.xpPow));
CFG.spawnInterval = (t) => clamp(CFG.spawnBase - t * CFG.spawnDecay, CFG.spawnMin, CFG.spawnBase);
CFG.batchSize = (t) => 1 + Math.floor(t / CFG.batchEvery);
CFG.hpMul = (t) => 1 + t / CFG.hpRate;
CFG.spdMul = (t) => 1 + Math.min(CFG.spdCap, t / CFG.spdRate);
CFG.dmgMul = (t) => 1 + t / CFG.dmgRate;
// numeric params the dev menu can reset
const DEVPARAMS = ['maxEnemies', 'spawnBase', 'spawnDecay', 'spawnMin', 'batchEvery',
  'hpRate', 'spdRate', 'spdCap', 'dmgRate', 'xpBase', 'xpPow',
  'eliteEvery', 'firstElite', 'bossEvery', 'firstBoss', 'eliteNukeCh', 'eliteHealCh'];
const CFG_DEFAULTS = {};
DEVPARAMS.forEach((k) => { CFG_DEFAULTS[k] = CFG[k]; });

/* palette */
const COL = {
  bg: '#04050d',
  player: '#46f6ff',
  playerDark: '#0b3540',
  bullet: '#c8fbff',
  mite: '#9dff57',
  dasher: '#ffb347',
  spitter: '#c07bff',
  tank: '#ff6b6b',
  elite: '#ff4dff',
  boss: '#ff4d6d',
  xp: '#4df3ff',
  heal: '#51ff9e',
  text: '#dff6ff',
};

/* ============================================================
   AUDIO — tiny synthesized SFX engine (WebAudio, no assets)
   ============================================================ */
const AU = {
  ctx: null, master: null, muted: false, lastShoot: 0,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch (e) { /* audio unavailable */ }
  },
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.35;
  },
  tone(freq, dur, type, vol, slideTo, delay) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + (delay || 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    g.gain.setValueAtTime(vol || 0.5, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },
  noise(dur, vol, filterFreq, delay) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + (delay || 0);
    const len = Math.max(1, (dur * this.ctx.sampleRate) | 0);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = filterFreq || 1200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.5, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0);
  },
  shoot() {
    const now = performance.now();
    if (now - this.lastShoot < 70) return;   // throttle: machine-gun fire
    this.lastShoot = now;
    this.tone(rand(640, 720), 0.07, 'square', 0.16, 220);
  },
  hit() { this.noise(0.06, 0.25, 2400); },
  boom(big) {
    this.noise(big ? 0.5 : 0.28, big ? 0.7 : 0.45, big ? 700 : 1100);
    this.tone(big ? 90 : 140, big ? 0.45 : 0.25, 'sine', 0.5, 40);
  },
  pickup(n) { this.tone(760 + Math.min(n, 12) * 45, 0.08, 'sine', 0.22, 1500); },
  nuke() {
    this.noise(1.0, 0.8, 500);
    this.tone(60, 0.9, 'sine', 0.7, 30);
    this.tone(880, 0.5, 'sawtooth', 0.25, 110, 0.05);
  },
  level() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.35, null, i * 0.07)); },
  hurt() { this.tone(170, 0.28, 'sawtooth', 0.5, 55); this.noise(0.2, 0.3, 500); },
  dash() { this.noise(0.18, 0.3, 3200); },
  warn() { this.tone(98, 0.4, 'sawtooth', 0.5, 92); this.tone(98, 0.4, 'sawtooth', 0.5, 92, 0.45); },
  click() { this.tone(520, 0.06, 'triangle', 0.3, 700); },
  bossDie() {
    this.noise(0.8, 0.7, 600);
    [220, 175, 147, 110].forEach((f, i) => this.tone(f, 0.3, 'sawtooth', 0.3, f * 0.8, i * 0.12));
  },
};

/* ============================================================
   CANVAS + RESIZE
   ============================================================ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1, S = 1;   // S = gameplay scale (min dimension / 800)

/* camera: follows player through the world, zoomed out slightly */
const cam = { x: CFG.world.w / 2, y: CFG.world.h / 2, zoom: CFG.camZoom };
function viewHalf() {
  return { hw: W / (2 * cam.zoom), hh: H / (2 * cam.zoom) };
}
function updateCamera() {
  const p = G.player;
  if (p && G.mode !== 'menu' && G.mode !== 'gameover') {
    cam.x = p.x; cam.y = p.y;
  } else {
    // menu ambience: slow drift around world center
    const t = performance.now() / 1000;
    cam.x = CFG.world.w / 2 + Math.cos(t * 0.08) * 260;
    cam.y = CFG.world.h / 2 + Math.sin(t * 0.06) * 180;
  }
  const { hw, hh } = viewHalf();
  cam.x = CFG.world.w <= hw * 2 ? CFG.world.w / 2 : clamp(cam.x, hw, CFG.world.w - hw);
  cam.y = CFG.world.h <= hh * 2 ? CFG.world.h / 2 : clamp(cam.y, hh, CFG.world.h - hh);
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  S = Math.min(W, H) / 800;
  // keep player inside world after resize
  if (G && G.player) {
    G.player.x = clamp(G.player.x, 30, CFG.world.w - 30);
    G.player.y = clamp(G.player.y, 30, CFG.world.h - 30);
  }
  // nuke button anchor (top-right), 25% smaller than the old dash button
  IN.nukeBX = W - 58;
  IN.nukeBY = 104;
  // fixed virtual-stick anchors: movement bottom-left, firing bottom-right
  IN.moveBX = 104; IN.moveBY = H - 118;
  IN.aimBX = W - 104; IN.aimBY = H - 118;
  buildStars(); // rebuild menu starfield for new size
  buildStatic(); // rebuild cached vignette for new size
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));

/* ============================================================
   INPUT — twin virtual sticks + dash button (touch), keyboard fallback
   ============================================================ */
const IN = {
  // move stick
  mActive: false, mId: -1, mOX: 0, mOY: 0, mX: 0, mY: 0,
  // aim stick
  aActive: false, aId: -1, aOX: 0, aOY: 0, aX: 0, aY: 0,
  nukeBX: 0, nukeBY: 0, nukeQueued: false,
  moveBX: 0, moveBY: 0, aimBX: 0, aimBY: 0,
  keys: {},
  stickR: 60, // visual radius px (scaled at draw)
};

function touchPos(t) {
  const r = canvas.getBoundingClientRect();
  return { x: t.clientX - r.left, y: t.clientY - r.top };
}

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  AU.init();
  for (const t of e.changedTouches) {
    const p = touchPos(t);
    // nuke button hit? (button radius 34, generous 46px touch target)
    const ddx = p.x - IN.nukeBX, ddy = p.y - IN.nukeBY;
    if (ddx * ddx + ddy * ddy < 46 * 46 && G.mode === 'playing') {
      IN.nukeQueued = true;
      continue;
    }
    // fixed sticks: movement anchored bottom-left, firing bottom-right
    if (p.x < W / 2 && !IN.mActive) {
      IN.mActive = true; IN.mId = t.identifier;
      IN.mOX = IN.moveBX; IN.mOY = IN.moveBY; IN.mX = 0; IN.mY = 0;
    } else if (p.x >= W / 2 && !IN.aActive) {
      IN.aActive = true; IN.aId = t.identifier;
      IN.aOX = IN.aimBX; IN.aOY = IN.aimBY; IN.aX = 0; IN.aY = 0;
    }
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const p = touchPos(t);
    if (t.identifier === IN.mId) {
      let dx = p.x - IN.mOX, dy = p.y - IN.mOY;
      const d = Math.hypot(dx, dy), max = 70;
      if (d > max) { dx = dx / d * max; dy = dy / d * max; }
      IN.mX = dx / max; IN.mY = dy / max;
    } else if (t.identifier === IN.aId) {
      let dx = p.x - IN.aOX, dy = p.y - IN.aOY;
      const d = Math.hypot(dx, dy), max = 70;
      if (d > max) { dx = dx / d * max; dy = dy / d * max; }
      IN.aX = dx / max; IN.aY = dy / max;
    }
  }
}, { passive: false });

function touchEnd(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === IN.mId) { IN.mActive = false; IN.mId = -1; IN.mX = IN.mY = 0; }
    if (t.identifier === IN.aId) { IN.aActive = false; IN.aId = -1; IN.aX = IN.aY = 0; }
  }
}
canvas.addEventListener('touchend', touchEnd, { passive: false });
canvas.addEventListener('touchcancel', touchEnd, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

/* keyboard + mouse fallback (desktop testing) */
window.addEventListener('keydown', (e) => {
  IN.keys[e.code] = true;
  AU.init();
  if (e.code === 'Space') { IN.nukeQueued = true; e.preventDefault(); }
  if (e.code === 'KeyP' && G.mode === 'playing') togglePause();
});
window.addEventListener('keyup', (e) => { IN.keys[e.code] = false; });
let mouseAim = { x: 1, y: 0, down: false };
canvas.addEventListener('mousedown', (e) => { mouseAim.down = true; AU.init(); });
window.addEventListener('mouseup', () => { mouseAim.down = false; });
window.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  if (G.mode === 'playing' && G.player) {
    mouseAim.x = (e.clientX - r.left) - G.player.x;
    mouseAim.y = (e.clientY - r.top) - G.player.y;
  }
});

/* read combined input into normalized move/aim vectors */
function readInput() {
  let mx = 0, my = 0, ax = 0, ay = 0, firing = false;
  if (IN.mActive) { mx = IN.mX; my = IN.mY; }
  if (IN.aActive) {
    const d = Math.hypot(IN.aX, IN.aY);
    if (d > 0.25) { ax = IN.aX / d; ay = IN.aY / d; firing = true; }
  }
  const k = IN.keys;
  if (k.KeyW || k.ArrowUp) my -= 1;
  if (k.KeyS || k.ArrowDown) my += 1;
  if (k.KeyA || k.ArrowLeft) mx -= 1;
  if (k.KeyD || k.ArrowRight) mx += 1;
  if (mouseAim.down) {
    const d = Math.hypot(mouseAim.x, mouseAim.y) || 1;
    ax = mouseAim.x / d; ay = mouseAim.y / d; firing = true;
  }
  const md = Math.hypot(mx, my);
  if (md > 1) { mx /= md; my /= md; }
  return { mx, my, ax, ay, firing };
}

/* ============================================================
   GAME STATE
   ============================================================ */
const G = {
  mode: 'menu',   // menu | playing | levelup | paused | gameover
  time: 0, score: 0, kills: 0,
  level: 1, xp: 0, xpNeed: CFG.xpNeed(1),
  trauma: 0, hitstop: 0,
  player: null,
  bullets: [], ebullets: [],
  enemies: [], parts: [], pickups: [], floats: [], shocks: [],
  spawnT: 0, eliteT: 0, bossT: 0, boss: null, bossCount: 0,
  upgrades: {},   // id -> stacks
  flash: 0,       // full-screen flash (nuke)
  muted: false,
  demo: false,
  best: 0,
};

try { G.best = parseInt(localStorage.getItem('neonvoid_best') || '0', 10) || 0; } catch (e) {}

/* ============================================================
   META PROGRESSION — points + permanent store (localStorage)
   ============================================================ */
const META = {
  pts: 0,
  up: { dmg: 0, rate: 0, spd: 0, hull: 0, mag: 0, seek: 0 },
  nukes: 0,          // purchased +starting nukes (max 2)
  aegis: 0,          // shield charges per run (max 3)
  weapons: { pulse: true, scatter: false, rail: false },
  weapon: 'pulse',
};
try {
  META.pts = parseInt(localStorage.getItem('neonvoid_pts') || '0', 10) || 0;
  const m = JSON.parse(localStorage.getItem('neonvoid_meta') || 'null');
  if (m) {
    if (m.up) for (const k in META.up) META.up[k] = m.up[k] | 0;
    META.nukes = m.nukes | 0; META.aegis = m.aegis | 0;
    if (m.weapons) for (const k in META.weapons) META.weapons[k] = !!m.weapons[k];
    if (m.weapon && META.weapons[m.weapon]) META.weapon = m.weapon;
  }
} catch (e) {}
function saveMeta() {
  try {
    localStorage.setItem('neonvoid_pts', String(META.pts));
    localStorage.setItem('neonvoid_meta', JSON.stringify({
      up: META.up, nukes: META.nukes, aegis: META.aegis,
      weapons: META.weapons, weapon: META.weapon,
    }));
  } catch (e) {}
}

const META_UPS = [
  { id: 'dmg',  ico: '💥', name: 'HEAVY PLATING', desc: '+8% bullet damage / lvl',       max: 10, base: 60 },
  { id: 'rate', ico: '⚡', name: 'OVERCLOCKED',   desc: '+8% fire rate / lvl',           max: 10, base: 60 },
  { id: 'spd',  ico: '👟', name: 'ION DRIVE',     desc: '+6% move speed / lvl',          max: 10, base: 60 },
  { id: 'hull', ico: '❤', name: 'REINFORCED',    desc: '+20 max hull / lvl',            max: 10, base: 60 },
  { id: 'mag',  ico: '🧲', name: 'TRACTOR MK-II', desc: '+15% pickup radius / lvl',      max: 5,  base: 80 },
  { id: 'seek', ico: '🎯', name: 'SEEKER TUNE',   desc: '+1 starting homing stage / lvl', max: 3, base: 120 },
];
const META_ITEMS = [
  { id: 'nukes', ico: '☢', name: 'NUKE CACHE',   desc: '+1 starting nuke',        max: 2, base: 150 },
  { id: 'aegis', ico: '🛡', name: 'AEGIS SHIELD', desc: '+1 shield charge per run', max: 3, base: 120 },
];
const WEAPONS = {
  pulse:   { name: 'PULSE',   ico: '🔫', cost: 0,   desc: 'Standard issue. Balanced.' },
  scatter: { name: 'SCATTER', ico: '🌪', cost: 400, desc: '+2 projectiles, -30% damage, wider spread' },
  rail:    { name: 'RAILGUN', ico: '🔩', cost: 600, desc: '-55% fire rate, +220% damage, pierce +3' },
};
function metaCost(base, lvl) { return Math.round(base * Math.pow(1.65, lvl)); }

/* permanent bonuses applied at run start */
function applyMeta(p) {
  const u = META.up;
  p.dmg *= Math.pow(1.08, u.dmg);
  p.fireRate *= Math.pow(1.08, u.rate);
  p.speed *= Math.pow(1.06, u.spd);
  p.maxhp += 20 * u.hull;
  p.hp = p.maxhp;
  p.magnet *= Math.pow(1.15, u.mag);
  p.seek = Math.min(5, 1 + u.seek);
  p.nukes = Math.min(3, 1 + META.nukes);
  p.shields = META.aegis;
  if (META.weapon === 'scatter') {
    p.proj += 2; p.dmg *= 0.7; p.spreadBonus = 0.07;
  } else if (META.weapon === 'rail') {
    p.fireRate *= 0.45; p.dmg *= 3.2; p.pierce += 3; p.bulletSpeed *= 1.4;
  }
}

// dev-tunable player base stats (applied on run start)
const PBASE = {
  hp: 100, speed: 300, fireRate: 4.5, dmg: 12, proj: 1, pierce: 0,
  crit: 0, bulletSpeed: 760, magnet: 95, seek: 1, nukes: 1, shields: 0,
};
const PBASE_DEFAULTS = Object.assign({}, PBASE);

function newPlayer() {
  const p = {
    x: CFG.world.w / 2, y: CFG.world.h / 2, vx: 0, vy: 0, r: 16 * S + 8,
    hp: PBASE.hp, maxhp: PBASE.hp,
    speed: PBASE.speed, fireRate: PBASE.fireRate, dmg: PBASE.dmg,
    proj: PBASE.proj, pierce: PBASE.pierce,
    crit: PBASE.crit, bulletSpeed: PBASE.bulletSpeed, magnet: PBASE.magnet, siphon: 0,
    seek: PBASE.seek, nukes: PBASE.nukes, shields: PBASE.shields, spreadBonus: 0,
    fireT: 0,
    faceX: 1, faceY: 0, aimX: 1, aimY: 0,
    inv: 0, alive: true,
  };
  applyMeta(p);
  return p;
}

function resetGame() {
  G.time = 0; G.score = 0; G.kills = 0;
  G.level = 1; G.xp = 0; G.xpNeed = CFG.xpNeed(1);
  G.trauma = 0; G.hitstop = 0;
  G.player = newPlayer();
  G.bullets.length = 0; G.ebullets.length = 0;
  G.enemies.length = 0; G.parts.length = 0;
  G.pickups.length = 0; G.floats.length = 0; G.shocks.length = 0;
  G.flash = 0;
  G.spawnT = 1.2; G.eliteT = CFG.firstElite; G.bossT = CFG.firstBoss;
  G.boss = null; G.bossCount = 0; G.upgrades = {};
  IN.nukeQueued = false;
}

/* ============================================================
   JUICE — particles, floating text, screen shake
   ============================================================ */
function addShake(amount) { G.trauma = clamp(G.trauma + amount, 0, 1); }

function spawnParts(x, y, color, n, spd, life, size) {
  for (let i = 0; i < n; i++) {
    if (G.parts.length >= CFG.maxParts) G.parts.shift();
    const a = rand(0, TAU), s = rand(spd * 0.3, spd);
    G.parts.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: rand(life * 0.5, life), maxLife: life,
      size: rand(size * 0.5, size * 1.4), color,
      drag: 0.92,
    });
  }
}

function addFloat(x, y, txt, color, size) {
  if (G.floats.length >= CFG.maxFloats) G.floats.shift();
  G.floats.push({ x, y, txt, color, size: size || 15, life: 0.9, maxLife: 0.9 });
}

function updateParts(dt) {
  for (let i = G.parts.length - 1; i >= 0; i--) {
    const p = G.parts[i];
    p.life -= dt;
    if (p.life <= 0) { G.parts.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= p.drag; p.vy *= p.drag;
  }
  for (let i = G.floats.length - 1; i >= 0; i--) {
    const f = G.floats[i];
    f.life -= dt; f.y -= 46 * dt;
    if (f.life <= 0) G.floats.splice(i, 1);
  }
  G.trauma = Math.max(0, G.trauma - dt * 1.6);
  for (let i = G.shocks.length - 1; i >= 0; i--) {
    const s = G.shocks[i];
    s.life -= dt;
    const t = 1 - Math.max(0, s.life) / s.maxLife;
    s.r = s.maxR * (1 - Math.pow(1 - t, 3)); // ease-out expand
    if (s.life <= 0) G.shocks.splice(i, 1);
  }
  G.flash = Math.max(0, G.flash - dt * 2.2);
}

/* ============================================================
   PICKUPS — xp shards + heal orbs
   ============================================================ */
function dropShard(x, y, val) {
  const a = rand(0, TAU), d = rand(8, 42);
  G.pickups.push({
    kind: 'xp', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
    vx: Math.cos(a) * rand(40, 130), vy: Math.sin(a) * rand(40, 130),
    val, life: 14, r: 7,
  });
}
function dropHeal(x, y, amt) {
  G.pickups.push({ kind: 'heal', x, y, vx: 0, vy: 0, val: amt, life: 10, r: 10 });
}
function dropNuke(x, y) {
  const a = rand(0, TAU);
  G.pickups.push({
    kind: 'nuke', x: x + Math.cos(a) * 20, y: y + Math.sin(a) * 20,
    vx: Math.cos(a) * 60, vy: Math.sin(a) * 60,
    val: 1, life: 16, r: 12,
  });
}

/* ---------------- NUKE — map-clearing panic button ---------------- */
function fireNuke() {
  const p = G.player;
  if (!p || !p.alive || p.nukes <= 0) return;
  p.nukes--;
  const victims = G.enemies.slice();
  for (const e of victims) {
    if (e.boss) {
      damageEnemy(e, 1200, 0, 0, false);
      addFloat(e.x, e.y - 70, 'NUKE HIT', '#ffd76a', 22);
    } else {
      killEnemy(e);
    }
  }
  G.ebullets.length = 0;
  G.shocks.push({
    x: p.x, y: p.y, r: 40,
    maxR: Math.hypot(CFG.world.w, CFG.world.h) * 0.75,
    life: 0.9, maxLife: 0.9,
  });
  G.flash = 1;
  G.hitstop = 0.3;
  addShake(1);
  AU.nuke();
  toast('☢ NUKE DETONATED');
  updateHUD();
}

let pickupStreak = 0, pickupStreakT = 0;
function updatePickups(dt) {
  const p = G.player;
  pickupStreakT -= dt;
  if (pickupStreakT <= 0) pickupStreak = 0;
  for (let i = G.pickups.length - 1; i >= 0; i--) {
    const k = G.pickups[i];
    k.life -= dt;
    if (k.life <= 0) { G.pickups.splice(i, 1); continue; }
    k.x += (k.vx || 0) * dt; k.y += (k.vy || 0) * dt;
    k.vx *= 0.94; k.vy *= 0.94;
    const d2 = dist2(k.x, k.y, p.x, p.y);
    const mr = (k.kind === 'xp' ? p.magnet : 60);
    if (d2 < mr * mr) {
      const d = Math.sqrt(d2) || 1;
      const pull = 900 * (1 - d / (mr * 1.4));
      k.x += (p.x - k.x) / d * pull * dt;
      k.y += (p.y - k.y) / d * pull * dt;
    }
    if (d2 < (p.r + k.r) * (p.r + k.r)) {
      if (k.kind === 'xp') {
        gainXP(k.val);
        pickupStreak++; pickupStreakT = 0.9;
        AU.pickup(pickupStreak);
        spawnParts(k.x, k.y, COL.xp, 4, 120, 0.3, 3);
      } else if (k.kind === 'nuke') {
        if (p.nukes < 3) {
          p.nukes++;
          addFloat(p.x, p.y - 26, '☢ +1 NUKE', '#ffd76a', 17);
          toast('☢ NUKE ACQUIRED');
        } else {
          G.score += 250;
          addFloat(p.x, p.y - 26, '+250', '#ffd76a', 15);
        }
        spawnParts(k.x, k.y, '#ffd76a', 12, 200, 0.5, 4);
        AU.pickup(9);
        updateHUD();
      } else {
        p.hp = Math.min(p.maxhp, p.hp + k.val);
        addFloat(p.x, p.y - 26, '+' + k.val, COL.heal, 16);
        spawnParts(k.x, k.y, COL.heal, 10, 150, 0.5, 4);
        AU.level();
      }
      G.pickups.splice(i, 1);
    }
  }
}

function gainXP(v) {
  G.xp += v;
  while (G.xp >= G.xpNeed) {
    G.xp -= G.xpNeed;
    G.level++;
    G.xpNeed = CFG.xpNeed(G.level);
    onLevelUp();
  }
}

/* ============================================================
   ENEMIES
   ============================================================ */
const ETYPES = {
  mite:   { hp: 22,  spd: 165, dmg: 8,  r: 13, score: 10, xp: 1, color: COL.mite,   shape: 3 },
  dasher: { hp: 34,  spd: 150, dmg: 12, r: 14, score: 20, xp: 2, color: COL.dasher,  shape: 4 },
  spitter:{ hp: 40,  spd: 120, dmg: 10, r: 15, score: 30, xp: 3, color: COL.spitter, shape: 4 },
  tank:   { hp: 150, spd: 72,  dmg: 20, r: 24, score: 60, xp: 6, color: COL.tank,    shape: 6 },
};
const ETYPES_DEFAULTS = JSON.parse(JSON.stringify(ETYPES));

/* spawn point on a ring around the camera, just outside the visible view */
function spawnRing(margin) {
  const m = margin || 60;
  const vh = viewHalf();
  const r = Math.hypot(vh.hw, vh.hh) + m;
  const a = rand(0, TAU);
  return {
    x: clamp(cam.x + Math.cos(a) * r, 24, CFG.world.w - 24),
    y: clamp(cam.y + Math.sin(a) * r, 24, CFG.world.h - 24),
  };
}

function spawnEnemy(type, x, y, elite) {
  const base = ETYPES[type];
  const t = G.time;
  const hpM = CFG.hpMul(t) * (elite ? 5 : 1);
  const pos = (x === undefined) ? spawnRing() : { x, y };
  const e = {
    type, elite: !!elite,
    x: pos.x, y: pos.y,
    vx: 0, vy: 0,
    hp: base.hp * hpM, maxhp: base.hp * hpM,
    spd: base.spd * CFG.spdMul(t) * rand(0.9, 1.1) * (elite ? 0.9 : 1),
    dmg: base.dmg * CFG.dmgMul(t) * (elite ? 1.5 : 1),
    r: base.r * (elite ? 1.55 : 1) * S + (elite ? 6 : 0),
    score: base.score * (elite ? 5 : 1),
    xp: base.xp * (elite ? 5 : 1),
    color: elite ? COL.elite : base.color,
    shape: base.shape,
    rot: rand(0, TAU), rotV: rand(-2, 2),
    flash: 0, t: rand(0, 10),
    // dasher state
    state: 'chase', stateT: 0, dx: 0, dy: 0,
    // spitter state
    fireT: rand(1, 2.4),
    hitR: 0, // knockback decay helper
  };
  G.enemies.push(e);
  if (elite) {
    addFloat(e.x, e.y - 44, 'ELITE', COL.elite, 17);
    spawnParts(e.x, e.y, COL.elite, 14, 200, 0.6, 4);
  }
  return e;
}

function pickType(t) {
  const r = Math.random();
  if (t < 20) return 'mite';
  if (t < 45) return r < 0.62 ? 'mite' : 'dasher';
  if (t < 90) return r < 0.45 ? 'mite' : r < 0.72 ? 'dasher' : 'spitter';
  if (t < 150) return r < 0.35 ? 'mite' : r < 0.58 ? 'dasher' : r < 0.8 ? 'spitter' : 'tank';
  return r < 0.3 ? 'mite' : r < 0.52 ? 'dasher' : r < 0.74 ? 'spitter' : 'tank';
}

function updateSpawns(dt) {
  const t = G.time;
  G.spawnT -= dt;
  if (G.spawnT <= 0 && G.enemies.length < CFG.maxEnemies) {
    G.spawnT = CFG.spawnInterval(t);
    const batch = Math.min(CFG.batchSize(t), CFG.maxEnemies - G.enemies.length);
    for (let i = 0; i < batch; i++) spawnEnemy(pickType(t));
  }
  // elites
  if (t > 50) {
    G.eliteT -= dt;
    if (G.eliteT <= 0 && G.enemies.length < CFG.maxEnemies - 4) {
      G.eliteT = CFG.eliteEvery;
      const pos = spawnRing();
      spawnEnemy(pickType(t), pos.x, pos.y, true);
      toast('ELITE SIGNATURE DETECTED');
    }
  }
  // boss
  G.bossT -= dt;
  if (G.bossT <= 0 && !G.boss) {
    G.bossCount++;
    spawnBoss();
    G.bossT = CFG.bossEvery;
  }
}

/* ---------------- boss: WARDEN ---------------- */
function spawnBoss() {
  const n = G.bossCount;
  const hp = 1100 * (1 + (n - 1) * 0.8) * (1 + G.time / 300);
  const pos = spawnRing(120);
  const b = {
    type: 'boss', boss: true,
    x: pos.x, y: pos.y, vx: 0, vy: 0,
    hp, maxhp: hp,
    spd: 95, dmg: 24 * CFG.dmgMul(G.time), r: 46 * S + 14,
    score: 1500, xp: 40,
    color: COL.boss, shape: 8,
    rot: 0, rotV: 1.2, flash: 0, t: 0,
    state: 'enter', stateT: 1.2,
    atkT: 2.0, atkKind: 0,
    ringN: 14,
  };
  G.enemies.push(b);
  G.boss = b;
  AU.warn();
  showWarn('⚠ WARDEN APPROACHING ⚠');
  addShake(0.5);
  el.bossbar.classList.remove('hidden');
}

function bossAttack(b) {
  const p = G.player;
  const kind = b.atkKind % 3;
  b.atkKind++;
  if (kind === 0) {
    // radial burst
    const n = b.ringN + G.bossCount * 2;
    const off = rand(0, TAU);
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * TAU;
      enemyShoot(b.x, b.y, Math.cos(a), Math.sin(a), 240, b.dmg * 0.55);
    }
    AU.boom(false);
  } else if (kind === 1) {
    // aimed fan
    const base = Math.atan2(p.y - b.y, p.x - b.x);
    for (let i = -2; i <= 2; i++) {
      const a = base + i * 0.16;
      enemyShoot(b.x, b.y, Math.cos(a), Math.sin(a), 330, b.dmg * 0.6);
    }
    AU.shoot();
  } else {
    // summon mites
    for (let i = 0; i < 4; i++) {
      const a = rand(0, TAU);
      spawnEnemy('mite', b.x + Math.cos(a) * 70, b.y + Math.sin(a) * 70);
    }
    spawnParts(b.x, b.y, COL.boss, 20, 260, 0.6, 5);
  }
  addShake(0.25);
}

function enemyShoot(x, y, dx, dy, spd, dmg) {
  G.ebullets.push({ x, y, vx: dx * spd, vy: dy * spd, dmg, r: 7, life: 3.2, t: 0 });
}

/* ============================================================
   COMBAT
   ============================================================ */
function fireBullets(ax, ay) {
  const p = G.player;
  const n = p.proj;
  const spread = 0.09 + (p.spreadBonus || 0);
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * spread + rand(-0.02, 0.02);
    const ca = Math.cos(off), sa = Math.sin(off);
    const dx = ax * ca - ay * sa, dy = ax * sa + ay * ca;
    G.bullets.push({
      x: p.x + dx * (p.r + 6), y: p.y + dy * (p.r + 6),
      vx: dx * p.bulletSpeed + p.vx * 0.35,
      vy: dy * p.bulletSpeed + p.vy * 0.35,
      dmg: p.dmg, pierce: p.pierce, r: 5, life: 0.85, t: 0,
      critC: p.crit, hitSet: null, seek: p.seek,
    });
  }
  p.fireT = 1 / p.fireRate;
  AU.shoot();
  spawnParts(p.x + ax * (p.r + 8), p.y + ay * (p.r + 8), COL.bullet, 2, 90, 0.15, 3);
}

function damageEnemy(e, dmg, dx, dy, isCrit) {
  if (e.hp <= 0) return;
  e.hp -= dmg;
  e.flash = 0.07;
  const kb = e.boss ? 20 : e.type === 'tank' ? 60 : 170;
  e.vx += dx * kb; e.vy += dy * kb;
  addFloat(e.x + rand(-8, 8), e.y - e.r - 6, Math.round(dmg) + '', isCrit ? '#ffd76a' : '#ffffff', isCrit ? 19 : 14);
  spawnParts(e.x, e.y, e.color, isCrit ? 8 : 4, 200, 0.35, 3.5);
  if (e.hp <= 0) killEnemy(e);
  else AU.hit();
}

function killEnemy(e) {
  const idx = G.enemies.indexOf(e);
  if (idx >= 0) G.enemies.splice(idx, 1);
  G.kills++;
  G.score += e.score + Math.floor(G.time) * (e.boss ? 5 : 0);
  const big = e.elite || e.boss || e.type === 'tank';
  spawnParts(e.x, e.y, e.color, big ? 26 : 12, big ? 320 : 220, big ? 0.7 : 0.45, big ? 5 : 4);
  spawnParts(e.x, e.y, '#ffffff', big ? 10 : 5, 160, 0.3, 3);
  if (big) { addShake(e.boss ? 0.7 : 0.4); AU.boom(true); }
  else AU.boom(false);
  // drops
  if (e.boss) {
    for (let i = 0; i < 8; i++) dropShard(e.x, e.y, 5);
    dropHeal(e.x, e.y, 40);
    dropNuke(e.x, e.y);
    G.hitstop = 0.35;
    G.boss = null;
    el.bossbar.classList.add('hidden');
    AU.bossDie();
    toast('WARDEN DESTROYED  +1500');
  } else if (e.elite) {
    for (let i = 0; i < 5; i++) dropShard(e.x, e.y, e.xp / 5);
    if (Math.random() < CFG.eliteHealCh) dropHeal(e.x, e.y, 25);
    if (Math.random() < CFG.eliteNukeCh) dropNuke(e.x, e.y);
    G.hitstop = 0.12;
    addFloat(e.x, e.y - 30, '+' + e.score, COL.elite, 17);
  } else {
    dropShard(e.x, e.y, e.xp);
  }
  // siphon heal
  const p = G.player;
  if (p.siphon > 0 && G.kills % Math.max(1, Math.round(8 / p.siphon)) === 0) {
    p.hp = Math.min(p.maxhp, p.hp + 1);
  }
}

function damagePlayer(dmg, sx, sy) {
  const p = G.player;
  if (!p.alive || p.inv > 0) return;
  if (p.shields > 0) {
    p.shields--;
    p.inv = 0.6;
    toast('🛡 AEGIS BLOCKED');
    spawnParts(p.x, p.y, '#7df9ff', 18, 260, 0.5, 4);
    AU.hit();
    updateHUD();
    return;
  }
  p.hp -= dmg;
  p.inv = 0.8;
  addShake(0.45);
  AU.hurt();
  spawnParts(p.x, p.y, '#ff6b81', 14, 260, 0.5, 4);
  if (sx !== undefined) {
    const d = Math.hypot(sx - p.x, sy - p.y) || 1;
    p.vx += (p.x - sx) / d * 260;
    p.vy += (p.y - sy) / d * 260;
  }
  if (p.hp <= 0) {
    p.hp = 0; p.alive = false;
    gameOver();
  }
}

/* ============================================================
   UPGRADES
   ============================================================ */
const UPOOL = [
  { id: 'overclock', ico: '⚡', name: 'OVERCLOCK',  desc: '+20% fire rate',            max: 99, apply(p) { p.fireRate *= 1.20; } },
  { id: 'heavy',     ico: '💥', name: 'HEAVY ROUNDS', desc: '+25% bullet damage',      max: 99, apply(p) { p.dmg *= 1.25; } },
  { id: 'split',     ico: '🔱', name: 'SPLIT SHOT', desc: '+1 projectile per shot',    max: 3,  apply(p) { p.proj += 1; } },
  { id: 'pierce',    ico: '➹',  name: 'PIERCER',   desc: 'Bullets pierce +1 enemy',    max: 3,  apply(p) { p.pierce += 1; } },
  { id: 'swift',     ico: '👟', name: 'ION THRUSTERS', desc: '+12% move speed',        max: 99, apply(p) { p.speed *= 1.12; } },
  { id: 'vital',     ico: '❤',  name: 'REINFORCED HULL', desc: '+25 max hull, repair 40', max: 99, apply(p) { p.maxhp += 25; p.hp = Math.min(p.maxhp, p.hp + 40); } },
  { id: 'magnet',    ico: '🧲', name: 'TRACTOR FIELD', desc: '+45% pickup radius',     max: 99, apply(p) { p.magnet *= 1.45; } },
  { id: 'seeker',    ico: '🎯', name: 'SEEKER PROTOCOL', desc: 'Heat-seek +1 stage (max 5)', max: 5,  apply(p) { p.seek = Math.min(5, p.seek + 1); } },
  { id: 'crit',      ico: '🎯', name: 'CRITICAL MATRIX', desc: '+12% crit chance (2.2× dmg)', max: 5, apply(p) { p.crit += 0.12; } },
  { id: 'siphon',    ico: '🩸', name: 'SIPHON CORE', desc: 'Regain hull from kills',   max: 3,  apply(p) { p.siphon += 1; } },
  { id: 'repair',    ico: '🔧', name: 'FIELD REPAIR', desc: 'Restore 50 hull now',     max: 99, apply(p) { p.hp = Math.min(p.maxhp, p.hp + 50); } },
];

function rollUpgrades() {
  const avail = UPOOL.filter(u => (G.upgrades[u.id] || 0) < u.max && u.id !== 'repair');
  const picks = [];
  const pool = avail.slice();
  while (picks.length < 3 && pool.length) {
    picks.push(pool.splice(irand(0, pool.length - 1), 1)[0]);
  }
  while (picks.length < 3) picks.push(UPOOL.find(u => u.id === 'repair'));
  return picks;
}

function applyUpgrade(id) {
  const u = UPOOL.find(x => x.id === id);
  if (!u) return;
  u.apply(G.player);
  G.upgrades[id] = (G.upgrades[id] || 0) + 1;
  toast(u.ico + ' ' + u.name);
  AU.level();
}

/* ============================================================
   UI WIRING
   ============================================================ */
const el = {};
['hud', 'menu', 'levelup', 'paused', 'gameover', 'cards', 'hpfill', 'hptext',
 'hpbar', 'xpfill', 'lvltext', 'nukeline', 'timer', 'score', 'bossbar', 'bossfill',
 'stats', 'newbest', 'bestline', 'ptsline', 'toast', 'warnbanner',
 'store', 'storebtn', 'storeback', 'storepts', 'storeups', 'storeitems', 'storeweapons',
 'startbtn', 'retrybtn', 'menubtn', 'resumebtn', 'quitbtn', 'pausebtn', 'mutebtn',
 'devlogo', 'devbtn', 'devmenu', 'devbody', 'devrestart', 'devreset', 'devback'
].forEach(id => { el[id] = document.getElementById(id); });

function toast(msg, ms) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.add('hidden'), ms || 1400);
}

function showWarn(msg) {
  el.warnbanner.textContent = msg;
  el.warnbanner.classList.remove('hidden');
  clearTimeout(showWarn._t);
  showWarn._t = setTimeout(() => el.warnbanner.classList.add('hidden'), 2600);
}

function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function updateHUD() {
  const p = G.player;
  const pct = clamp(p.hp / p.maxhp, 0, 1);
  el.hpfill.style.width = (pct * 100).toFixed(1) + '%';
  el.hptext.textContent = Math.ceil(p.hp) + ' / ' + Math.round(p.maxhp);
  el.hpbar.classList.toggle('low', pct < 0.3);
  el.xpfill.style.width = clamp(G.xp / G.xpNeed, 0, 1) * 100 + '%';
  el.lvltext.textContent = 'LV ' + G.level;
  el.nukeline.textContent = '☢ ×' + p.nukes + (p.shields > 0 ? '   🛡 ×' + p.shields : '');
  el.timer.textContent = fmtTime(G.time);
  el.score.textContent = Math.floor(G.score).toLocaleString('en-US');
  if (G.boss) el.bossfill.style.width = clamp(G.boss.hp / G.boss.maxhp, 0, 1) * 100 + '%';
}

function onLevelUp() {
  if (G.mode !== 'playing') return;
  G.mode = 'levelup';
  AU.level();
  spawnParts(G.player.x, G.player.y, COL.xp, 30, 320, 0.8, 5);
  const picks = rollUpgrades();
  el.cards.innerHTML = '';
  picks.forEach((u) => {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = '<div class="ico">' + u.ico + '</div><div class="nm">' + u.name + '</div><div class="ds">' + u.desc + '</div>';
    d.addEventListener('click', () => {
      AU.click();
      applyUpgrade(u.id);
      el.levelup.classList.add('hidden');
      G.mode = 'playing';
      // chain: leftover xp may have queued another level
      if (G.xp >= G.xpNeed) { gainXP(0); }
    });
    el.cards.appendChild(d);
  });
  el.levelup.classList.remove('hidden');
}

function startGame() {
  AU.init(); AU.click();
  resetGame();
  G.mode = 'playing';
  el.menu.classList.add('hidden');
  el.store.classList.add('hidden');
  el.gameover.classList.add('hidden');
  el.paused.classList.add('hidden');
  el.levelup.classList.add('hidden');
  el.hud.classList.remove('hidden');
  el.bossbar.classList.add('hidden');
  updateHUD();
  toast('SURVIVE');
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').catch(() => {});
    }
  } catch (e) {}
}

function gameOver() {
  G.mode = 'gameover';
  AU.boom(true);
  addShake(0.8);
  const p = G.player;
  spawnParts(p.x, p.y, COL.player, 60, 420, 1.1, 6);
  const isBest = G.score > G.best;
  if (isBest) {
    G.best = G.score;
    try { localStorage.setItem('neonvoid_best', String(G.best)); } catch (e) {}
  }
  const earned = Math.floor(G.score / 25);
  if (earned > 0) { META.pts += earned; saveMeta(); }
  el.stats.innerHTML =
    '<div><div class="sv">' + Math.floor(G.score).toLocaleString('en-US') + '</div><div class="sl">SCORE</div></div>' +
    '<div><div class="sv">' + fmtTime(G.time) + '</div><div class="sl">SURVIVED</div></div>' +
    '<div><div class="sv">' + G.kills + '</div><div class="sl">KILLS</div></div>' +
    '<div><div class="sv">' + G.level + '</div><div class="sl">LEVEL</div></div>' +
    '<div><div class="sv">+' + earned.toLocaleString('en-US') + '</div><div class="sl">POINTS EARNED</div></div>' +
    '<div><div class="sv">' + WEAPONS[META.weapon].name + '</div><div class="sl">WEAPON</div></div>';
  el.newbest.classList.toggle('hidden', !isBest);
  el.bestline.textContent = G.best > 0 ? 'BEST  ' + G.best.toLocaleString('en-US') : '';
  setTimeout(() => {
    el.hud.classList.add('hidden');
    el.gameover.classList.remove('hidden');
  }, 900);
}

function togglePause() {
  if (G.mode === 'playing') {
    G.mode = 'paused';
    el.paused.classList.remove('hidden');
    AU.click();
  } else if (G.mode === 'paused') {
    G.mode = 'playing';
    el.paused.classList.add('hidden');
    AU.click();
  }
}

/* ============================================================
   STORE — spend points on permanent upgrades, weapons, items
   ============================================================ */
function pips(lvl, max) {
  let s = '';
  for (let i = 0; i < max; i++) s += i < lvl ? '●' : '○';
  return s;
}
function storeRow(parent, ico, name, desc, lvl, max, cost, onBuy, cls) {
  const row = document.createElement('div');
  row.className = 'srow' + (cls ? ' ' + cls : '');
  const info = document.createElement('div');
  info.className = 'sinfo';
  info.innerHTML =
    '<div class="sicotx">' + ico + '</div>' +
    '<div><div class="snm">' + name + '</div>' +
    '<div class="sds">' + desc + '</div>' +
    '<div class="spips">' + pips(lvl, max) + '</div></div>';
  const btn = document.createElement('button');
  const maxed = lvl >= max;
  btn.className = 'sbuy' + (maxed ? ' maxed' : '');
  btn.textContent = maxed ? 'MAX' : cost + ' ◈';
  if (!maxed) btn.addEventListener('click', () => {
    if (META.pts < cost) { toast('NOT ENOUGH POINTS'); AU.hit(); return; }
    onBuy();
    saveMeta(); AU.click();
    renderStore(); refreshMenuPts();
  });
  row.appendChild(info);
  row.appendChild(btn);
  parent.appendChild(row);
}
function renderStore() {
  el.storepts.textContent = '◈ ' + META.pts.toLocaleString('en-US') + ' PTS';
  el.storeups.innerHTML = '';
  META_UPS.forEach(u => {
    const lvl = META.up[u.id];
    storeRow(el.storeups, u.ico, u.name, u.desc, lvl, u.max, metaCost(u.base, lvl),
      () => { META.pts -= metaCost(u.base, lvl); META.up[u.id]++; toast(u.ico + ' ' + u.name + ' +' + META.up[u.id]); }, 'up');
  });
  el.storeitems.innerHTML = '';
  META_ITEMS.forEach(u => {
    const lvl = META[u.id];
    storeRow(el.storeitems, u.ico, u.name, u.desc, lvl, u.max, metaCost(u.base, lvl),
      () => { META.pts -= metaCost(u.base, lvl); META[u.id]++; toast(u.ico + ' ' + u.name); }, 'item');
  });
  el.storeweapons.innerHTML = '';
  Object.keys(WEAPONS).forEach(id => {
    const w = WEAPONS[id];
    const owned = META.weapons[id];
    const equipped = META.weapon === id;
    const row = document.createElement('div');
    row.className = 'srow wpn' + (equipped ? ' equipped' : '');
    const info = document.createElement('div');
    info.className = 'sinfo';
    info.innerHTML =
      '<div class="sicotx">' + w.ico + '</div>' +
      '<div><div class="snm">' + w.name + '</div>' +
      '<div class="sds">' + w.desc + '</div></div>';
    const btn = document.createElement('button');
    btn.className = 'sbuy' + (equipped ? ' maxed' : '');
    btn.textContent = equipped ? 'EQUIPPED' : owned ? 'EQUIP' : w.cost + ' ◈';
    btn.addEventListener('click', () => {
      if (!owned) {
        if (META.pts < w.cost) { toast('NOT ENOUGH POINTS'); AU.hit(); return; }
        META.pts -= w.cost;
        META.weapons[id] = true;
        toast(w.ico + ' ' + w.name + ' UNLOCKED');
      }
      META.weapon = id;
      saveMeta(); AU.click();
      renderStore(); refreshMenuPts();
    });
    row.appendChild(info);
    row.appendChild(btn);
    el.storeweapons.appendChild(row);
  });
}
function refreshMenuPts() {
  el.ptsline.textContent = '◈ ' + META.pts.toLocaleString('en-US') + ' PTS';
  el.bestline.textContent = G.best > 0 ? 'BEST  ' + G.best.toLocaleString('en-US') : '';
}
function openStore() {
  AU.init(); AU.click();
  renderStore();
  el.menu.classList.add('hidden');
  el.store.classList.remove('hidden');
}
function closeStore() {
  AU.click();
  el.store.classList.add('hidden');
  el.menu.classList.remove('hidden');
  refreshMenuPts();
}

/* ============================================================
   DEV CONSOLE — hidden tuner menu
   Access: tap the tiny version badge on the main menu 7x.
   Taps 1-3 silent, tap 4/5/6 count down, tap 7 unlocks.
   ============================================================ */
const DEV_KEY = 'neonvoid_dev';
let devTaps = 0, devTapLast = 0;

function devLogoTap() {
  const now = performance.now();
  if (now - devTapLast > 1400) devTaps = 0; // taps must be in a row
  devTapLast = now;
  devTaps++;
  if (devTaps === 4) toast('UNLOCK IN 3');
  else if (devTaps === 5) toast('UNLOCK IN 2');
  else if (devTaps === 6) toast('UNLOCK IN 1');
  else if (devTaps >= 7) {
    devTaps = 0;
    unlockDev();
    toast('UNLOCKED');
    AU.click();
  }
}

function unlockDev() {
  el.devbtn.classList.remove('hidden');
  try { localStorage.setItem(DEV_KEY, '1'); } catch (e) {}
}

function openDev() {
  AU.click();
  renderDev();
  el.menu.classList.add('hidden');
  el.devmenu.classList.remove('hidden');
}
function closeDev() {
  AU.click();
  el.devmenu.classList.add('hidden');
  el.menu.classList.remove('hidden');
  refreshMenuPts();
}

function devNum(label, get, set, step, min, max, dec) {
  const row = document.createElement('div');
  row.className = 'devrow';
  const lab = document.createElement('label');
  lab.textContent = label;
  const val = document.createElement('span');
  val.className = 'v';
  const fmt = (v) => (dec > 0 ? v.toFixed(dec) : String(Math.round(v)));
  const upd = () => { val.textContent = fmt(get()); };
  const minus = document.createElement('button');
  minus.textContent = '−';
  const plus = document.createElement('button');
  plus.textContent = '+';
  minus.addEventListener('click', () => { set(clamp(get() - step, min, max)); upd(); AU.click(); });
  plus.addEventListener('click', () => { set(clamp(get() + step, min, max)); upd(); AU.click(); });
  upd();
  row.append(lab, minus, val, plus);
  return row;
}

function devSection(title) {
  const h = document.createElement('div');
  h.className = 'devsec';
  h.textContent = title;
  return h;
}
function devGrid() {
  const g = document.createElement('div');
  g.className = 'devgrid';
  return g;
}

function renderDev() {
  const b = el.devbody;
  b.innerHTML = '';
  const num = (parent, label, obj, key, step, min, max, dec) =>
    parent.appendChild(devNum(label, () => obj[key], (v) => { obj[key] = v; }, step, min, max, dec));

  // ---- spawning (live) ----
  b.appendChild(devSection('SPAWNING · applies live'));
  let g = devGrid(); b.appendChild(g);
  num(g, 'Max enemies', CFG, 'maxEnemies', 5, 1, 500, 0);
  num(g, 'Spawn interval base (s)', CFG, 'spawnBase', 0.05, 0.05, 5, 2);
  num(g, 'Interval shrink /s', CFG, 'spawnDecay', 0.0005, 0, 0.05, 4);
  num(g, 'Spawn interval min (s)', CFG, 'spawnMin', 0.05, 0.05, 5, 2);
  num(g, 'Batch +1 every (s)', CFG, 'batchEvery', 1, 5, 300, 0);
  num(g, 'Elite every (s)', CFG, 'eliteEvery', 1, 5, 600, 0);
  num(g, 'First elite at (s)', CFG, 'firstElite', 1, 0, 600, 0);
  num(g, 'Boss every (s)', CFG, 'bossEvery', 5, 10, 1200, 0);
  num(g, 'First boss at (s)', CFG, 'firstBoss', 5, 0, 1200, 0);

  // ---- enemy scaling (live) ----
  b.appendChild(devSection('ENEMY SCALING · applies live'));
  g = devGrid(); b.appendChild(g);
  num(g, 'HP doubles every (s)', CFG, 'hpRate', 1, 5, 900, 0);
  num(g, 'Speed ramps over (s)', CFG, 'spdRate', 5, 20, 1800, 0);
  num(g, 'Speed growth cap', CFG, 'spdCap', 0.05, 0, 2, 2);
  num(g, 'Damage doubles every (s)', CFG, 'dmgRate', 5, 20, 1800, 0);

  // ---- enemy types (new spawns) ----
  b.appendChild(devSection('ENEMY TYPES · applies to newly spawned'));
  Object.keys(ETYPES).forEach((t) => {
    const dh = document.createElement('div');
    dh.className = 'devtype';
    dh.textContent = t.toUpperCase();
    b.appendChild(dh);
    g = devGrid(); b.appendChild(g);
    const E = ETYPES[t];
    num(g, 'HP', E, 'hp', 1, 1, 9999, 0);
    num(g, 'Speed', E, 'spd', 5, 10, 1200, 0);
    num(g, 'Damage', E, 'dmg', 1, 0, 999, 0);
    num(g, 'XP', E, 'xp', 1, 0, 500, 0);
    num(g, 'Score', E, 'score', 5, 0, 5000, 0);
  });

  // ---- drops (live) ----
  b.appendChild(devSection('DROPS · applies live'));
  g = devGrid(); b.appendChild(g);
  num(g, 'Elite nuke chance', CFG, 'eliteNukeCh', 0.01, 0, 1, 2);
  num(g, 'Elite heal chance', CFG, 'eliteHealCh', 0.01, 0, 1, 2);

  // ---- player base (next run) ----
  b.appendChild(devSection('PLAYER BASE · applies on run start'));
  g = devGrid(); b.appendChild(g);
  num(g, 'Max hull', PBASE, 'hp', 5, 1, 5000, 0);
  num(g, 'Move speed', PBASE, 'speed', 10, 50, 1500, 0);
  num(g, 'Fire rate /s', PBASE, 'fireRate', 0.25, 0.5, 30, 2);
  num(g, 'Bullet damage', PBASE, 'dmg', 1, 1, 999, 0);
  num(g, 'Projectiles', PBASE, 'proj', 1, 1, 12, 0);
  num(g, 'Pierce', PBASE, 'pierce', 1, 0, 12, 0);
  num(g, 'Bullet speed', PBASE, 'bulletSpeed', 20, 100, 4000, 0);
  num(g, 'Magnet radius', PBASE, 'magnet', 5, 10, 900, 0);
  num(g, 'Homing stage', PBASE, 'seek', 1, 0, 5, 0);
  num(g, 'Crit chance', PBASE, 'crit', 0.05, 0, 1, 2);
  num(g, 'Starting nukes', PBASE, 'nukes', 1, 0, 9, 0);
  num(g, 'Starting shields', PBASE, 'shields', 1, 0, 9, 0);

  // ---- progression (next run) ----
  b.appendChild(devSection('PROGRESSION · applies on run start'));
  g = devGrid(); b.appendChild(g);
  num(g, 'XP base', CFG, 'xpBase', 0.5, 1, 200, 1);
  num(g, 'XP power', CFG, 'xpPow', 0.01, 1, 3, 2);

  // ---- points ----
  b.appendChild(devSection('POINTS · applies immediately'));
  g = devGrid(); b.appendChild(g);
  const prow = document.createElement('div');
  prow.className = 'devrow';
  const plab = document.createElement('label');
  plab.textContent = 'Points';
  const pval = document.createElement('span');
  pval.className = 'v';
  const pstep = (d) => {
    META.pts = Math.max(0, META.pts + d);
    saveMeta(); refreshMenuPts(); pval.textContent = META.pts.toLocaleString('en-US');
    AU.click();
  };
  const mkp = (t, d) => {
    const btn = document.createElement('button');
    btn.textContent = t; btn.style.width = 'auto'; btn.style.padding = '0 8px';
    btn.addEventListener('click', () => pstep(d));
    return btn;
  };
  pval.textContent = META.pts.toLocaleString('en-US');
  prow.append(plab, mkp('−1K', -1000), pval, mkp('+1K', 1000), mkp('+10K', 10000));
  g.appendChild(prow);
}

function devResetAll() {
  DEVPARAMS.forEach((k) => { CFG[k] = CFG_DEFAULTS[k]; });
  Object.keys(ETYPES).forEach((t) => {
    Object.keys(ETYPES_DEFAULTS[t]).forEach((k) => {
      if (typeof ETYPES_DEFAULTS[t][k] === 'number') ETYPES[t][k] = ETYPES_DEFAULTS[t][k];
    });
  });
  Object.assign(PBASE, PBASE_DEFAULTS);
  renderDev();
  refreshMenuPts();
  toast('DEFAULTS RESTORED');
  AU.click();
}

el.startbtn.addEventListener('click', startGame);
el.retrybtn.addEventListener('click', startGame);
el.menubtn.addEventListener('click', () => {
  AU.click();
  G.mode = 'menu';
  el.gameover.classList.add('hidden');
  el.hud.classList.add('hidden');
  el.menu.classList.remove('hidden');
  refreshMenuPts();
});
el.storebtn.addEventListener('click', openStore);
el.storeback.addEventListener('click', closeStore);
el.devlogo.addEventListener('click', devLogoTap);
el.devbtn.addEventListener('click', openDev);
el.devback.addEventListener('click', closeDev);
el.devreset.addEventListener('click', devResetAll);
el.devrestart.addEventListener('click', () => {
  AU.click();
  el.devmenu.classList.add('hidden');
  startGame();
});
try {
  if (localStorage.getItem(DEV_KEY) === '1') el.devbtn.classList.remove('hidden');
} catch (e) {}
el.resumebtn.addEventListener('click', togglePause);
el.quitbtn.addEventListener('click', () => {
  AU.click();
  G.mode = 'menu';
  el.paused.classList.add('hidden');
  el.hud.classList.add('hidden');
  el.menu.classList.remove('hidden');
  refreshMenuPts();
});
el.pausebtn.addEventListener('click', () => { if (G.mode === 'playing' || G.mode === 'paused') togglePause(); });
el.mutebtn.addEventListener('click', () => {
  AU.init();
  AU.setMuted(!AU.muted);
  el.mutebtn.classList.toggle('off', AU.muted);
  el.mutebtn.textContent = AU.muted ? '✕' : '♪';
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && G.mode === 'playing') togglePause();
});

/* ============================================================
   UPDATE
   ============================================================ */
function updatePlayer(dt, inp) {
  const p = G.player;
  // nuke trigger (panic button)
  if (IN.nukeQueued && p.nukes > 0 && p.alive) fireNuke();
  if (G.demo && p.nukes > 0 && p.alive && p.hp < p.maxhp * 0.3) fireNuke();
  IN.nukeQueued = false;

  const tx = inp.mx * p.speed, ty = inp.my * p.speed;
  const k = 1 - Math.exp(-12 * dt);
  p.vx = lerp(p.vx, tx, k);
  p.vy = lerp(p.vy, ty, k);
  p.x = clamp(p.x + p.vx * dt, p.r, CFG.world.w - p.r);
  p.y = clamp(p.y + p.vy * dt, p.r, CFG.world.h - p.r);
  p.inv = Math.max(0, p.inv - dt);

  // facing / firing
  if (inp.firing) {
    p.aimX = inp.ax; p.aimY = inp.ay;
    p.faceX = inp.ax; p.faceY = inp.ay;
    p.fireT -= dt;
    if (p.fireT <= 0) fireBullets(inp.ax, inp.ay);
  } else {
    p.fireT = 0;
    const md = Math.hypot(inp.mx, inp.my);
    if (md > 0.1) {
      p.faceX = lerp(p.faceX, inp.mx / md, 1 - Math.exp(-14 * dt));
      p.faceY = lerp(p.faceY, inp.my / md, 1 - Math.exp(-14 * dt));
    }
  }
}

function updateBullets(dt) {
  const p = G.player;
  for (let i = G.bullets.length - 1; i >= 0; i--) {
    const b = G.bullets[i];
    b.life -= dt; b.t += dt;
    if (b.life <= 0 || b.x < -40 || b.x > CFG.world.w + 40 || b.y < -40 || b.y > CFG.world.h + 40) {
      G.bullets.splice(i, 1); continue;
    }
    // heat-seeking: steer toward the nearest enemy roughly ahead of the bullet
    if (b.seek > 0 && G.enemies.length) {
      const TURN = [0, 1.4, 3.0, 6.0, 12.0, 60.0][Math.min(5, b.seek)] || 0;
      const spd = Math.hypot(b.vx, b.vy) || 1;
      const fx = b.vx / spd, fy = b.vy / spd;
      let best = null, bd = 520 * 520;
      for (const e of G.enemies) {
        const ex = e.x - b.x, ey = e.y - b.y;
        const d2 = ex * ex + ey * ey;
        if (d2 > bd || d2 < 1) continue;
        const dot = (ex * fx + ey * fy) / Math.sqrt(d2);
        if (dot < 0.35) continue; // must be roughly ahead
        bd = d2; best = e;
      }
      if (best && TURN > 0) {
        const want = Math.atan2(best.y - b.y, best.x - b.x);
        const cur = Math.atan2(b.vy, b.vx);
        let da = want - cur;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        const na = cur + clamp(da, -TURN * dt, TURN * dt);
        b.vx = Math.cos(na) * spd; b.vy = Math.sin(na) * spd;
      }
    }
    b.x += b.vx * dt; b.y += b.vy * dt;
    // vs enemies
    for (let j = G.enemies.length - 1; j >= 0; j--) {
      const e = G.enemies[j];
      const rr = b.r + e.r;
      if (dist2(b.x, b.y, e.x, e.y) > rr * rr) continue;
      if (b.hitSet && b.hitSet.has(e)) continue;
      const crit = Math.random() < b.critC;
      const dmg = b.dmg * (crit ? 2.2 : 1) * rand(0.9, 1.1);
      const d = Math.hypot(b.vx, b.vy) || 1;
      damageEnemy(e, dmg, b.vx / d, b.vy / d, crit);
      if (b.pierce > 0) {
        b.pierce--;
        if (!b.hitSet) b.hitSet = new Set();
        b.hitSet.add(e);
      } else {
        G.bullets.splice(i, 1);
      }
      break;
    }
  }
}

function updateEnemies(dt) {
  const p = G.player;
  for (let i = G.enemies.length - 1; i >= 0; i--) {
    const e = G.enemies[i];
    e.t += dt;
    e.flash = Math.max(0, e.flash - dt);
    e.rot += e.rotV * dt;
    const dx = p.x - e.x, dy = p.y - e.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = dx / d, ny = dy / d;
    let sx = 0, sy = 0; // seek velocity

    if (e.boss) {
      if (e.state === 'enter') {
        e.stateT -= dt;
        sx = nx * e.spd * 2.2; sy = ny * e.spd * 2.2;
        if (e.stateT <= 0 || d < 200) e.state = 'fight';
      } else {
        sx = nx * e.spd * 0.55; sy = ny * e.spd * 0.55;
        e.atkT -= dt;
        if (e.atkT <= 0) {
          bossAttack(e);
          e.atkT = Math.max(1.4, 2.7 - G.bossCount * 0.25);
        }
      }
    } else if (e.type === 'mite') {
      const wob = Math.sin(e.t * 6) * 0.35;
      sx = (nx + -ny * wob) * e.spd; sy = (ny + nx * wob) * e.spd;
    } else if (e.type === 'tank') {
      sx = nx * e.spd; sy = ny * e.spd;
    } else if (e.type === 'dasher') {
      e.stateT -= dt;
      if (e.state === 'chase') {
        sx = nx * e.spd; sy = ny * e.spd;
        if (d < 300 && e.stateT <= 0) { e.state = 'windup'; e.stateT = 0.5; e.dx = nx; e.dy = ny; }
      } else if (e.state === 'windup') {
        sx = 0; sy = 0;
        e.flash = 0.05;
        e.dx = lerp(e.dx, nx, dt * 4); e.dy = lerp(e.dy, ny, dt * 4);
        if (e.stateT <= 0) {
          e.state = 'dash'; e.stateT = 0.32;
          const dd = Math.hypot(e.dx, e.dy) || 1;
          e.vx = e.dx / dd * e.spd * 4.4; e.vy = e.dy / dd * e.spd * 4.4;
          spawnParts(e.x, e.y, e.color, 8, 180, 0.3, 3);
        }
      } else if (e.state === 'dash') {
        if (e.stateT <= 0) { e.state = 'recover'; e.stateT = 0.7; }
      } else { // recover
        sx = nx * e.spd * 0.3; sy = ny * e.spd * 0.3;
        if (e.stateT <= 0) { e.state = 'chase'; e.stateT = 0.4; }
      }
    } else if (e.type === 'spitter') {
      // keep distance ~400, strafe
      const want = 400;
      const radial = d > want + 60 ? 1 : d < want - 60 ? -0.8 : 0;
      const strafe = Math.sin(e.t * 1.7) > 0 ? 1 : -1;
      sx = (nx * radial + -ny * 0.6 * strafe) * e.spd;
      sy = (ny * radial + nx * 0.6 * strafe) * e.spd;
      e.fireT -= dt;
      if (e.fireT <= 0 && d < 720) {
        e.fireT = rand(1.8, 2.6);
        // slight lead
        const lead = clamp(d / 340, 0, 0.5);
        const tx = p.x + p.vx * lead, ty = p.y + p.vy * lead;
        const a = Math.atan2(ty - e.y, tx - e.x);
        enemyShoot(e.x, e.y, Math.cos(a), Math.sin(a), 300, e.dmg);
        spawnParts(e.x, e.y, e.color, 5, 140, 0.25, 3);
      }
    }

    // integrate: knockback velocity decays, seek velocity direct
    const kd = Math.exp(-5 * dt);
    e.vx *= kd; e.vy *= kd;
    e.x += (sx + e.vx) * dt;
    e.y += (sy + e.vy) * dt;

    // contact damage
    if (p.alive) {
      const rr = e.r + p.r;
      if (dist2(e.x, e.y, p.x, p.y) < rr * rr) {
        damagePlayer(e.dmg, e.x, e.y);
      }
    }
  }
}

function updateEBullets(dt) {
  const p = G.player;
  for (let i = G.ebullets.length - 1; i >= 0; i--) {
    const b = G.ebullets[i];
    b.life -= dt; b.t += dt;
    if (b.life <= 0 || b.x < -40 || b.x > CFG.world.w + 40 || b.y < -40 || b.y > CFG.world.h + 40) {
      G.ebullets.splice(i, 1); continue;
    }
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (p.alive) {
      const rr = b.r + p.r * 0.8;
      if (dist2(b.x, b.y, p.x, p.y) < rr * rr) {
        damagePlayer(b.dmg, b.x - b.vx * 0.05, b.y - b.vy * 0.05);
        G.ebullets.splice(i, 1);
      }
    }
  }
}

function update(dt) {
  G.time += dt;
  G.score += dt * 5;
  let inp = readInput();
  if (G.demo) inp = demoInput();
  if (G.player.alive) updatePlayer(dt, inp);
  updateSpawns(dt);
  updateEnemies(dt);
  updateBullets(dt);
  updateEBullets(dt);
  updatePickups(dt);
  updateParts(dt);
}

/* demo autopilot for headless testing / screenshots */
function demoInput() {
  const p = G.player;
  const t = G.time;
  const mx = Math.cos(t * 0.9), my = Math.sin(t * 0.9);
  let ax = p.faceX, ay = p.faceY, firing = false;
  let best = null, bd = Infinity;
  for (const e of G.enemies) {
    const d2 = dist2(p.x, p.y, e.x, e.y);
    if (d2 < bd) { bd = d2; best = e; }
  }
  if (best) {
    const d = Math.sqrt(bd) || 1;
    ax = (best.x - p.x) / d; ay = (best.y - p.y) / d;
    firing = true;
  }
  return { mx, my, ax, ay, firing };
}

/* ============================================================
   RENDER
   ============================================================ */
let vigGrad = null;
function buildStatic() {
  vigGrad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
  vigGrad.addColorStop(1, 'rgba(0,0,10,0.55)');
}
/* (vignette rebuilt inside resize()) */

function poly(n, r, rot) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function neon(color, width) {
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = width * 3.2;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawDiamond(x, y, r, rot, color, fill) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.beginPath();
  ctx.moveTo(0, -r); ctx.lineTo(r * 0.7, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.7, 0);
  ctx.closePath();
  if (fill) { ctx.fillStyle = color; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; }
  else neon(color, 2);
  ctx.restore();
}

/* ---- main-menu backdrop: retro outer-space "Tron" scene ---- */
let stars = [];
function buildStars() {
  stars = [];
  const n = Math.max(80, Math.floor((W * H) / 9000));
  for (let i = 0; i < n; i++) {
    stars.push({ x: Math.random() * W, y: Math.random() * H * 0.62, z: rand(0.25, 1), tw: rand(0, TAU) });
  }
}

function drawMenuBG() {
  const t = performance.now() / 1000;
  // deep space gradient
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#020208');
  g.addColorStop(0.55, '#060818');
  g.addColorStop(0.8, '#0d0724');
  g.addColorStop(1, '#120a2e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // twinkling starfield
  ctx.fillStyle = '#cfeaff';
  for (const s of stars) {
    ctx.globalAlpha = (0.35 + 0.65 * Math.abs(Math.sin(t * 1.6 + s.tw))) * s.z;
    const sz = s.z * 2.4;
    ctx.fillRect(s.x, s.y, sz, sz);
  }
  ctx.globalAlpha = 1;
  const hz = H * 0.62; // horizon line
  // neon sun (synthwave, partially below horizon)
  const sunX = W / 2, sunR = Math.min(W, H) * 0.24;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, hz); ctx.clip();
  const sg = ctx.createLinearGradient(0, hz - sunR * 2, 0, hz);
  sg.addColorStop(0, '#ffe27a');
  sg.addColorStop(0.55, '#ff9e57');
  sg.addColorStop(1, '#ff4d6d');
  ctx.fillStyle = sg;
  ctx.beginPath(); ctx.arc(sunX, hz, sunR, 0, TAU); ctx.fill();
  // scanline gaps widening toward the bottom
  ctx.fillStyle = '#0d0724';
  for (let i = 0; i < 7; i++) {
    const yy = hz - sunR + (i / 7) * sunR * 2;
    if (yy < hz - sunR * 0.1) continue;
    ctx.fillRect(sunX - sunR - 4, yy, sunR * 2 + 8, 1.5 + i * 1.8);
  }
  ctx.restore();
  // magenta glow wash just above the horizon
  const mg = ctx.createLinearGradient(0, hz - 110, 0, hz);
  mg.addColorStop(0, 'rgba(255,77,221,0)');
  mg.addColorStop(1, 'rgba(255,77,221,0.14)');
  ctx.fillStyle = mg;
  ctx.fillRect(0, hz - 110, W, 110);
  // perspective grid floor (Tron)
  ctx.strokeStyle = 'rgba(70,246,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const vpx = W / 2;
  for (let i = -12; i <= 12; i++) {
    ctx.moveTo(vpx + i * W * 0.018, hz);
    ctx.lineTo(vpx + i * W * 0.24, H);
  }
  const scroll = (t * 0.4) % 1;
  for (let i = 0; i < 12; i++) {
    const p = (i + scroll) / 12;
    const y = hz + (H - hz) * p * p;
    ctx.moveTo(0, y); ctx.lineTo(W, y);
  }
  ctx.stroke();
  // glowing horizon line
  ctx.strokeStyle = 'rgba(255,77,221,0.85)';
  ctx.lineWidth = 2.5;
  ctx.shadowColor = '#ff4dd9'; ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.moveTo(0, hz); ctx.lineTo(W, hz); ctx.stroke();
  ctx.shadowBlur = 0;
}

function draw() {
  // main menu gets the full-screen Tron backdrop instead of the world
  if (G.mode === 'menu') {
    drawMenuBG();
    if (vigGrad) { ctx.fillStyle = vigGrad; ctx.fillRect(0, 0, W, H); }
    return;
  }
  updateCamera();
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  // camera + screen shake (shake applied in screen space)
  let shx = 0, shy = 0;
  if (G.trauma > 0) {
    const s = G.trauma * G.trauma * 16;
    shx = rand(-s, s); shy = rand(-s, s);
  }
  ctx.translate(W / 2 + shx, H / 2 + shy);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  // grid (world space, visible region only)
  const vh = viewHalf();
  const x0 = cam.x - vh.hw - 40, x1 = cam.x + vh.hw + 40;
  const y0 = cam.y - vh.hh - 40, y1 = cam.y + vh.hh + 40;
  ctx.strokeStyle = 'rgba(90,140,255,0.07)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const gs = 64;
  for (let x = Math.max(0, Math.floor(x0 / gs) * gs); x <= Math.min(CFG.world.w, x1); x += gs) {
    ctx.moveTo(x, Math.max(0, y0)); ctx.lineTo(x, Math.min(CFG.world.h, y1));
  }
  for (let y = Math.max(0, Math.floor(y0 / gs) * gs); y <= Math.min(CFG.world.h, y1); y += gs) {
    ctx.moveTo(Math.max(0, x0), y); ctx.lineTo(Math.min(CFG.world.w, x1), y);
  }
  ctx.stroke();

  // arena border (world bounds)
  ctx.strokeStyle = 'rgba(70,246,255,0.35)';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, CFG.world.w - 4, CFG.world.h - 4);

  // pickups
  const tt = performance.now() / 1000;
  for (const k of G.pickups) {
    const pulse = 1 + Math.sin(tt * 6 + k.x) * 0.15;
    if (k.kind === 'xp') drawDiamond(k.x, k.y, k.r * pulse, tt * 2, COL.xp, true);
    else if (k.kind === 'nuke') {
      ctx.save();
      ctx.translate(k.x, k.y);
      ctx.strokeStyle = '#ffd76a';
      ctx.globalAlpha = 0.9; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, 0, 15 * pulse, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.font = '700 20px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = '#ffd76a'; ctx.shadowBlur = 10;
      ctx.fillStyle = '#ffd76a';
      ctx.fillText('☢', 0, 1);
      ctx.restore();
    }
    else {
      ctx.save();
      ctx.translate(k.x, k.y);
      ctx.fillStyle = COL.heal;
      ctx.globalAlpha = 0.9;
      const s2 = 9 * pulse;
      ctx.fillRect(-s2, -3, s2 * 2, 6);
      ctx.fillRect(-3, -s2, 6, s2 * 2);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  // enemies
  for (const e of G.enemies) {
    ctx.save();
    ctx.translate(e.x, e.y);
    const col = e.flash > 0 ? '#ffffff' : e.color;
    if (e.boss) {
      // outer rotating octagon
      ctx.rotate(e.rot);
      poly(8, e.r, 0); neon(col, 4);
      ctx.rotate(-e.rot * 1.7);
      poly(8, e.r * 0.68, 0); neon(col, 2.5);
      // core
      ctx.fillStyle = '#fff';
      ctx.globalAlpha = 0.85 + Math.sin(tt * 8) * 0.15;
      ctx.beginPath(); ctx.arc(0, 0, e.r * 0.2, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.rotate(e.rot);
      poly(e.shape, e.r, 0); neon(col, 2.5);
      if (e.elite) {
        ctx.rotate(-e.rot * 2);
        poly(e.shape, e.r * 0.55, 0); neon('#ffffff', 1.6);
      }
      if (e.type === 'dasher' && e.state === 'windup') {
        // telegraph line toward dash dir
        ctx.rotate(-e.rot);
        ctx.strokeStyle = e.color; ctx.globalAlpha = 0.5; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.lineTo(e.dx * 220, e.dy * 220); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
    // enemy hp pip for tough enemies
    if ((e.elite || e.type === 'tank') && e.hp < e.maxhp) {
      const w = e.r * 1.6;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(e.x - w / 2, e.y - e.r - 12, w, 4);
      ctx.fillStyle = e.color;
      ctx.fillRect(e.x - w / 2, e.y - e.r - 12, w * clamp(e.hp / e.maxhp, 0, 1), 4);
    }
  }

  // player
  const p = G.player;
  if (p && (G.mode === 'playing' || G.mode === 'levelup' || G.mode === 'paused')) {
    const blink = p.inv > 0 && Math.floor(tt * 18) % 2 === 0;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = blink ? 0.35 : 1;
    const fa = Math.atan2(p.faceY, p.faceX);
    ctx.rotate(fa);
    // engine flame
    const spd = Math.hypot(p.vx, p.vy);
    if (spd > 60) {
      ctx.fillStyle = '#ffb347';
      ctx.globalAlpha *= 0.8;
      const fl = 10 + Math.sin(tt * 40) * 5 + spd * 0.02;
      ctx.beginPath();
      ctx.moveTo(-p.r * 0.8, 5); ctx.lineTo(-p.r * 0.8 - fl, 0); ctx.lineTo(-p.r * 0.8, -5);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = blink ? 0.35 : 1;
    }
    // ship: sleek arrow
    ctx.beginPath();
    ctx.moveTo(p.r * 1.15, 0);
    ctx.lineTo(-p.r * 0.75, p.r * 0.72);
    ctx.lineTo(-p.r * 0.4, 0);
    ctx.lineTo(-p.r * 0.75, -p.r * 0.72);
    ctx.closePath();
    neon(COL.player, 2.5);
    // cockpit
    ctx.fillStyle = '#eafcff';
    ctx.beginPath(); ctx.arc(p.r * 0.25, 0, p.r * 0.22, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
    // aegis shield rings
    if (p.shields > 0) {
      ctx.strokeStyle = 'rgba(125,249,255,0.7)';
      ctx.lineWidth = 2;
      for (let i = 0; i < p.shields; i++) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 8 + i * 6, 0, TAU);
        ctx.stroke();
      }
    }
  }

  // bullets
  ctx.lineCap = 'round';
  for (const b of G.bullets) {
    const d = Math.hypot(b.vx, b.vy) || 1;
    const tx = b.vx / d, ty = b.vy / d;
    ctx.strokeStyle = COL.bullet;
    ctx.globalAlpha = 0.35; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(b.x - tx * 14, b.y - ty * 14); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(b.x - tx * 14, b.y - ty * 14); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // enemy bullets
  for (const b of G.ebullets) {
    const pul = 1 + Math.sin(b.t * 14) * 0.2;
    ctx.fillStyle = COL.elite;
    ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 2 * pul, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * pul, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.45 * pul, 0, TAU); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // particles
  for (const pt of G.parts) {
    ctx.globalAlpha = clamp(pt.life / pt.maxLife, 0, 1);
    ctx.fillStyle = pt.color;
    const s2 = pt.size * (pt.life / pt.maxLife);
    ctx.fillRect(pt.x - s2 / 2, pt.y - s2 / 2, s2, s2);
  }
  ctx.globalAlpha = 1;

  // floating texts
  ctx.textAlign = 'center';
  for (const f of G.floats) {
    ctx.globalAlpha = clamp(f.life / f.maxLife, 0, 1);
    ctx.font = '700 ' + f.size + 'px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = f.color;
    ctx.fillText(f.txt, f.x, f.y);
  }
  ctx.globalAlpha = 1;

  // nuke shockwaves (world space)
  for (const s of G.shocks) {
    const a = clamp(s.life / s.maxLife, 0, 1);
    ctx.globalAlpha = a * 0.85;
    ctx.strokeStyle = '#ffd76a';
    ctx.lineWidth = 12 * a + 2;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 0.93, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // nuke flash (screen space)
  if (G.flash > 0) {
    ctx.fillStyle = 'rgba(255,250,235,' + (G.flash * 0.8).toFixed(3) + ')';
    ctx.fillRect(0, 0, W, H);
  }

  // vignette
  if (vigGrad) { ctx.fillStyle = vigGrad; ctx.fillRect(0, 0, W, H); }

  // touch controls — screen space (only while playing, on touch devices)
  if (G.mode === 'playing' && 'ontouchstart' in window) {
    // nuke button (top-right, radius 34)
    const bx = IN.nukeBX, by = IN.nukeBY, br = 34;
    const p2 = G.player;
    const armed = p2.nukes > 0;
    ctx.globalAlpha = armed ? 0.92 : 0.3;
    ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU);
    ctx.strokeStyle = '#ffd76a'; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#ffd76a';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 17px sans-serif';
    ctx.fillText('☢', bx, by - 7);
    ctx.font = '700 11px sans-serif';
    ctx.fillText('×' + p2.nukes, bx, by + 10);
    ctx.globalAlpha = 1;
    // fixed virtual sticks — always visible, knob follows the finger
    const drawStick = (ox, oy, dx, dy, col, active) => {
      ctx.globalAlpha = active ? 0.35 : 0.15;
      ctx.beginPath(); ctx.arc(ox, oy, 62, 0, TAU);
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      ctx.globalAlpha = active ? 0.7 : 0.3;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(ox + dx * 62, oy + dy * 62, 24, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
    };
    drawStick(IN.moveBX, IN.moveBY, IN.mX, IN.mY, COL.player, IN.mActive);
    drawStick(IN.aimBX, IN.aimBY, IN.aX, IN.aY, '#ff9e57', IN.aActive);
  }

  // low-hp pulse
  if (G.mode === 'playing' && p && p.hp / p.maxhp < 0.32 && p.alive) {
    const a = 0.25 + Math.sin(tt * 6) * 0.12;
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
    g.addColorStop(0, 'rgba(255,40,70,0)');
    g.addColorStop(1, 'rgba(255,40,70,' + a.toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
}

/* ============================================================
   MAIN LOOP
   ============================================================ */
let lastT = 0, acc = 0, hudT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!lastT) lastT = now;
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.1) dt = 0.1;

  if (G.hitstop > 0) {
    G.hitstop -= dt;
  } else if (G.mode === 'playing') {
    acc += dt;
    let n = 0;
    while (acc >= CFG.step && n < 5) { update(CFG.step); acc -= CFG.step; n++; }
    if (n === 5) acc = 0;
    hudT -= dt;
    if (hudT <= 0) { hudT = 0.12; updateHUD(); }
  } else if (G.mode === 'menu' || G.mode === 'gameover') {
    // ambient drift behind overlays
    updateParts(dt);
  }
  draw();

  // demo: auto-pick upgrade cards
  if (G.demo && G.mode === 'levelup' && !frame._picking) {
    frame._picking = true;
    setTimeout(() => {
      frame._picking = false;
      const c = el.cards.firstChild;
      if (c) c.click();
    }, 350);
  }
}

/* ============================================================
   BOOT
   ============================================================ */
resize();
refreshMenuPts();
window.addEventListener('blur', () => { IN.keys = {}; });

// headless test hook
window.__NV = { G, CFG, IN, META, WEAPONS, startGame, spawnEnemy, gainXP, damagePlayer, damageEnemy, rollUpgrades, applyUpgrade, fireNuke, update, draw, updateHUD, updateCamera, ETYPES, PBASE, devLogoTap, unlockDev, renderDev, devResetAll, openDev };

if (window.location.hash.indexOf('autodemo') >= 0) {
  G.demo = true;
  startGame();
  // ?ff=N — synchronously fast-forward N ticks (deterministic screenshots / testing)
  const ffm = /ff=(\d+)/.exec(window.location.hash);
  if (ffm) {
    const n = parseInt(ffm[1], 10);
    for (let i = 0; i < n && G.mode !== 'gameover'; i++) {
      if (G.mode === 'levelup') {
        const picks = rollUpgrades();
        applyUpgrade(picks[0].id);
        el.levelup.classList.add('hidden');
        G.mode = 'playing';
      }
      if (G.mode === 'playing') update(CFG.step);
    }
    updateHUD();
  }
} else {
  // menu ambience: a few drifting particles
  setInterval(() => {
    if (G.mode === 'menu' && G.parts.length < 60) {
      spawnParts(rand(0, W), rand(0, H), pick([COL.player, COL.xp, COL.elite]), 1, 30, 2.5, 3);
    }
  }, 120);
}
requestAnimationFrame(frame);
