import { startMatch, play, runUntilHuman, simulateGames } from "../engine/loop.js";
import {
  BATTLEFIELD,
  ZONE_LABELS,
  labelSide,
  controllerOf,
  isContested,
  isBattlefield,
  soldiersIn,
  coversIn,
  stepZone,
  sideZones,
  ownZone1,
  ownTrench,
  enemySideZones,
  capType,
  zoneDistance,
  clone,
  presentFx,
  resetIds,
  smoked,
  canSoldierTarget,
  soldierMayFire,
  soldierStrikeTargets,
  infantryFireOffers,
  machineGunOperational,
  machineGunTargets,
} from "../engine/core.js";
import { remaining, comboLabel, naturalFaces, unusedDice, hasWildFace } from "../engine/dice.js";
import { apply, isInteractive, canDeployMortar, machineGunsInSupply, mortarsInSupply, tanksInSupply, tanksReadyToMove } from "../engine/game.js";
import {
  EMPTY_SKIP,
  coverCountdown,
  coverCountdownText,
  emptyStepReason,
  pinnedInitiative,
  sameActionSeat,
  undoOffer,
} from "../engine/feedback.js";
import { eventNeeds, bayonetDestinations } from "../engine/events.js";
import { allocationReady } from "../engine/combat.js";
import {
  FILENAME,
  recordFinished,
  readLedger,
  summarize,
  onBattleLoaded,
  dropIfUnfinished,
  ensureMatchId,
  buildBalanceWorkbook,
} from "../export/ledger.js";
import { GAME_VERSION } from "../version.js";

const STEPS = [
  ["shock", "Shock"],
  ["tank", "Tank"],
  ["event", "Events"],
  ["deploy", "Deploy"],
  ["move", "Move"],
  ["cover", "Cover"],
  ["attack", "Attack"],
];

const FACES = ["boot", "whistle", "wild", "shovel", "bayonet"];
const FACE_LABEL = { boot: "Boot", whistle: "Whistle", wild: "Wild", shovel: "Shovel", bayonet: "Bayonet" };
const TRENCH_LINE = ["ukTrench", "uk1", "uk2", "uk3", "obj", "de3", "de2", "de1", "deTrench"];
const ATTACK_ICON = { hit: "assets/die-hit.png", miss: "assets/die-miss.png" };
const MORTAR_ICON = { z1: "assets/die-zone1.png", z2: "assets/die-zone2.png", z3: "assets/die-zone3.png" };

let catalog = null;
let state = null;
let buttons = [];
let attackHint = "";
let deployNote = "";
let history = [];
let missionToast = null;
let missionQueue = [];
let missionTimer = 0;
let missionSerial = 0;
let killToast = null;
let killQueue = [];
let killTimer = 0;
let killSerial = 0;
const RESULT_NOTICE_MS = 5000;
let setup = { format: "standard", human: "uk", mode: "solo", undo: "off", difficulty: "Hard" };
let coverAsk = null;
let ui = freshUi();
const SAVE_KEY = "trench-shock-battle";
let menuOpen = false;
let paused = false;
let menuNote = "";
let menuConfirm = null;
let menuLink = "";
let updateBusy = false;
let updateLeaving = false;
const UPDATE_PAGE = "https://github.com/arcoraci/eTrenchShock";
const UPDATE_NOTE_KEY = "trench-shock-update-note";

function versionLabel() {
  return `Version ${GAME_VERSION}`;
}
let savedStamp = null;
let leaveAsk = null;
let stepReturn = null;
let actionCapture = null;
let actionUndo = null;
let attackDraft = null;
let emptyTimer = 0;
let emptyMemo = null;
let holdEmpty = null;

function freshUi() {
  return {
    soldiers: [],
    card: null,
    cover: null,
    unit: null,
    targetUnit: null,
    zone: null,
    enemy: null,
    dice: [],
    dieIndex: null,
    wildAs: null,
    order: null,
    supportType: "mg",
    targetKind: "exposed",
    dir: "forward",
    acked: null,
    help: false,
    tab: "events",
    allocStack: [],
  };
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function actorSide() {
  if (!state) return null;
  if (state.pending?.type === "generals-order" || state.pending?.type === "spotter" || state.pending?.type === "mortar-target" || state.pending?.type === "gambit" || state.pending?.type === "pick-mission") {
    return state.pending.side;
  }
  if (state.phase === "reroll" || state.phase === "action" || state.phase === "regroup") return state.active;
  return state.human;
}

function viewer() {
  return state?.mode === "hotseat" ? actorSide() : state?.human;
}

function myTurn() {
  if (!state || state.phase === "end") return false;
  if (state.mode === "hotseat") return ui.acked === actorSide();
  return actorSide() === state.human;
}

function clearEmptyTimer() {
  window.clearTimeout(emptyTimer);
  emptyTimer = 0;
}

function helmet(side) {
  const file = side === "uk" ? "soldier-british.png" : "soldier-german.png";
  return `<img src="assets/${file}" alt="" draggable="false">`;
}

const FACE_ICON = {
  boot: "assets/die-boot.png?v=2",
  whistle: "assets/die-whistle.png?v=2",
  wild: "assets/die-wild.png?v=2",
  shovel: "assets/die-shovel.png?v=2",
  bayonet: "assets/die-bayonet.png?v=2",
};

function faceSvg(face) {
  const src = FACE_ICON[face];
  if (!src) return "";
  return `<img src="${src}" alt="" draggable="false">`;
}

const SOUND_KEY = "trench-shock-sound";
const ACTION_POOL = ["boot", "whistle", "wild", "shovel", "bayonet"];
const ATTACK_POOL = ["hit", "miss"];
const MORTAR_POOL = ["z1", "z2", "z3"];
let audioCtx = null;
let tumble = null;
let coverMemory = null;
let flipPhase = new Map();
let flipTimer = 0;
let hitFlash = null;
let hitFlashTimer = 0;
let glance = null;
let glanceTimer = 0;

function reducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function soundEnabled() {
  try {
    return localStorage.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

function setSoundEnabled(on) {
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* The toggle still changes for this page view if storage is blocked. */
  }
  if (!on && audioCtx) audioCtx.suspend().catch(() => {});
}

function withAudio(play) {
  if (!soundEnabled()) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  if (!audioCtx) audioCtx = new Ctx();
  const run = () => {
    try {
      play(audioCtx);
    } catch {
      /* A missed click is better than a thrown sound. */
    }
  };
  if (audioCtx.state === "suspended") {
    audioCtx.resume().then(run).catch(() => {});
    return;
  }
  run();
}

function tone(ctx, freq, duration, type, gain, slide) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slide), now + duration);
  amp.gain.setValueAtTime(gain, now);
  amp.gain.exponentialRampToValueAtTime(0.001, now + duration);
  osc.connect(amp);
  amp.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

function playDice() {
  withAudio((ctx) => {
    const now = ctx.currentTime;
    const length = Math.floor(ctx.sampleRate * 0.045);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.setValueAtTime(1400, now);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.32, now);
    amp.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    src.connect(filter);
    filter.connect(amp);
    amp.connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.05);
  });
}

function playWhistle() {
  withAudio((ctx) => {
    tone(ctx, 980, 0.16, "sine", 0.08, 1680);
    tone(ctx, 1480, 0.12, "triangle", 0.03, 1900);
  });
}

function playThud() {
  withAudio((ctx) => {
    tone(ctx, 110, 0.18, "sine", 0.28, 42);
  });
}

function playHit() {
  withAudio((ctx) => {
    tone(ctx, 240, 0.045, "square", 0.05, 90);
  });
}

function playStamp() {
  withAudio((ctx) => {
    tone(ctx, 180, 0.07, "triangle", 0.12, 90);
    tone(ctx, 96, 0.1, "sine", 0.16, 48);
  });
}

function resetPresentation() {
  window.clearTimeout(tumble?.timer);
  tumble = null;
  window.clearTimeout(flipTimer);
  flipTimer = 0;
  flipPhase = new Map();
  window.clearTimeout(hitFlashTimer);
  hitFlashTimer = 0;
  hitFlash = null;
  window.clearTimeout(glanceTimer);
  glanceTimer = 0;
  glance = null;
  clearFx();
}

let fxLive = [];
let fxRaf = 0;
let fxClaims = null;

function clearFx() {
  fxLive = [];
  if (fxRaf) cancelAnimationFrame(fxRaf);
  fxRaf = 0;
  document.querySelector(".fx-layer")?.remove();
  document.querySelectorAll(".fx-hidden").forEach((el) => el.classList.remove("fx-hidden"));
}

function fxSpan(beat) {
  if (beat.kind === "mortar") return beat.motion === false ? 480 : 1200;
  if (beat.kind === "gas") {
    const n = Math.max(1, (beat.zones || []).length);
    return Math.min(1300, 780 + (n - 1) * 160);
  }
  if (beat.kind === "elim") return 520;
  if (beat.kind === "cover") return 560;
  if (beat.kind === "charge") return 500;
  if (beat.kind === "tank") {
    const steps = Math.max(1, (beat.path || []).length - 1);
    return Math.min(1200, 700 * steps + (beat.breakthrough ? 200 : 0));
  }
  return 600;
}

function noteFx(beforeIds, after) {
  const seen = new Set(beforeIds || []);
  const fresh = (after?.fx || []).filter((beat) => beat && !seen.has(beat.id));
  if (!fresh.length) return;
  const playable = presentFx(fresh, reducedMotion());
  if (!playable.length) return;
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const impactHold = new Map();
  const chargeHold = new Map();
  let shells = 0;
  for (const beat of playable) {
    if (beat.kind === "mortar" && beat.motion !== false && beat.zone) {
      impactHold.set(beat.zone, shells * 150 + 820);
      shells += 1;
    }
    if (beat.kind === "charge" && beat.zone) chargeHold.set(beat.zone, 220);
  }
  shells = 0;
  for (const beat of playable) {
    let delay = 0;
    if (beat.kind === "mortar") {
      delay = shells * 150;
      shells += 1;
    }
    let hold = 0;
    if (beat.kind === "elim" || beat.kind === "cover") {
      if (beat.zone && impactHold.has(beat.zone)) hold = Math.max(hold, impactHold.get(beat.zone) - delay);
      if (beat.kind === "elim" && beat.zone && chargeHold.has(beat.zone)) hold = Math.max(hold, chargeHold.get(beat.zone));
    }
    fxLive.push({ ...beat, t0: now + delay, hold, life: hold + fxSpan(beat), trail: [] });
  }
  if (playable.some((beat) => beat.kind === "elim" || beat.kind === "cover")) playHit();
}

function fxProgress(beat, now) {
  const elapsed = now - beat.t0;
  if (elapsed < 0) return -1;
  const hold = beat.hold || 0;
  const span = Math.max(1, beat.life - hold);
  if (elapsed <= hold) return 0;
  return Math.min(1, (elapsed - hold) / span);
}

function kickFx() {
  if (fxRaf || !fxLive.length) return;
  fxRaf = requestAnimationFrame(fxFrame);
}

function zoneBox(id) {
  const el = document.querySelector(`.zone[data-id="${id}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return {
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height * 0.62,
    w: rect.width,
    h: rect.height,
  };
}

function fxRand(seed, i) {
  const x = Math.sin((seed || 1) * 12.9898 + i * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function fxLayer() {
  let layer = document.querySelector("body > .fx-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "fx-layer";
    layer.setAttribute("aria-hidden", "true");
    const canvas = document.createElement("canvas");
    canvas.className = "fx-canvas";
    layer.appendChild(canvas);
    document.body.appendChild(layer);
  }
  return layer;
}

function fxContext(layer) {
  const canvas = layer.querySelector("canvas");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pw = Math.max(1, Math.floor(w * dpr));
  const ph = Math.max(1, Math.floor(h * dpr));
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

function fxGhost(layer, key, className) {
  if (!fxClaims) fxClaims = new Set();
  fxClaims.add(key);
  let el = layer.querySelector(`[data-fx="${key}"]`);
  if (!el) {
    el = document.createElement("div");
    el.className = `fx-ghost ${className}`;
    el.dataset.fx = key;
    layer.appendChild(el);
  }
  return el;
}

function portrait(el, src) {
  if (el.querySelector("img")) return;
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.src = src;
  el.appendChild(img);
}

function soldierSrc(owner) {
  return owner === "de" ? "assets/soldier-german.png" : "assets/soldier-british.png";
}

function tankSrc(owner) {
  return owner === "de" ? "assets/tank-german.png" : "assets/tank-british.png";
}

function flashZone(zoneId) {
  const zone = document.querySelector(`.zone[data-id="${zoneId}"]`);
  if (!zone || reducedMotion()) return;
  zone.querySelectorAll(".token, .cover, .unit").forEach((el) => {
    el.classList.remove("hit-flash");
    void el.offsetWidth;
    el.classList.add("hit-flash");
  });
}

function syncHidden(now) {
  document.querySelectorAll(".fx-hidden").forEach((el) => el.classList.remove("fx-hidden"));
  for (const beat of fxLive) {
    const u = fxProgress(beat, now);
    if (u < 0 || u > 0.96) continue;
    if (beat.kind === "tank" && !beat.breakthrough && beat.unitId) {
      document.querySelector(`.unit[data-id="${beat.unitId}"]`)?.classList.add("fx-hidden");
    }
    if (beat.kind === "charge") {
      for (const id of beat.soldierIds || []) {
        document.querySelector(`.token[data-id="${id}"]`)?.classList.add("fx-hidden");
      }
    }
  }
}

function drawMortar(ctx, beat, u) {
  const to = zoneBox(beat.zone);
  if (!to) return;
  if (beat.motion === false) {
    ctx.save();
    ctx.translate(to.cx, to.cy);
    ctx.strokeStyle = "rgba(232, 214, 170, 0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#241910";
    ctx.beginPath();
    ctx.ellipse(0, 0, 10, 4, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#b08a45";
    ctx.beginPath();
    ctx.ellipse(8, -2, 3.5, 2.6, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  const from = zoneBox(beat.from) || to;
  const flightEnd = 0.68;
  const t = Math.min(1, u / flightEnd);
  const lift = Math.min(132, 68 + Math.abs(to.cx - from.cx) * 0.2);
  const x = from.cx + (to.cx - from.cx) * t;
  const y = from.cy + (to.cy - from.cy) * t - Math.sin(Math.PI * t) * lift;
  if (t < 1) {
    const last = beat.trail[beat.trail.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) > 6) beat.trail.push({ x, y });
    if (beat.trail.length > 14) beat.trail.shift();
  }
  beat.trail.forEach((p, i) => {
    const age = (i + 1) / beat.trail.length;
    ctx.beginPath();
    ctx.fillStyle = `rgba(92, 80, 64, ${0.12 + age * 0.28})`;
    ctx.arc(p.x, p.y, 2 + age * 3.6, 0, Math.PI * 2);
    ctx.fill();
    if (i % 3 === 0) {
      ctx.beginPath();
      ctx.fillStyle = `rgba(214, 150, 70, ${age * 0.75})`;
      ctx.arc(p.x + 3, p.y + 2, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  if (t < 1) {
    const ahead = Math.min(1, t + 0.04);
    const ax = from.cx + (to.cx - from.cx) * ahead;
    const ay = from.cy + (to.cy - from.cy) * ahead - Math.sin(Math.PI * ahead) * lift;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.atan2(ay - y, ax - x));
    ctx.fillStyle = "#2a2118";
    ctx.beginPath();
    ctx.ellipse(-1, 0, 12, 4.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c4a15a";
    ctx.beginPath();
    ctx.ellipse(9, 0, 4.2, 3.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#6b5332";
    ctx.fillRect(-5, -3.4, 3.2, 6.8);
    ctx.restore();
  }
  const burst = Math.max(0, (u - flightEnd) / (1 - flightEnd));
  if (burst <= 0) return;
  if (!beat.flashed) {
    beat.flashed = true;
    flashZone(beat.zone);
  }
  const fade = 1 - burst;
  ctx.save();
  ctx.translate(to.cx, to.cy);
  ctx.beginPath();
  ctx.fillStyle = `rgba(244, 226, 176, ${fade * 0.85})`;
  ctx.arc(0, 0, 8 + burst * 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = `rgba(232, 210, 160, ${fade})`;
  ctx.lineWidth = 3;
  ctx.arc(0, 0, 8 + burst * 58, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 12; i += 1) {
    const angle = fxRand(beat.id, i) * Math.PI * 2;
    const speed = 16 + fxRand(beat.id, i + 20) * 42;
    ctx.beginPath();
    ctx.fillStyle = i % 2 ? `rgba(92, 70, 48, ${fade})` : `rgba(186, 164, 120, ${fade})`;
    ctx.arc(Math.cos(angle) * speed * burst, Math.sin(angle) * speed * burst * 0.72, 1.6 + fxRand(beat.id, i + 40) * 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawGas(ctx, beat, u) {
  const span = Math.max(1, beat.life - (beat.hold || 0));
  (beat.zones || []).forEach((id, i) => {
    const box = zoneBox(id);
    if (!box) return;
    const start = (i * 160) / span;
    const cloud = 760 / span;
    const local = (u - start) / cloud;
    if (local <= 0 || local >= 1) return;
    const alpha = local < 0.22 ? local / 0.22 : 1 - (local - 0.22) / 0.78;
    const drift = local * 22;
    for (let p = 0; p < 5; p += 1) {
      const rad = 18 + p * 7 + local * 10;
      ctx.beginPath();
      ctx.fillStyle = `rgba(${168 - p * 6}, ${152 - p * 8}, ${62 - p * 4}, ${alpha * 0.24})`;
      ctx.ellipse(box.cx + (p - 2) * 16, box.cy - 16 - drift - p * 4, rad * 1.15, rad * 0.66, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function drawElim(layer, beat, u) {
  const box = zoneBox(beat.zone);
  if (!box) return;
  const el = fxGhost(layer, `elim-${beat.id}`, "fx-soldier");
  portrait(el, soldierSrc(beat.owner));
  const tilt = (beat.owner === "de" ? 1 : -1) * u * 18;
  el.style.left = `${box.cx - 23}px`;
  el.style.top = `${box.cy - 28 + u * 40}px`;
  el.style.opacity = String(1 - u * 0.95);
  el.style.transform = `rotate(${tilt}deg)`;
}

function drawCoverBreak(ctx, beat, u) {
  const box = zoneBox(beat.zone);
  if (!box) return;
  const crack = Math.min(1, u / 0.42);
  const fade = u < 0.4 ? 1 : 1 - (u - 0.4) / 0.6;
  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.globalAlpha = Math.max(0, fade);
  ctx.fillStyle = "#6d5138";
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#1c140e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-18 * crack, -6 * crack);
  ctx.lineTo(2 * crack, 1 * crack);
  ctx.lineTo(16 * crack, 14 * crack);
  ctx.moveTo(-2 * crack, -18 * crack);
  ctx.lineTo(3 * crack, -1 * crack);
  ctx.lineTo(-12 * crack, 16 * crack);
  ctx.stroke();
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2 + 0.2;
    const dist = u * (16 + (i % 3) * 12);
    ctx.save();
    ctx.translate(Math.cos(angle) * dist, Math.sin(angle) * dist);
    ctx.rotate(angle + u * 2);
    ctx.fillStyle = i % 2 ? "#8b6844" : "#3a2b1e";
    ctx.fillRect(-5, -1.6, 10, 3.2);
    ctx.restore();
  }
  ctx.restore();
}

function alongPath(path, t) {
  const pts = (path || []).map((id) => zoneBox(id)).filter(Boolean);
  if (!pts.length) return null;
  if (pts.length === 1 || t <= 0) return pts[0];
  const span = pts.length - 1;
  const f = Math.min(0.999, t) * span;
  const i = Math.min(span - 1, Math.floor(f));
  const local = f - i;
  const ease = local * local * (3 - 2 * local);
  const a = pts[i];
  const b = pts[i + 1];
  return { cx: a.cx + (b.cx - a.cx) * ease, cy: a.cy + (b.cy - a.cy) * ease };
}

function drawTank(layer, ctx, beat, u) {
  const travelPortion = beat.breakthrough ? 0.78 : 1;
  const pt = alongPath(beat.path, Math.min(1, u / travelPortion));
  if (!pt) return;
  const el = fxGhost(layer, `tank-${beat.id}`, "fx-tank");
  portrait(el, tankSrc(beat.owner));
  const punch = beat.breakthrough && u > travelPortion;
  const punchU = punch ? (u - travelPortion) / (1 - travelPortion) : 0;
  el.style.left = `${pt.cx - 52}px`;
  el.style.top = `${pt.cy - 36}px`;
  el.style.opacity = String(punch ? Math.max(0, 1 - punchU) : 1);
  el.style.transform = `scale(${punch ? 1 + Math.sin(punchU * Math.PI) * 0.18 : 1})`;
  if (!punch) return;
  ctx.save();
  ctx.translate(pt.cx, pt.cy);
  ctx.beginPath();
  ctx.strokeStyle = `rgba(232, 206, 140, ${1 - punchU})`;
  ctx.lineWidth = 3;
  ctx.arc(0, 0, 12 + punchU * 48, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawCharge(layer, beat, u) {
  const from = zoneBox(beat.from);
  const to = zoneBox(beat.zone);
  if (!from || !to) return;
  (beat.soldierIds || []).forEach((id, i) => {
    const shift = Math.min(0.24, i * 0.08);
    const local = Math.min(1, Math.max(0, (u - shift) / (1 - shift)));
    const el = fxGhost(layer, `charge-${beat.id}-${id}`, "fx-soldier");
    portrait(el, soldierSrc(beat.owner));
    const hop = Math.sin(Math.PI * local) * 16;
    const x = from.cx + (to.cx - from.cx) * local + (i - 1) * 14;
    const y = from.cy + (to.cy - from.cy) * local - hop;
    el.style.left = `${x - 23}px`;
    el.style.top = `${y - 28}px`;
    el.style.opacity = "1";
    el.style.transform = `rotate(${(beat.owner === "uk" ? -8 : 8) * (1 - local)}deg)`;
  });
}

function fxFrame(now) {
  fxRaf = 0;
  try {
    fxLive = fxLive.filter((beat) => now < beat.t0 + beat.life + 40);
    if (!fxLive.length) {
      clearFx();
      return;
    }
    const layer = fxLayer();
    const ctx = fxContext(layer);
    fxClaims = new Set();
    syncHidden(now);
    for (const beat of fxLive) {
      const u = fxProgress(beat, now);
      if (u < 0) continue;
      if (beat.kind === "mortar") drawMortar(ctx, beat, u);
      else if (beat.kind === "gas") drawGas(ctx, beat, u);
      else if (beat.kind === "elim") drawElim(layer, beat, u);
      else if (beat.kind === "cover") drawCoverBreak(ctx, beat, u);
      else if (beat.kind === "tank") drawTank(layer, ctx, beat, u);
      else if (beat.kind === "charge") drawCharge(layer, beat, u);
    }
    layer.querySelectorAll("[data-fx]").forEach((el) => {
      if (!fxClaims.has(el.dataset.fx)) el.remove();
    });
    fxRaf = requestAnimationFrame(fxFrame);
  } catch {
    clearFx();
  }
}

function flicker(key, real, pool) {
  const size = pool.length;
  const start = [...key].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const tick = tumble?.tick || 0;
  let face = pool[(start + tick) % size];
  if (face === real) face = pool[(start + tick + 1) % size];
  return face;
}

function dieVisual(kind, face) {
  if (kind === "attack") {
    const hit = face === "hit";
    return { src: ATTACK_ICON[hit ? "hit" : "miss"], label: hit ? "Hit" : "Miss", hit };
  }
  if (kind === "mortar") {
    const label = face === "z1" ? "Zone 1" : face === "z2" ? "Zone 2" : face === "z3" ? "Zone 3" : face;
    return { src: MORTAR_ICON[face] || "", label, hit: false };
  }
  return { src: FACE_ICON[face] || "", label: FACE_LABEL[face] || face, hit: false };
}

function paintDieNode(el, face) {
  const visual = dieVisual(el.dataset.kind, face);
  const img = el.querySelector("img");
  if (img && visual.src) img.src = visual.src;
  const label = el.querySelector("span");
  if (label) label.textContent = visual.label;
  if (el.dataset.kind === "attack") {
    el.classList.toggle("hit", Boolean(visual.hit));
    el.classList.toggle("miss", !visual.hit);
  }
}

function tumbleStep() {
  if (!tumble) return;
  tumble.tick += 1;
  if (tumble.tick >= 6) {
    const nodes = [...document.querySelectorAll("[data-tumble]")];
    tumble = null;
    for (const el of nodes) {
      el.classList.remove("tumbling");
      paintDieNode(el, el.dataset.face);
      delete el.dataset.tumble;
    }
    return;
  }
  for (const el of document.querySelectorAll("[data-tumble]")) {
    const pool = (el.dataset.pool || "").split(",").filter(Boolean);
    if (!pool.length || !tumble.keys.has(el.dataset.tumble)) continue;
    paintDieNode(el, flicker(el.dataset.tumble, el.dataset.face, pool));
  }
  tumble.timer = window.setTimeout(tumbleStep, 70);
}

function startTumble(keys) {
  window.clearTimeout(tumble?.timer);
  if (!keys?.size || reducedMotion()) {
    tumble = null;
    return;
  }
  tumble = { keys, tick: 0, timer: 0 };
  tumble.timer = window.setTimeout(tumbleStep, 70);
}

function tumbleAttrs(key, kind, face, pool) {
  if (!tumble?.keys.has(key)) return "";
  return ` data-tumble="${esc(key)}" data-kind="${kind}" data-face="${esc(face)}" data-pool="${pool.join(",")}"`;
}

function freshLogs(before, after) {
  const prev = before?.log || [];
  const next = after?.log || [];
  if (!prev.length) return next.map((line) => line.text);
  const anchor = prev[0];
  const idx = next.findIndex((line) => line.text === anchor.text && line.round === anchor.round);
  if (idx < 0) return next.slice(0, 8).map((line) => line.text);
  return next.slice(0, idx).map((line) => line.text);
}

function shownRollKey(game) {
  const roll = game?.lastRoll;
  if (!roll) return "";
  const pending = game.pending?.type;
  const live = pending === "allocate-hits" || pending === "spotter" || pending === "mortar-target"
    || (roll.kind === "mustard" && game.phase === "action" && game.actionStep === "shock");
  if (!live) return "";
  if (roll.kind === "mustard") {
    return `mustard:${(roll.zones || []).map((zone) => `${zone.zone}:${(zone.faces || []).join(",")}`).join("|")}`;
  }
  return `${roll.kind}:${(roll.faces || []).join(",")}`;
}

function addActionDice(keys, game) {
  for (const side of ["uk", "de"]) {
    (game?.players?.[side]?.dice || []).forEach((face, index) => {
      if (face) keys.add(`action:${side}:${index}`);
    });
  }
}

function addShownRoll(keys, game) {
  const roll = game?.lastRoll;
  if (!roll) return;
  if (roll.kind === "mustard") {
    (roll.zones || []).forEach((zone, zi) => {
      (zone.faces || []).forEach((_, fi) => keys.add(`mustard:${zi}:${fi}`));
    });
    return;
  }
  const prefix = roll.kind === "mortar" ? "mortar" : "attack";
  (roll.faces || []).forEach((_, index) => keys.add(`${prefix}:${index}`));
}

function loggedAttackFaces(texts) {
  const rolls = [];
  for (const text of texts) {
    const match = String(text || "").match(/\[((?:hit|miss)(?:, (?:hit|miss))*)\]/);
    if (!match) continue;
    rolls.push(match[1].split(", "));
  }
  return rolls;
}

function rememberGlance(faces) {
  if (!faces?.length) return;
  glance = { faces: faces.slice(), hits: faces.filter((face) => face === "hit").length };
  window.clearTimeout(glanceTimer);
  glanceTimer = window.setTimeout(() => {
    glance = null;
    glanceTimer = 0;
    render();
  }, 700);
}

function collectRolls(before, after, action) {
  const keys = new Set();
  const empty = { keys, whistle: false, mortar: false, glance: null };
  if (!before?.players || !after?.players || after.error) return empty;
  const type = action?.type;
  const texts = freshLogs(before, after);
  if (type === "ROLL_1" || before.round !== after.round || texts.some((text) => text.includes("reroll all five"))) {
    addActionDice(keys, after);
  }
  if (type === "REROLL") {
    const side = before.active;
    const keep = Array.isArray(action.keep) ? action.keep : before.players[side]?.kept;
    if (side && Array.isArray(keep)) {
      keep.forEach((held, index) => {
        if (held === false) keys.add(`action:${side}:${index}`);
      });
    }
  }
  if (type === "GENERALS_ORDER" && action.mode === "reroll") {
    const side = action.side || before.pending?.side;
    for (const index of action.indexes || []) {
      if (side) keys.add(`action:${side}:${index}`);
    }
  }
  for (const side of ["uk", "de"]) {
    const prev = before.players[side]?.dice || [];
    const next = after.players[side]?.dice || [];
    const diffs = [];
    next.forEach((face, index) => {
      if (face && face !== prev[index]) diffs.push(index);
    });
    const onlyChange = type === "GENERALS_ORDER" && action.mode === "change"
      && (action.side || before.pending?.side) === side
      && diffs.length === 1
      && Number(diffs[0]) === Number(action.index);
    if (onlyChange) continue;
    for (const index of diffs) keys.add(`action:${side}:${index}`);
  }
  const beforeRoll = shownRollKey(before);
  const afterRoll = shownRollKey(after);
  const forced = Boolean(afterRoll) && (
    type === "START_ATTACK"
    || (type === "SHOCK" && action.option === "gas")
    || (type === "PLAY_EVENT" && texts.some((text) => /Mortar Die|rolls|Mustard Gas|Bayonet Charge/i.test(text)))
  );
  let glanceFaces = null;
  if (afterRoll && (afterRoll !== beforeRoll || forced)) addShownRoll(keys, after);
  else if (!afterRoll) {
    const logged = loggedAttackFaces(texts);
    const hidden = after.lastRoll?.kind === "attack" && (after.lastRoll.faces || []).join(",") !== ((before.lastRoll?.kind === "attack" && before.lastRoll.faces) || []).join(",")
      ? after.lastRoll.faces
      : null;
    glanceFaces = logged.length ? logged[logged.length - 1] : hidden;
    (glanceFaces || []).forEach((_, index) => keys.add(`attack:${index}`));
  }
  const whistle = ["uk", "de"].some((side) => {
    const afterIds = new Set((after.players[side]?.eventHand || []).map((card) => card.inst));
    return (before.players[side]?.eventHand || []).some((card) => (
      !afterIds.has(card.inst) && (card.whistle !== false || card.title === "Bayonet Charge")
    ));
  });
  const mortar = texts.some((text) => /Mortar places 1 Hit|mortar hits/i.test(text));
  return { keys, whistle, mortar, glance: glanceFaces };
}

function noteJuice(before, after, action) {
  const juice = collectRolls(before, after, action);
  if (juice.glance) rememberGlance(juice.glance);
  if (juice.keys.size) {
    startTumble(juice.keys);
    playDice();
  }
  if (juice.whistle) playWhistle();
  if (juice.mortar) playThud();
}

function tumbleFreshDice(game) {
  const keys = new Set();
  addActionDice(keys, game);
  if (!keys.size) return;
  startTumble(keys);
  playDice();
}

function noteCoverFlips() {
  if (!state?.covers) return;
  const next = new Map();
  const starting = [];
  for (const cover of state.covers) {
    if (cover.destroyed) continue;
    const revealed = Boolean(cover.revealed);
    const was = coverMemory ? coverMemory.get(cover.id) : undefined;
    if (coverMemory && was === false && revealed && !flipPhase.has(cover.id) && !reducedMotion()) starting.push(cover.id);
    next.set(cover.id, revealed);
  }
  coverMemory = next;
  if (!starting.length) return;
  for (const id of starting) flipPhase.set(id, "out");
  window.clearTimeout(flipTimer);
  flipTimer = window.setTimeout(() => {
    let changed = false;
    for (const [id, phase] of flipPhase) {
      if (phase === "out") {
        flipPhase.set(id, "in");
        changed = true;
      }
    }
    if (!changed) return;
    render();
    flipTimer = window.setTimeout(() => {
      flipPhase = new Map();
      render();
    }, 220);
  }, 220);
}

function armHitFlash(spec) {
  if (!spec?.ids?.length) return;
  hitFlash = { ids: new Set(spec.ids), cover: Boolean(spec.cover) };
  window.clearTimeout(hitFlashTimer);
  hitFlashTimer = window.setTimeout(() => {
    hitFlash = null;
    hitFlashTimer = 0;
    render();
  }, 420);
}

function assignmentTargets(action, game) {
  if (!action || !game) return null;
  if (action.type === "ALLOCATE_HITS") {
    const ids = (action.picks || []).filter(Boolean);
    const coverId = game.pending?.target?.coverId || null;
    if (coverId) ids.push(coverId);
    return ids.length ? { ids, cover: Boolean(coverId) } : null;
  }
  if (action.type === "ALLOCATE_MORTAR") {
    const option = (game.pending?.options || []).find((item) => item.id === action.targetId);
    if (!option) return null;
    const ids = [option.id, option.coverId, option.soldierId, option.unitId].filter(Boolean);
    const cover = Boolean(option.coverId || option.kind === "cover" || option.kind === "cover-empty");
    if (cover && option.coverId) ids.push(option.coverId);
    return { ids, cover };
  }
  return null;
}

function flashIdsFor(id) {
  const ids = [id];
  const coverId = state.pending?.target?.coverId;
  if (coverId) ids.push(coverId);
  return ids;
}

function promptFlashClass() {
  if (!hitFlash?.cover) return "";
  if (state?.pending?.type !== "allocate-hits" || !state.pending?.target?.coverId) return "";
  return " hit-flash";
}

function attackResolving(game) {
  const type = game?.pending?.type;
  return type === "allocate-hits" || type === "spotter" || type === "mortar-target";
}

function attackFinished(action, beforeStep) {
  const type = action?.type;
  if (type === "START_ATTACK" || type === "RESOLVE_ATTACK" || type === "ALLOCATE_HITS" || type === "ALLOCATE_MORTAR" || type === "OVERRUN" || type === "SKIP_ATTACK") {
    return true;
  }
  if (type === "PICK_SPOTTER") return true;
  if (type === "SHOCK" && action.option === "gas") return true;
  return beforeStep === "attack" && (state.actionStep !== "attack" || state.phase !== "action");
}

function clearAttackSelection() {
  ui.soldiers = [];
  ui.cover = null;
  ui.unit = null;
  ui.targetUnit = null;
  ui.enemy = null;
  ui.zone = null;
  ui.allocStack = [];
}

function trackUndo(action, before, after) {
  const decision = undoOffer(before, after, action, attackDraft);
  if (decision.pending) {
    attackDraft = decision.before;
    actionUndo = null;
    return;
  }
  attackDraft = null;
  if (decision.kind) {
    actionUndo = { kind: decision.kind, before: decision.before };
    holdEmpty = null;
    return;
  }
  actionUndo = null;
  holdEmpty = null;
}

function commit(action, opts = {}) {
  if (actionCapture) {
    actionCapture.push(action);
    return;
  }
  const beforeStep = state?.actionStep;
  const prev = actorSide();
  const beforePulse = (state?.missionPulse || []).map((pulse) => `${pulse.side}:${pulse.inst}`);
  const beforeKills = (state?.killPulse || []).map((note) => note.id);
  const beforeFx = (state?.fx || []).map((beat) => beat.id);
  const allocFlash = assignmentTargets(action, state);
  const undoSnap = clone(state);
  if (state) ensureMatchId(state);
  if (opts.leaving) {
    const snapshot = undoSnap;
    const arrived = apply(state, action);
    if (arrived.error) {
      state = arrived;
    } else {
      if (setup.undo === "on") {
        history.push(snapshot);
        if (history.length > 30) history.shift();
      }
      state = runUntilHuman(arrived);
      stepReturn = returnOffer(snapshot, arrived, state);
    }
  } else {
    state = play(state, action);
    if (!state.error && setup.undo === "on") {
      history.push(undoSnap);
      if (history.length > 30) history.shift();
    }
    if (!state.error) stepReturn = null;
  }
  if (!state.error) trackUndo(action, undoSnap, state);
  if (!state.error) noteBattleOutcome(state);
  if (!state.error) noteJuice(undoSnap, state, action);
  if (!state.error && allocFlash) armHitFlash(allocFlash);
  if (!state.error) queueKillCelebration(beforeKills, state);
  if (!state.error) noteFx(beforeFx, state);
  if (!state.error) queueMissionCelebration(beforePulse, state);
  if (!state.error && !opts.keepUi) {
    ui.card = null;
    ui.dice = [];
    ui.dieIndex = null;
    ui.order = null;
    if (attackResolving(state)) {
      ui.allocStack = [];
    } else if (attackFinished(action, beforeStep)) {
      clearAttackSelection();
    } else {
      ui.soldiers = [];
      ui.cover = null;
      ui.unit = null;
      ui.targetUnit = null;
      ui.enemy = null;
      ui.allocStack = [];
    }
  }
  if (actorSide() !== prev) ui.acked = null;
  render();
}

function stepLabel(stepId) {
  return STEPS.find(([id]) => id === stepId)?.[1] || "";
}

function askLeave(action) {
  if (actionCapture) return;
  if (!myTurn() || state?.phase !== "action") return;
  const stepName = stepLabel(state.actionStep);
  if (!stepName) return;
  if (!stepHasLegalAction()) {
    commit(action, { leaving: true });
    return;
  }
  leaveAsk = { action, stepName };
  render();
}

function confirmLeave() {
  const ask = leaveAsk;
  if (!ask) return;
  leaveAsk = null;
  commit(ask.action, { leaving: true });
}

function stayOnStep() {
  if (!leaveAsk) return;
  leaveAsk = null;
  render();
}

const STEP_LEAVE_LABELS = new Set([
  "Decline the Shock",
  "Hold the tank",
  "Done with events",
  "Done deploying",
  "Done moving",
  "Done with cover",
  "End attacks",
]);

function withSelection(patch, fn) {
  const saved = {
    soldiers: ui.soldiers,
    card: ui.card,
    cover: ui.cover,
    unit: ui.unit,
    targetUnit: ui.targetUnit,
    zone: ui.zone,
    enemy: ui.enemy,
    dice: ui.dice,
    dieIndex: ui.dieIndex,
    dir: ui.dir,
    supportType: ui.supportType,
    targetKind: ui.targetKind,
    attackHint,
    deployNote,
  };
  if ("soldiers" in patch) ui.soldiers = (patch.soldiers || []).slice();
  if ("card" in patch) ui.card = patch.card;
  if ("cover" in patch) ui.cover = patch.cover;
  if ("unit" in patch) ui.unit = patch.unit;
  if ("targetUnit" in patch) ui.targetUnit = patch.targetUnit;
  if ("zone" in patch) ui.zone = patch.zone;
  if ("enemy" in patch) ui.enemy = patch.enemy;
  if ("dice" in patch) ui.dice = (patch.dice || []).slice();
  if ("dieIndex" in patch) ui.dieIndex = patch.dieIndex;
  if ("dir" in patch) ui.dir = patch.dir;
  if ("supportType" in patch) ui.supportType = patch.supportType;
  if ("targetKind" in patch) ui.targetKind = patch.targetKind;
  try {
    return fn();
  } finally {
    ui.soldiers = saved.soldiers;
    ui.card = saved.card;
    ui.cover = saved.cover;
    ui.unit = saved.unit;
    ui.targetUnit = saved.targetUnit;
    ui.zone = saved.zone;
    ui.enemy = saved.enemy;
    ui.dice = saved.dice;
    ui.dieIndex = saved.dieIndex;
    ui.dir = saved.dir;
    ui.supportType = saved.supportType;
    ui.targetKind = saved.targetKind;
    attackHint = saved.attackHint;
    deployNote = saved.deployNote;
  }
}

function offeredActions(list) {
  const found = [];
  const previous = actionCapture;
  actionCapture = found;
  try {
    for (const button of list) {
      if (STEP_LEAVE_LABELS.has(button.label)) continue;
      button.run();
    }
  } finally {
    actionCapture = previous;
  }
  return found;
}

function anyLegalAction(list) {
  for (const action of offeredActions(list)) {
    if (!apply(clone(state), action).error) return true;
  }
  return false;
}

function bayonetIndexes(side) {
  const indexes = [];
  const dice = state.players[side].dice;
  for (let index = 0; index < dice.length; index += 1) {
    if (bayonetChoice(side, index)) indexes.push(index);
  }
  return indexes;
}

function deployStepHasAction(me) {
  const indexes = bayonetIndexes(me);
  const max = Math.min(4, indexes.length);
  for (let n = 1; n <= max; n += 1) {
    if (withSelection({ dice: indexes.slice(0, n) }, () => anyLegalAction(deployButtons(me)))) return true;
  }
  return false;
}

function moveStepHasAction(me) {
  for (const soldier of state.soldiers) {
    if (soldier.owner !== me) continue;
    if (withSelection({ soldiers: [soldier.id], unit: null }, () => anyLegalAction(moveButtons(me)))) return true;
  }
  for (const unit of state.equipment) {
    if (unit.owner !== me || unit.type === "tank") continue;
    if (withSelection({ soldiers: [], unit: unit.id }, () => anyLegalAction(moveButtons(me)))) return true;
  }
  return false;
}

function coverStepHasAction(me) {
  const blank = { soldiers: [], unit: null, cover: null, zone: null };
  const trySel = (patch) => withSelection({ ...blank, ...patch }, () => anyLegalAction(coverButtons(me)));
  for (const soldier of state.soldiers) {
    if (soldier.owner !== me) continue;
    const zone = isBattlefield(soldier.loc) ? soldier.loc : null;
    if (trySel({ soldiers: [soldier.id], zone })) return true;
  }
  for (const zone of BATTLEFIELD) {
    if (trySel({ zone })) return true;
  }
  for (const cover of state.covers) {
    if (cover.destroyed) continue;
    for (const zone of BATTLEFIELD) {
      if (zone === cover.loc || zoneDistance(cover.loc, zone) !== 1) continue;
      if (trySel({ cover: cover.id, zone })) return true;
    }
  }
  return false;
}

function attackStepHasAction(me) {
  const blank = { soldiers: [], unit: null, targetUnit: null, cover: null, zone: null };
  const trySel = (patch) => withSelection({ ...blank, ...patch }, () => anyLegalAction(attackButtons(me)));
  for (const unit of state.equipment) {
    if (unit.owner !== me || !isBattlefield(unit.loc)) continue;
    if (unit.type === "mortar") {
      if (trySel({ unit: unit.id })) return true;
      if (state.effects.precision.includes(unit.id)) {
        for (const zone of BATTLEFIELD) {
          if (trySel({ unit: unit.id, zone })) return true;
        }
      }
    } else if (unit.type === "tank") {
      for (const zone of BATTLEFIELD) {
        if (zoneDistance(unit.loc, zone) > 1) continue;
        if (trySel({ unit: unit.id, zone })) return true;
      }
      for (const cover of state.covers) {
        if (cover.destroyed || cover.loc !== unit.loc) continue;
        if (trySel({ unit: unit.id, cover: cover.id, zone: unit.loc })) return true;
      }
    } else if (unit.type === "mg") {
      if (trySel({ unit: unit.id })) return true;
    }
  }
  const foeUnits = state.equipment.filter((unit) => unit.owner !== me && isBattlefield(unit.loc));
  for (const soldier of state.soldiers) {
    if (soldier.owner !== me || !isBattlefield(soldier.loc)) continue;
    if (state.players[me].attackedIds.includes(soldier.id)) continue;
    for (const zone of BATTLEFIELD) {
      if (zoneDistance(soldier.loc, zone) > 1) continue;
      if (trySel({ soldiers: [soldier.id], zone })) return true;
      for (const cover of state.covers) {
        if (cover.destroyed || cover.loc !== zone) continue;
        if (trySel({ soldiers: [soldier.id], zone, cover: cover.id })) return true;
      }
      for (const unit of foeUnits) {
        if (unit.loc !== zone) continue;
        if (trySel({ soldiers: [soldier.id], zone, targetUnit: unit.id })) return true;
      }
    }
  }
  return false;
}

function eventCanPlay(me, card) {
  if (card.title === "General's Order") return false;
  const opened = state.players[me].eventsAtStep;
  if (opened && !opened.includes(card.inst)) return false;
  if (card.whistle !== false && remaining(state, me, "whistle") < 1) return false;
  const needs = eventNeeds(card.title);
  const zones = needs.some((need) => need === "zone" || need === "enemyZone" || need === "controlledZone")
    ? BATTLEFIELD.slice()
    : [null];
  let soldierLists = [[]];
  if (needs.includes("soldiers")) {
    const byLoc = new Map();
    for (const soldier of state.soldiers) {
      if (soldier.owner !== me) continue;
      if (!byLoc.has(soldier.loc)) byLoc.set(soldier.loc, []);
      byLoc.get(soldier.loc).push(soldier.id);
    }
    soldierLists = [...byLoc.values()].map((ids) => ids.slice(0, 3));
    if (!soldierLists.length) soldierLists = [[]];
  }
  let coverIds = [null];
  if (needs.includes("covers") || needs.includes("enemyCover")) {
    coverIds = state.covers.filter((cover) => !cover.destroyed).map((cover) => cover.id);
    if (!coverIds.length) coverIds = [null];
  }
  let unitIds = [null];
  if (needs.some((need) => need.startsWith("friendly"))) {
    unitIds = state.equipment.filter((unit) => unit.owner === me).map((unit) => unit.id);
    if (!unitIds.length) unitIds = [null];
  }
  let enemyIds = [null];
  if (needs.includes("enemySoldier")) {
    enemyIds = state.soldiers.filter((soldier) => soldier.owner !== me && isBattlefield(soldier.loc)).map((soldier) => soldier.id);
    if (!enemyIds.length) enemyIds = [null];
  }
  const dieIndexes = needs.includes("enemyDie") ? [0, 1, 2, 3, 4] : [null];
  const dirs = card.title === "Patrol" ? ["forward", "back"] : ["forward"];
  const supports = needs.includes("supportType") ? ["mg", "mortar"] : ["mg"];
  const barrage = card.title === "Heavy Barrage" || card.title === "Bombing Run";
  const attempt = (patch) => withSelection({
    card: card.inst,
    soldiers: patch.soldiers || [],
    zone: patch.zone ?? null,
    cover: patch.cover ?? null,
    unit: patch.unit ?? null,
    targetUnit: patch.targetUnit ?? null,
    enemy: patch.enemy ?? null,
    dieIndex: patch.dieIndex ?? null,
    dir: patch.dir || "forward",
    supportType: patch.supportType || "mg",
    targetKind: patch.targetKind || "exposed",
  }, () => anyLegalAction(eventButtons(me)));
  for (const zone of zones) {
    for (const soldiers of soldierLists) {
      for (const cover of coverIds) {
        for (const unit of unitIds) {
          for (const enemy of enemyIds) {
            for (const dieIndex of dieIndexes) {
              for (const dir of dirs) {
                for (const supportType of supports) {
                  const base = { soldiers, zone, cover, unit, enemy, dieIndex, dir, supportType };
                  if (attempt({ ...base, targetKind: "exposed" })) return true;
                  if (!barrage) continue;
                  if (attempt({ ...base, targetKind: "cover" })) return true;
                  const targetUnit = state.equipment.find((item) => item.owner !== me && item.loc === zone)?.id || null;
                  if (attempt({ ...base, targetKind: "unit", targetUnit })) return true;
                }
              }
            }
          }
        }
      }
    }
  }
  return false;
}

function eventStepHasAction(me) {
  return state.players[me].eventHand.some((card) => eventCanPlay(me, card));
}

function stepHasLegalAction() {
  const me = viewer();
  const step = state.actionStep;
  if (!me || state?.phase !== "action") return false;
  if (step === "shock" || step === "tank") return anyLegalAction(actionList());
  if (step === "event") return eventStepHasAction(me);
  if (step === "deploy") return deployStepHasAction(me);
  if (step === "move") return moveStepHasAction(me);
  if (step === "cover") return coverStepHasAction(me);
  if (step === "attack") return attackStepHasAction(me);
  return false;
}

function returnOffer(before, arrived, settled) {
  if (!before || !arrived || arrived.error || settled?.error) return null;
  if (settled !== arrived || settled.phase === "end") return null;
  const actor = settled.active || before.active;
  if (before.phase !== "action" || !isInteractive(settled, before.active) || !isInteractive(settled, actor)) return null;
  const stepName = stepLabel(before.actionStep);
  if (!stepName) return null;
  if (settled.phase === "action" && settled.actionStep === before.actionStep && settled.active === before.active) return null;
  return { snapshot: before, stepName, active: before.active };
}

function veilShowing() {
  return Boolean(state && state.mode === "hotseat" && state.phase !== "end" && ui.acked !== actorSide() && actorSide());
}

function backVisible() {
  if (!stepReturn || !state || state.phase === "end") return false;
  if (veilShowing()) return actorSide() !== stepReturn.active;
  return actorSide() === stepReturn.active && myTurn();
}

function backToSkipped() {
  if (!stepReturn || !state || !backVisible()) return;
  const snap = stepReturn.snapshot;
  stepReturn = null;
  leaveAsk = null;
  actionUndo = null;
  attackDraft = null;
  if (history.length && history[history.length - 1] === snap) history.pop();
  clearMissionCelebration();
  resetPresentation();
  state = snap;
  holdEmpty = { step: state.actionStep, active: state.active, round: state.round };
  forgetUndoneResult(state);
  const tab = ui.tab;
  ui = freshUi();
  ui.tab = tab;
  ui.acked = actorSide();
  render();
}

function backControl() {
  if (!backVisible()) return "";
  return `<div class="actions back-step"><button type="button" data-click="back-step">Back to ${esc(stepReturn.stepName)}</button></div>`;
}

function leaveHtml() {
  if (!leaveAsk) return "";
  const name = leaveAsk.stepName;
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="leave-title"><div class="modal-card leave-card">
    <h2 id="leave-title">Leave ${esc(name)}?</h2>
    <p>Leave ${esc(name)} without taking an action?</p>
    <div class="actions">
      <button type="button" class="primary" data-click="leave-yes">Yes, leave this step</button>
      <button type="button" data-click="leave-no">No, stay</button>
    </div>
  </div></div>`;
}

function undoLast() {
  if (setup.undo !== "on" || !history.length || !state) return;
  clearMissionCelebration();
  resetPresentation();
  stepReturn = null;
  leaveAsk = null;
  actionUndo = null;
  attackDraft = null;
  holdEmpty = null;
  state = history.pop();
  forgetUndoneResult(state);
  const tab = ui.tab;
  ui = freshUi();
  ui.tab = tab;
  ui.acked = actorSide();
  render();
}

function undoLastAction() {
  if (!actionUndo || !sameActionSeat(actionUndo.before, state)) return;
  const snap = actionUndo.before;
  if (history.length && history[history.length - 1] === snap) history.pop();
  clearMissionCelebration();
  resetPresentation();
  stepReturn = null;
  leaveAsk = null;
  actionUndo = null;
  attackDraft = null;
  holdEmpty = null;
  state = snap;
  forgetUndoneResult(state);
  const tab = ui.tab;
  ui = freshUi();
  ui.tab = tab;
  ui.acked = actorSide();
  render();
}

function actionUndoButton() {
  if (!actionUndo || !myTurn() || !sameActionSeat(actionUndo.before, state)) return "";
  const label = actionUndo.kind === "attack" ? "Undo last attack" : "Undo last move";
  return `<button type="button" data-click="undo-action">${label}</button>`;
}

function undoButton(extra = "") {
  if (setup.undo !== "on" || !history.length) return "";
  return `<button type="button" class="ghost ${extra}" data-click="undo" title="Undo the previous action">Undo</button>`;
}

function clearKillCelebration() {
  window.clearTimeout(killTimer);
  killTimer = 0;
  killSerial += 1;
  killToast = null;
  killQueue = [];
}

function clearMissionCelebration() {
  window.clearTimeout(missionTimer);
  missionTimer = 0;
  missionSerial += 1;
  missionToast = null;
  missionQueue = [];
  clearKillCelebration();
}

function revealMission() {
  window.clearTimeout(missionTimer);
  missionToast = missionQueue.shift() || null;
  if (!missionToast) return;
  const serial = ++missionSerial;
  missionTimer = window.setTimeout(() => {
    if (serial !== missionSerial) return;
    dismissMission();
  }, RESULT_NOTICE_MS);
}

function dismissMission() {
  window.clearTimeout(missionTimer);
  missionTimer = 0;
  missionSerial += 1;
  missionToast = null;
  if (killQueue.length && !killToast) revealKill();
  else if (missionQueue.length) revealMission();
  render();
}

function queueMissionCelebration(before, after) {
  if (!after?.missionPulse) return;
  const seen = new Set(before || []);
  const fresh = [];
  for (const pulse of after.missionPulse) {
    const key = `${pulse.side}:${pulse.inst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(pulse);
  }
  if (!fresh.length) return;
  missionQueue.push(...fresh);
  playStamp();
  if (!missionToast && !killToast && !killQueue.length) revealMission();
}

function missionHtml() {
  if (!missionToast) return "";
  const pulse = missionToast;
  return `<div class="mission-celebrate" data-click="mission-done" role="dialog" aria-label="Mission complete">
    <div class="mission-stamp">
      <p class="mission-kicker">${esc(labelSide(pulse.side))} · Mission complete</p>
      <h3>${esc(pulse.title)}</h3>
      <p class="mission-vp">+${pulse.vp} VP</p>
      <p class="mission-dismiss">Click to continue</p>
    </div>
  </div>`;
}

function queueKillCelebration(before, after) {
  const seen = new Set(before || []);
  const fresh = [];
  for (const note of after?.killPulse || []) {
    if (seen.has(note.id)) continue;
    seen.add(note.id);
    fresh.push(note);
  }
  if (!fresh.length) return;
  killQueue.push(...fresh);
  if (!killToast && !missionToast) revealKill();
}

function revealKill() {
  if (missionToast) return;
  window.clearTimeout(killTimer);
  killToast = killQueue.shift() || null;
  if (!killToast) return;
  const serial = ++killSerial;
  killTimer = window.setTimeout(() => {
    if (serial !== killSerial) return;
    dismissKill();
  }, RESULT_NOTICE_MS);
}

function dismissKill() {
  window.clearTimeout(killTimer);
  killTimer = 0;
  killSerial += 1;
  killToast = null;
  if (killQueue.length) revealKill();
  else if (missionQueue.length && !missionToast) revealMission();
  render();
}

function killHtml() {
  if (!killToast) return "";
  const note = killToast;
  return `<div class="kill-celebrate" data-click="kill-done" role="dialog" aria-label="${esc(note.text)}">
    <div class="kill-stamp">
      <p class="kill-line">${esc(note.text)}</p>
      <p class="mission-dismiss">Click to continue</p>
    </div>
  </div>`;
}

function missionNote(side, mission) {
  const deep = enemySideZones(side);
  switch (mission.title) {
    case "Hold in Cover": {
      const held = controllerOf(state, "obj") === side;
      const n = soldiersIn(state, "obj", { side, exposed: false }).length;
      return held ? `${n} in cover on the objective` : "Objective not held";
    }
    case "Over the Top": {
      const n = ["obj", ...deep].reduce((sum, zone) => sum + soldiersIn(state, zone, { side }).length, 0);
      return `${n} / 3 soldiers forward`;
    }
    case "Guns Silenced":
      return state.roundSupportKill[side] ? "Support weapon destroyed" : "No support weapon destroyed yet";
    case "Tank Hunter":
      return state.roundTankKill[side] ? "Tank destroyed" : "No tank destroyed yet";
    case "No Shelter":
      return `${state.players[side].destroyedCover.length} / 3 cover destroyed`;
    case "Deep Push":
      return `${deep.filter((z) => controllerOf(state, z) === side).length} / 2 enemy zones`;
    case "Shock Action":
      return state.roundBurst[side] ? "Three fell to one attack" : "Need 3 eliminations in one attack";
    case "In the Wire": {
      const n = Math.max(0, ...deep.map((z) => soldiersIn(state, z, { side }).length));
      return `${n} / 4 in one enemy zone`;
    }
    case "Dug In": {
      const n = BATTLEFIELD.reduce((sum, z) => sum + soldiersIn(state, z, { side, exposed: false }).length, 0);
      return `${n} / 3 in cover · scores when the round ends`;
    }
    case "Breakthrough": {
      const obj = controllerOf(state, "obj") === side;
      const foot = deep.some((z) => controllerOf(state, z) === side);
      return `${obj ? "Holds the objective" : "Need the objective"} · ${foot ? "inside enemy ground" : "need an enemy zone"}`;
    }
    case "Attrition":
      return `${state.roundElim[side] || 0} / 5 eliminated this round`;
    default:
      return "";
  }
}

function countAt(side, loc) {
  return state.soldiers.filter((s) => s.owner === side && s.loc === loc).length;
}

function zoneHold(id) {
  let cls = "open";
  let name = "Open";
  if (!isBattlefield(id)) {
    cls = id.startsWith("de") ? "de" : "uk";
    name = labelSide(cls);
  } else if (isContested(state, id)) {
    cls = "contested";
    name = "Contested";
  } else {
    const side = controllerOf(state, id);
    if (side) {
      cls = side;
      name = labelSide(side);
    }
  }
  const vp = id === "obj" ? `<b class="obj-vp">2 VP</b>` : "";
  return `<div class="zone-hold ${cls}"><i class="flag" aria-hidden="true"></i><span>${esc(name)}</span>${vp}</div>`;
}

function renderZone(id) {
  const ukAll = state.soldiers.filter((s) => s.loc === id && s.owner === "uk");
  const deAll = state.soldiers.filter((s) => s.loc === id && s.owner === "de");
  const uk = ukAll.filter((s) => !s.coverId);
  const de = deAll.filter((s) => !s.coverId);
  const covers = coversIn(state, id);
  const gear = state.equipment.filter((u) => u.loc === id);
  const ground = id === "obj" ? "obj" : id.startsWith("uk") ? "uk-ground" : id.startsWith("de") ? "de-ground" : "";
  const nation = id.startsWith("uk") ? `<span class="nation uk">Britain</span>` : id.startsWith("de") ? `<span class="nation de">Germany</span>` : `<span class="nation">Both sides</span>`;
  const classes = ["zone", ground, id.includes("Trench") ? "trench" : "", ui.zone === id ? "picked" : "", legalZones().includes(id) ? "legal" : "", state.effects.smoke.includes(id) ? "smoke" : ""];
  let ctrl = "";
  if (isBattlefield(id)) {
    if (isContested(state, id)) ctrl = "<em>Contested</em>tank on the field";
    else if (controllerOf(state, id)) ctrl = `<em>${labelSide(controllerOf(state, id))}</em>control`;
    else ctrl = "<em>Open</em>no control";
  } else {
    const side = id.startsWith("uk") ? "uk" : "de";
    ctrl = `<em>${countAt(side, id)} / 5</em>in the trench`;
  }
  const smoke = state.effects.smoke.includes(id) ? `<span class="zone-meta">Smoke screen</span>` : "";
  const counts = ukAll.length || deAll.length ? `${ukAll.length} British · ${deAll.length} German` : "Empty";
  return `<div class="${classes.filter(Boolean).join(" ")}" data-click="zone" data-id="${id}">
    <div class="zone-name">${zoneHold(id)}${nation}<strong>${esc(ZONE_LABELS[id])}</strong>${counts}${smoke}</div>
    <div class="zone-body">${uk.map((s) => soldierButton(s)).join("")}${covers.map(coverButton).join("")}${gear.map(unitButton).join("")}${de.map((s) => soldierButton(s)).join("")}</div>
    <div class="zone-ctrl">${ctrl}</div>
  </div>`;
}

function actionFlag(owner, id) {
  const player = state.players[owner];
  if (!player) return { className: "", mark: "" };
  const attacked = (player.attackedIds || []).includes(id) || (player.firedEquip || []).includes(id);
  const moved = (player.movedIds || []).includes(id) || (player.movedEquip || []).includes(id) || (player.movedTanks || []).includes(id);
  if (attacked) return { className: "spent", mark: `<i class="mark-flag">Spent</i>` };
  if (moved) return { className: "moved", mark: `<i class="mark-flag moved">Moved</i>` };
  return { className: "", mark: "" };
}

function allocMark(id) {
  const pending = state.pending;
  if (pending?.type !== "allocate-hits") return { on: false, count: 0 };
  const count = (ui.allocStack || []).filter((hit) => hit === id).length;
  return { on: pending.options.some((option) => option.id === id), count };
}

function soldierButton(soldier, inCover = false) {
  const selected = ui.soldiers.includes(soldier.id) ? "selected" : "";
  const targeted = ui.enemy === soldier.id ? "targeted" : "";
  const flag = actionFlag(soldier.owner, soldier.id);
  const mark = allocMark(soldier.id);
  const title = `${labelSide(soldier.owner)} soldier, ${inCover ? "in this cover" : "exposed"}${flag.className ? `, ${flag.className}` : ""}${mark.count ? `, ${mark.count} hit${mark.count === 1 ? "" : "s"} assigned` : ""}`;
  const flash = hitFlash?.ids?.has(soldier.id) ? "hit-flash" : "";
  return `<button type="button" class="token ${soldier.owner} ${selected} ${targeted} ${flag.className} ${mark.on ? "alloc" : ""} ${flash} ${inCover ? "nested" : ""}" data-click="soldier" data-id="${soldier.id}" aria-label="${esc(title)}" title="${esc(title)}">${helmet(soldier.owner)}${flag.mark}</button>`;
}

function coverFightPreview(cover) {
  const pending = state.pending;
  if (pending?.type !== "allocate-hits") return null;
  const target = pending.target;
  if (!target?.coverId || target.coverId !== cover.id) return null;
  if (target.kind !== "cover" && target.kind !== "cover-empty") return null;
  const stacking = (pending.options || []).length > 1;
  const chosen = stacking ? (ui.allocStack || []).length : pending.hits;
  const occ = target.kind === "cover" ? soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id }).length : 0;
  return coverCountdown(cover.defense, chosen, occ);
}

function allocationCoverLine() {
  const pending = state.pending;
  if (pending?.type !== "allocate-hits" || !pending.target?.coverId) return "";
  const cover = state.covers.find((token) => token.id === pending.target.coverId);
  if (!cover) return "";
  const preview = coverFightPreview(cover);
  if (!preview) return "";
  const occ = pending.target.kind === "cover" ? soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id }).length : 0;
  return coverCountdownText(cover.defense, preview.hits, occ);
}

function coverButton(cover) {
  const selected = ui.cover === cover.id ? "selected" : "";
  const occ = soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id });
  const preview = coverFightPreview(cover);
  let value = cover.revealed ? String(cover.defense) : "?";
  let live = "";
  if (preview) {
    value = preview.destroyed ? "0" : String(preview.remaining);
    if (preview.nextDestroys) live = "next-break";
    else if (preview.nextEliminates) live = "next-loss";
    else if (preview.destroyed) live = "broken";
  }
  const mark = allocMark(cover.id);
  const phase = flipPhase.get(cover.id) || "";
  if (phase === "out") {
    value = "?";
    live = "";
  }
  const opened = phase === "out" ? false : Boolean(cover.revealed || preview);
  const title = preview && phase !== "out"
    ? coverCountdownText(cover.defense, preview.hits, pendingOccupants(cover, preview))
    : `Cover ${cover.revealed ? "defense " + cover.defense : "unrevealed"}, ${occ.length} inside${mark.count ? `, ${mark.count} hits assigned` : ""}`;
  const count = occ.length
    ? `<button type="button" class="cover-count" data-click="cover" data-id="${cover.id}" aria-label="${occ.length} in this cover">${occ.length}</button>`
    : "";
  const flash = hitFlash?.ids?.has(cover.id) ? "hit-flash" : "";
  const spin = phase ? `cover-flip ${phase}` : "cover-flip";
  return `<div class="dugout ${occ.length ? "held" : ""}">
    <button type="button" class="cover ${opened ? "open" : ""} ${live} ${selected} ${mark.on ? "alloc" : ""} ${flash}" data-click="cover" data-id="${cover.id}" aria-label="${esc(title)}" title="${esc(title)}"><span class="${spin}"><img src="assets/cover-token.jpg" alt="" draggable="false"><b>${esc(value)}</b></span></button>
    <div class="occupants">${occ.map((s) => soldierButton(s, true)).join("")}</div>
    ${count}
  </div>`;
}

function pendingOccupants(cover, preview) {
  if (!preview) return 0;
  const pending = state.pending;
  if (pending?.target?.kind !== "cover") return 0;
  return soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id }).length;
}

function unitSrc(type, side) {
  if (type === "tank") return side === "de" ? "assets/tank-german.png" : "assets/tank-british.png";
  if (type === "mortar") return "assets/mortar.png";
  return "assets/machine-gun.png";
}

function unitButton(unit) {
  const selected = ui.unit === unit.id ? "selected" : "";
  const targeted = ui.targetUnit === unit.id ? "targeted" : "";
  const flag = actionFlag(unit.owner, unit.id);
  const damaged = unit.damage ? "damaged" : "";
  const dmg = unit.damage ? `<small class="dmg">${unit.damage}</small>` : "";
  const name = capType(unit.type);
  const mark = allocMark(unit.id);
  const title = `${labelSide(unit.owner)} ${name}${unit.damage ? `, ${unit.damage} damage` : ""}${flag.className ? `, ${flag.className}` : ""}${mark.count ? `, ${mark.count} hits assigned` : ""}`;
  return `<button type="button" class="unit ${unit.type} ${unit.owner} ${selected} ${targeted} ${flag.className} ${damaged} ${mark.on ? "alloc" : ""}" data-click="unit" data-id="${unit.id}" aria-label="${esc(title)}" title="${esc(title)}"><img src="${unitSrc(unit.type, unit.owner)}" alt="" draggable="false">${dmg}${flag.mark}</button>`;
}

function chargeSelection(me) {
  const picked = ui.soldiers
    .map((id) => state.soldiers.find((s) => s.id === id && s.owner === me))
    .filter(Boolean);
  if (!picked.length || picked.some((s) => s.loc !== picked[0].loc)) return null;
  return picked.slice(0, 3);
}

function legalZones() {
  const me = viewer();
  if (!myTurn()) return [];
  if (state.actionStep === "event") {
    const card = selectedCard();
    const picked = chargeSelection(me);
    if (!picked) return [];
    if (card?.title === "Bayonet Charge") return bayonetDestinations(state, me, picked[0].loc);
    if (card?.title === "Charge" && isBattlefield(picked[0].loc)) {
      const dest = stepZone(me, picked[0].loc, "forward");
      return dest && isBattlefield(dest) ? [dest] : [];
    }
    return [];
  }
  if (state.actionStep !== "move") return [];
  const soldier = state.soldiers.find((s) => s.id === ui.soldiers[0] && s.owner === me);
  const unit = state.equipment.find((u) => u.id === ui.unit && u.owner === me && u.type !== "tank");
  const piece = soldier || unit;
  if (!piece) return [];
  return ["forward", "back"].map((dir) => stepZone(me, piece.loc, dir)).filter((zone) => zone && isBattlefield(zone));
}

function spentDieIndexes(side) {
  const player = state.players[side];
  const used = new Set();
  if (!player?.committed) return used;
  const left = { ...(player.spent || {}) };
  for (const rawIndex of player.spentDice || []) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || used.has(index)) continue;
    used.add(index);
    const face = player.dice[index];
    const effective = face === "wild" ? player.wildAs : face;
    if (effective && (left[effective] || 0) > 0) left[effective] -= 1;
  }
  const order = [];
  player.dice.forEach((face, index) => {
    if (!face || used.has(index)) return;
    const effective = face === "wild" ? player.wildAs : face;
    if (!effective || effective === "wild") return;
    order.push({ index, effective, wild: face === "wild" });
  });
  order.sort((a, b) => Number(a.wild) - Number(b.wild) || a.index - b.index);
  for (const die of order) {
    if ((left[die.effective] || 0) > 0) {
      used.add(die.index);
      left[die.effective] -= 1;
    }
  }
  return used;
}

function bayonetChoice(side, index) {
  const player = state.players[side];
  if (!player || spentDieIndexes(side).has(index)) return false;
  const face = player.dice[index];
  if (!face) return false;
  const effective = face === "wild" ? player.wildAs : face;
  return effective === "bayonet";
}

function selectedBayonetIndexes(side) {
  return [...new Set(ui.dice.map((index) => Number(index)))]
    .filter((index) => bayonetChoice(side, index))
    .sort((a, b) => a - b);
}

function dieButton(side, face, index) {
  const player = state.players[side];
  const mine = side === viewer() && myTurn();
  const reroll = mine && state.phase === "reroll";
  const go = mine && state.pending?.type === "generals-order" && ui.order === "yes";
  const sabotage = mine && state.actionStep === "event" && selectedCard()?.title === "Sabotage" && side !== viewer();
  const spent = spentDieIndexes(side).has(index);
  const deployPick = mine && state.phase === "action" && state.actionStep === "deploy" && bayonetChoice(side, index);
  const picked = deployPick && ui.dice.map(Number).includes(index);
  const classes = ["die", side, face ? "" : "drop"];
  if (spent) classes.push("spent");
  if (deployPick) classes.push("choice");
  if (picked) classes.push("picked");
  if (reroll && player.kept[index] === false) classes.push("drop");
  if (go && ui.dice.includes(index)) classes.push("go");
  if (sabotage && ui.dieIndex === index) classes.push("go");
  const display = face === "wild" && player.committed && player.wildAs ? player.wildAs : face;
  const key = `action:${side}:${index}`;
  const spinning = Boolean(display && tumble?.keys.has(key));
  const shownFace = spinning ? flicker(key, display, ACTION_POOL) : display;
  const shown = FACE_LABEL[shownFace] || "Spent";
  if (spinning) classes.push("tumbling");
  const enabled = Boolean(face) && (reroll || go || sabotage || deployPick);
  const title = spent ? "Used" : picked ? "Selected to spend" : deployPick ? "Select this bayonet" : display === "shovel" ? "Dig one soldier into cover" : "";
  const motion = spinning ? tumbleAttrs(key, "action", display, ACTION_POOL) : "";
  return `<button type="button" class="${classes.filter(Boolean).join(" ")}" data-click="die" data-side="${side}" data-index="${index}" ${title ? `title="${title}"` : ""} ${picked ? `aria-pressed="true"` : ""} ${enabled ? "" : "disabled"}${motion}>${shownFace ? faceSvg(shownFace) : ""}<span>${esc(shown)}</span></button>`;
}

function selectedCard() {
  const me = viewer();
  if (!me) return null;
  return state.players[me].eventHand.find((c) => c.inst === ui.card) || null;
}

function poolText(side) {
  if (!state.players[side].committed) return "";
  const bits = FACES.filter((f) => f !== "wild").map((f) => `${FACE_LABEL[f]} ${Math.max(0, remaining(state, side, f))}`);
  const stolen = state.effects.stolenDie;
  if (stolen?.owner === side) bits.push(`stolen ${stolen.face}`);
  return bits.join(" · ");
}

function promptText() {
  const me = viewer();
  const name = labelSide(me);
  if (state.pending?.type === "spotter") {
    return "Your spotter rolled the mortar die twice. Choose a zone. The mortar then places 1 hit on an eligible target there. It cannot strike the Objective.";
  }
  if (state.pending?.type === "mortar-target") {
    return `The mortar die struck ${ZONE_LABELS[state.pending.zone]}. Place its 1 hit before cover defense is revealed.`;
  }
  if (state.pending?.type === "allocate-hits") {
    const pending = state.pending;
    const stacking = pending.options.length > 1;
    const remain = stacking ? pending.hits - (ui.allocStack || []).length : pending.hits;
    const place = ZONE_LABELS[pending.zone] || "the target";
    const coverLine = allocationCoverLine();
    if (!stacking) {
      const only = pending.options[0];
      const base = `Hits remaining: ${remain}. ${only ? only.label : place} is the only legal target. Confirm to assign ${pending.hits === 1 ? "the hit" : "every hit"}.`;
      return coverLine ? `${coverLine} ${base}` : base;
    }
    const base = `Hits remaining: ${remain}. The attack on ${place} rolled ${pending.hits} hit${pending.hits === 1 ? "" : "s"}. Click a target to assign a hit. Click that target again to take the hit off.`;
    return coverLine ? `${coverLine} ${base}` : base;
  }
  if (state.pending?.type === "pick-mission") {
    return "More than one mission is ready. Complete one this round. The others stay in hand and can score in a later round.";
  }
  if (state.pending?.type === "gambit" && state.pending.stage === "keep") {
    return "Mission Gambit: keep one of these two Missions. The other goes to the bottom of the deck. Your five dice stay available.";
  }
  if (state.pending?.type === "gambit") {
    return "You may discard one Mission you already hold and draw a replacement. Then the hand is trimmed to 5.";
  }
  if (state.pending?.type === "generals-order") {
    if (ui.order !== "yes") {
      return `${name} holds General's Order. Play it before initiative is fixed? It can reroll up to 2 of these dice, or change 1 die to a face already showing. Initiative is then read from this roll, ignoring wilds. Roll 2 and Roll 3 still come afterward and can reroll any number of dice.`;
    }
    return "Select up to 2 dice to reroll, or select 1 die and change it to a face already showing.";
  }
  if (state.phase === "reroll") {
    const side = state.active || me;
    const name = labelSide(side);
    const used = state.players[side].rollsUsed;
    const left = Math.max(0, 3 - used);
    const fixed = state.initiative?.tieRolls ? "the deciding roll" : "Roll 1";
    const order = side === state.player1
      ? `${name} won initiative, so ${name} shapes these dice second and acts first.`
      : `${name} lost initiative, so ${name} shapes these dice first and acts second.`;
    if (left > 0) {
      return `Reroll ${name}'s dice. ${order} Initiative was fixed on ${fixed} and will not change. Roll ${used + 1}: click any of ${name}'s dice to reroll them. Any number is allowed, including dice kept earlier. ${left} reroll${left === 1 ? "" : "s"} left.`;
    }
    return `${name}'s dice are ready to commit. Initiative was fixed on ${fixed} and will not change. ${name} has no rerolls left.`;
  }
  const hints = {
    shock: "Five matching dice. Mustard Gas spends all five. Hits eliminate exposed enemy soldiers in their Zones 1, 2, and 3. Mission Gambit draws missions and keeps the five dice for normal actions.",
    tank: "Each tank on the field may advance one or two zones. Moving one does not spend the others. A tank stops if it meets an enemy tank, and neither tank can leave while both remain. Driving into the enemy trench scores 3 VP and returns the tank to supply.",
    event: "Choose an Event, then the soldiers, zone, or weapon it asks for. Each Event costs one Whistle. General's Order cannot be played now.",
    deploy: "Select the bayonet dice to spend. One deploys a soldier from supply into a zone you control, once this round, or repairs one damage. Two deploys a mortar into Zone 1 if you control it and a mortar remains in supply. Three deploys a machine gun onto a zone you control on your side if a machine gun remains in supply. Four deploys a tank into Zone 1 if a tank remains in supply.",
    move: "Select one soldier or support weapon, then advance or fall back a single zone. A Boot also advances one of your trench soldiers into Zone 1. A soldier in cover must spend a Shovel to leave before the Boot.",
    cover: "A Shovel digs one exposed soldier into cover in the same zone. Select the soldier. Cover holds three of your soldiers and hides its defense until fired on, scouted, or reconnoitered.",
    attack: "Soldiers in cover can fire and can be targeted. Select your soldiers or a weapon, then a target. Soldiers and a machine gun that can each reach the same target fire together and add their dice, while mortars and tanks shoot on their own. Each attack die is 3 Hit and 3 Miss. Soldiers roll 1 and shoot one zone. Machine guns roll 3, or 4 at the objective, out to two zones, and cannot shoot tanks. Tanks roll 3 at an adjacent zone or overrun cover beneath them. Each unit attacks once. After soldiers, a machine gun, or a tank roll hits, you assign those hits to the legal targets.",
  };
  if (state.phase === "action" && state.pending?.type === "action") {
    const empty = emptyStepView();
    if (empty?.reason) return empty.reason;
  }
  if (state.phase === "action" && state.actionStep === "deploy") {
    const bayonets = remaining(state, me, "bayonet");
    const selected = selectedBayonetIndexes(me).length;
    const picked = selected ? ` ${selected} selected.` : "";
    const mortarsLeft = mortarsInSupply(state, me);
    const gunsLeft = machineGunsInSupply(state, me);
    const tanksLeft = tanksInSupply(state, me);
    return `${hints.deploy} You have ${bayonets} bayonet${bayonets === 1 ? "" : "s"}.${picked} Mortars left in supply: ${mortarsLeft}. Machine guns left in supply: ${gunsLeft}. Tanks left in supply: ${tanksLeft}.`;
  }
  if (state.phase === "action") return hints[state.actionStep] || "";
  if (state.phase === "regroup") {
    const p = state.players[me];
    const left = Math.max(0, 2 - (p.regroupExchanged || 0));
    if (!p.regroupDrew) return `Draw one Event from the display or the deck. You may also exchange up to ${left} unused die${left === 1 ? "" : " faces"} for Soldiers in the Trench.`;
    return left ? `${left} die exchange${left === 1 ? "" : "s"} still available. End regroup when you are finished.` : "End regroup to finish the round.";
  }
  return "";
}

function phaseTitle() {
  const me = viewer();
  if (state.phase === "end") return "Battle over";
  if (state.pending?.type === "pick-mission") return `${labelSide(me)} · Choose a mission`;
  if (state.pending?.type === "generals-order") return `${labelSide(me)} · General's Order`;
  if (state.pending?.type === "spotter") return `${labelSide(me)} · Spotter`;
  if (state.pending?.type === "gambit") return `${labelSide(me)} · Mission Gambit`;
  if (state.pending?.type === "mortar-target") return `${labelSide(me)} · Mortar`;
  if (state.phase === "reroll") return `Reroll ${labelSide(state.active || me)}'s dice`;
  if (state.phase === "regroup") return `${labelSide(me)} · Regroup`;
  const step = STEPS.find(([id]) => id === state.actionStep);
  return `${labelSide(me)} · ${step ? step[1] : "Action"}`;
}

function allocTarget(id) {
  return state.pending?.type === "allocate-hits" && state.pending.options.some((option) => option.id === id);
}

function addAllocHit(id) {
  const pending = state.pending;
  if (!allocTarget(id)) return;
  const stack = ui.allocStack || [];
  if (stack.length >= pending.hits) return;
  ui.allocStack = [...stack, id];
  armHitFlash({ ids: flashIdsFor(id), cover: Boolean(pending.target?.coverId) });
  render();
}

function clickAllocTarget(id) {
  if (!allocTarget(id)) return;
  const stack = ui.allocStack || [];
  const count = stack.filter((hit) => hit === id).length;
  if (count > 0) {
    const next = stack.slice();
    next.splice(next.lastIndexOf(id), 1);
    ui.allocStack = next;
  } else if (stack.length < state.pending.hits) {
    ui.allocStack = [...stack, id];
    armHitFlash({ ids: flashIdsFor(id), cover: Boolean(state.pending?.target?.coverId) });
  }
  render();
}

function hitAllocationButtons() {
  const pending = state.pending;
  const options = pending.options || [];
  const stack = ui.allocStack || [];
  const stacking = options.length > 1;
  const remain = stacking ? pending.hits - stack.length : pending.hits;
  const coverLine = allocationCoverLine();
  attackHint = coverLine ? `${coverLine} Hits remaining: ${remain}.` : `Hits remaining: ${remain}.`;
  if (!stacking) {
    const only = options[0];
    return [{
      label: only ? `Confirm ${pending.hits} hit${pending.hits === 1 ? "" : "s"} on ${only.label}` : "Confirm hits",
      primary: true,
      run: () => commit({ type: "ALLOCATE_HITS", picks: Array(pending.hits).fill(only.id) }),
    }];
  }
  const list = [];
  for (const option of options) {
    const count = stack.filter((id) => id === option.id).length;
    list.push({
      label: count ? `${option.label} · ${count} hit${count === 1 ? "" : "s"}` : option.label,
      run: () => clickAllocTarget(option.id),
    });
    if (count > 0 && remain > 0) {
      list.push({
        label: `Another hit on ${option.label}`,
        run: () => addAllocHit(option.id),
      });
    }
  }
  if (allocationReady(pending, stack)) {
    list.push({
      label: remain ? `Confirm hits · ${remain} left over` : "Confirm hits",
      primary: true,
      run: () => commit({ type: "ALLOCATE_HITS", picks: stack.slice() }),
    });
  }
  return list;
}

function actionList() {
  attackHint = "";
  deployNote = "";
  if (!myTurn()) return [];
  const me = viewer();
  if (state.pending?.type === "spotter") {
    return state.pending.options.map((face) => ({
      label: mortarName(me, face),
      primary: true,
      run: () => commit({ type: "PICK_SPOTTER", face }),
    }));
  }
  if (state.pending?.type === "mortar-target") {
    return state.pending.options.map((option) => ({
      label: `1 hit on ${option.label}`,
      primary: option.kind === "exposed",
      run: () => commit({ type: "ALLOCATE_MORTAR", targetId: option.id }),
    }));
  }
  if (state.pending?.type === "allocate-hits") return hitAllocationButtons();
  if (state.pending?.type === "pick-mission") {
    const pending = state.pending;
    const hand = state.players[pending.side].missionHand;
    return pending.insts.map((inst) => {
      const card = hand.find((mission) => mission.inst === inst);
      if (!card) return null;
      return {
        label: `Complete ${card.title} (+${card.vp} VP)`,
        hint: cardBlurb(card),
        primary: true,
        run: () => commit({ type: "PICK_MISSION", inst: card.inst }),
      };
    }).filter(Boolean);
  }
  if (state.pending?.type === "gambit" && state.pending.stage === "keep") {
    return state.pending.cards.map((card) => ({
      label: `Keep ${card.title} (${card.vp} VP)`,
      hint: cardBlurb(card),
      primary: true,
      run: () => commit({ type: "PICK_GAMBIT", inst: card.inst }),
    }));
  }
  if (state.pending?.type === "gambit") {
    const list = state.players[me].missionHand.map((card) => ({
      label: `Swap ${card.title}`,
      hint: cardBlurb(card),
      run: () => commit({ type: "FINISH_GAMBIT", discard: card.inst }),
    }));
    list.push({ label: "Keep these missions", primary: true, run: () => commit({ type: "FINISH_GAMBIT" }) });
    return list;
  }
  if (state.pending?.type === "generals-order") return generalsButtons(me);
  if (state.phase === "reroll") return rerollButtons(me);
  if (state.phase === "regroup") return regroupButtons(me);
  if (state.phase !== "action") return [];
  if (state.actionStep === "shock") {
    return [
      { label: "Mustard Gas", primary: true, run: () => commit({ type: "SHOCK", option: "gas" }) },
      { label: "Mission Gambit", run: () => commit({ type: "SHOCK", option: "gambit" }) },
      { label: "Decline the Shock", run: () => askLeave({ type: "SKIP_SHOCK" }) },
    ];
  }
  if (state.actionStep === "tank") return tankButtons(me);
  if (state.actionStep === "event") return eventButtons(me);
  if (state.actionStep === "deploy") return deployButtons(me);
  if (state.actionStep === "move") return moveButtons(me);
  if (state.actionStep === "cover") return coverButtons(me);
  if (state.actionStep === "attack") return attackButtons(me);
  return [];
}

function generalsButtons(me) {
  if (ui.order !== "yes") {
    return [
      { label: "Yes, use General's Order", primary: true, run: () => { ui.order = "yes"; ui.dice = []; render(); } },
      { label: "No, keep the roll", run: () => commit({ type: "SKIP_GENERALS_ORDER" }) },
    ];
  }
  const faces = [...new Set(state.players[me].dice.filter((f) => f && f !== "wild"))];
  const list = [
    {
      label: ui.dice.length ? `Reroll ${ui.dice.length} selected` : "Reroll selected dice",
      primary: true,
      run: () => commit({ type: "GENERALS_ORDER", side: me, mode: "reroll", indexes: ui.dice.slice(0, 2) }),
    },
  ];
  if (ui.dice.length) {
    for (const face of faces) {
      list.push({
        label: `Change die ${ui.dice[0] + 1} to ${FACE_LABEL[face]}`,
        run: () => commit({ type: "GENERALS_ORDER", side: me, mode: "change", index: ui.dice[0], to: face }),
      });
    }
  }
  list.push({ label: "Keep the roll", run: () => commit({ type: "SKIP_GENERALS_ORDER" }) });
  return list;
}

function rerollButtons(me) {
  const player = state.players[me];
  const list = [];
  const choices = ["boot", "whistle", "shovel", "bayonet"].filter((f) => naturalFaces(player.dice).includes(f));
  const wildAs = choices.includes(ui.wildAs) ? ui.wildAs : null;
  if (player.rollsUsed < 3) {
    const marked = player.kept.filter((k) => !k).length;
    list.push({
      label: marked ? `Reroll selected (${marked})` : "Reroll selected",
      primary: marked > 0,
      run: () => commit({ type: "REROLL" }),
    });
    list.push({
      label: "Keep the roll",
      primary: marked === 0,
      run: () => commit({ type: "COMMIT", wildAs }),
    });
  }
  if (hasWildFace(player.dice)) {
    list.push({
      label: wildAs ? `Commit · Wilds as ${FACE_LABEL[wildAs]}` : "Commit dice",
      primary: player.rollsUsed >= 3,
      run: () => commit({ type: "COMMIT", wildAs }),
    });
  }
  return list;
}

function regroupButtons(me) {
  const p = state.players[me];
  const list = [];
  const trench = state.soldiers.filter((s) => s.owner === me && s.loc === ownTrench(me)).length;
  const available = state.soldiers.some((s) => s.owner === me && s.loc === "available");
  if ((p.regroupExchanged || 0) < 2 && unusedDice(state, me) > 0 && trench < 5 && available) {
    list.push({
      label: `Exchange 1 die for a Soldier (${p.regroupExchanged || 0}/2)`,
      primary: true,
      run: () => commit({ type: "REGROUP_EXCHANGE" }),
    });
  }
  if (!p.regroupDrew && p.eventHand.length < 7) {
    for (const card of state.eventDisplay) {
      list.push({
        label: `Draw ${card.title}`,
        hint: cardBlurb(card),
        primary: !list.length,
        run: () => commit({ type: "REGROUP_DRAW", side: me, source: card.inst }),
      });
    }
    if (state.eventDeck.length) list.push({ label: "Blind draw", run: () => commit({ type: "REGROUP_DRAW", side: me, source: "deck" }) });
  }
  list.push({ label: "End regroup", run: () => commit({ type: "SKIP_REGROUP" }) });
  return list;
}

function tanksReady(me) {
  return tanksReadyToMove(state, me);
}

function tankButtons(me) {
  const tanks = tanksReady(me);
  const list = [];
  const many = tanks.length > 1;
  for (const tank of tanks) {
    const where = ZONE_LABELS[tank.loc];
    const sharing = tanks.filter((other) => other.loc === tank.loc);
    const which = !many
      ? ""
      : sharing.length > 1
        ? ` (${where}, tank ${sharing.findIndex((other) => other.id === tank.id) + 1})`
        : ` (${where})`;
    list.push({
      label: `Advance 1 zone${which}`,
      primary: list.length === 0,
      run: () => commit({ type: "MOVE_TANK", unitId: tank.id, steps: 1 }),
    });
    list.push({
      label: `Advance 2 zones${which}`,
      run: () => commit({ type: "MOVE_TANK", unitId: tank.id, steps: 2 }),
    });
  }
  list.push({ label: "Hold the tank", run: () => askLeave({ type: "SKIP_TANK" }) });
  return list;
}

function grantedMoveButtons(me, card) {
  const picked = chargeSelection(me);
  if (!picked) return [];
  if (card.title === "Bayonet Charge") {
    return bayonetDestinations(state, me, picked[0].loc).map((dest, index) => ({
      label: `Charge into ${ZONE_LABELS[dest]}`,
      hint: cardBlurb(card),
      primary: index === 0,
      run: () => commit({
        type: "PLAY_EVENT",
        cardInst: card.inst,
        params: { ...eventParams(), soldierIds: picked.map((s) => s.id), zone: dest },
      }),
    }));
  }
  if (card.title !== "Charge" || !isBattlefield(picked[0].loc)) return [];
  const dest = stepZone(me, picked[0].loc, "forward");
  if (!dest || !isBattlefield(dest)) return [];
  return [{
    label: `Move into ${ZONE_LABELS[dest]}`,
    hint: cardBlurb(card),
    primary: true,
    run: () => commit({
      type: "PLAY_EVENT",
      cardInst: card.inst,
      params: { ...eventParams(), soldierIds: picked.map((s) => s.id), zone: dest, dir: "forward" },
    }),
  }];
}

function eventButtons(me) {
  const card = selectedCard();
  const list = [];
  if (card && card.title !== "General's Order") {
    const opened = state.players[me].eventsAtStep;
    if (!opened || opened.includes(card.inst)) {
      const moves = grantedMoveButtons(me, card);
      if (moves.length) list.push(...moves);
      else list.push({ label: `Play ${card.title}`, hint: cardBlurb(card), primary: true, run: () => commit({ type: "PLAY_EVENT", cardInst: card.inst, params: eventParams() }) });
    }
  }
  list.push({ label: "Done with events", run: () => askLeave({ type: "SKIP_EVENT" }) });
  return list;
}

function eventParams() {
  const card = selectedCard();
  const params = {
    soldierIds: ui.soldiers,
    zone: ui.zone,
    coverId: ui.cover,
    unitId: ui.unit,
    soldierId: ui.enemy,
    dieIndex: ui.dieIndex,
    dir: ui.dir,
    supportType: ui.supportType,
    targetKind: ui.targetKind || "exposed",
  };
  if (card && (card.title === "Heavy Barrage" || card.title === "Bombing Run")) {
    if (ui.targetKind === "cover") params.targetKind = "cover";
    else if (ui.targetKind === "unit" && ui.targetUnit) {
      const unit = state.equipment.find((u) => u.id === ui.targetUnit);
      params.targetKind = unit?.type || "mg";
      params.unitId = ui.targetUnit;
      params.zone = unit?.loc || ui.zone;
    } else params.targetKind = "exposed";
  }
  if (card?.title === "Charge") params.dir = "forward";
  if (card?.title === "Bayonet Charge") {
    const me = viewer();
    const picked = (params.soldierIds || [])
      .map((id) => state.soldiers.find((s) => s.id === id && s.owner === me))
      .filter(Boolean)
      .slice(0, 3);
    const origin = picked[0]?.loc;
    if (origin && picked.every((s) => s.loc === origin)) {
      params.soldierIds = picked.map((s) => s.id);
      const options = bayonetDestinations(state, me, origin);
      if (options.length && !options.includes(params.zone)) {
        const forward = stepZone(me, origin, "forward");
        params.zone = options.includes(forward) ? forward : options[0];
      }
    }
  }
  return params;
}

function deployButtons(me) {
  const indexes = selectedBayonetIndexes(me);
  const n = indexes.length;
  const list = [];
  deployNote = "";
  if (n === 1) {
    const soldierReady = !state.players[me].soldierDeployed && state.soldiers.some((s) => s.owner === me && s.loc === "available");
    const zones = soldierReady ? [...sideZones(me), "obj", ...enemySideZones(me)].filter((zone) => controllerOf(state, zone) === me) : [];
    for (const zone of zones) {
      list.push({
        label: `Deploy a Soldier in ${ZONE_LABELS[zone]} (1)`,
        primary: list.length === 0,
        run: () => commit({ type: "DEPLOY", kind: "soldier", zone, indexes }),
      });
    }
    for (const unit of state.equipment) {
      if (unit.owner === me && isBattlefield(unit.loc) && unit.damage >= 1) {
        list.push({
          label: `Repair ${capType(unit.type)} (${unit.damage})`,
          primary: list.length === 0,
          run: () => commit({ type: "REPAIR", unitId: unit.id, indexes }),
        });
      }
    }
    if (!list.length) {
      if (state.players[me].soldierDeployed) deployNote = "You already deployed a soldier this round.";
      else if (!state.soldiers.some((s) => s.owner === me && s.loc === "available")) deployNote = "No soldier in supply.";
      else deployNote = "No battlefield zone you control.";
    }
  } else if (n === 2) {
    const zone = ownZone1(me);
    if (canDeployMortar(state, me)) {
      list.push({
        label: "Deploy mortar into Zone 1",
        primary: true,
        run: () => commit({ type: "DEPLOY", kind: "mortar", zone, indexes }),
      });
    } else if (mortarsInSupply(state, me) <= 0) {
      deployNote = "The mortars are all deployed.";
    } else {
      deployNote = "You do not control Zone 1.";
    }
  } else if (n === 3) {
    const zones = machineGunsInSupply(state, me) > 0 ? sideZones(me).filter((zone) => controllerOf(state, zone) === me) : [];
    for (const zone of zones) {
      list.push({
        label: `Deploy machine gun in ${ZONE_LABELS[zone]} (3)`,
        primary: list.length === 0,
        run: () => commit({ type: "DEPLOY", kind: "mg", zone, indexes }),
      });
    }
    if (!list.length) {
      deployNote = machineGunsInSupply(state, me) <= 0 ? "The machine guns are all deployed." : "No zone you control on your side.";
    }
  } else if (n === 4) {
    if (tanksInSupply(state, me) > 0) {
      list.push({
        label: "Deploy tank into Zone 1 (4)",
        primary: true,
        run: () => commit({ type: "DEPLOY", kind: "tank", indexes }),
      });
    } else {
      deployNote = "The tanks are all deployed.";
    }
  } else if (n > 4) {
    deployNote = "No deployment costs that many bayonets.";
  }
  list.push({ label: "Done deploying", primary: list.length === 0, run: () => askLeave({ type: "SKIP_DEPLOY" }) });
  return list;
}

function moveButtons(me) {
  const list = [];
  const soldier = state.soldiers.find((s) => s.id === ui.soldiers[0] && s.owner === me);
  if (soldier && soldier.loc === ownTrench(me) && !soldier.coverId && remaining(state, me, "boot") >= 1) {
    const dest = stepZone(me, soldier.loc, "forward");
    if (dest === ownZone1(me)) {
      list.push({
        label: "Advance to Zone 1 (1 boot)",
        primary: true,
        run: () => commit({ type: "MOVE_UNIT", kind: "soldier", unitId: soldier.id, dir: "forward" }),
      });
    }
  } else if (soldier && isBattlefield(soldier.loc)) {
    for (const dir of ["forward", "back"]) {
      const dest = stepZone(me, soldier.loc, dir);
      if (!dest || !isBattlefield(dest)) continue;
      const cost = soldier.coverId ? "1 shovel, then 1 boot" : "1 boot";
      list.push({
        label: `${dir === "forward" ? "Advance" : "Fall back"} to ${ZONE_LABELS[dest]} (${cost})`,
        primary: dir === "forward",
        run: () => commit(soldier.coverId
          ? { type: "LEAVE_COVER_THEN_MOVE", unitId: soldier.id, dir, kind: "soldier" }
          : { type: "MOVE_UNIT", kind: "soldier", unitId: soldier.id, dir }),
      });
    }
  }
  const unit = state.equipment.find((u) => u.id === ui.unit && u.owner === me && u.type !== "tank");
  if (unit && isBattlefield(unit.loc)) {
    for (const dir of ["forward", "back"]) {
      const dest = stepZone(me, unit.loc, dir);
      if (!dest || !isBattlefield(dest)) continue;
      list.push({
        label: `Move ${capType(unit.type)} to ${ZONE_LABELS[dest]}`,
        run: () => commit({ type: "MOVE_UNIT", kind: "weapon", unitId: unit.id, dir }),
      });
    }
  }
  list.push({ label: "Done moving", primary: list.length === 0, run: () => askLeave({ type: "SKIP_MOVE" }) });
  return list;
}

function coverFits(me, soldier, cover) {
  if (!soldier || soldier.coverId || !cover || cover.destroyed) return false;
  if (!isBattlefield(soldier.loc) || soldier.loc !== cover.loc) return false;
  const occ = soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id });
  return occ.length < 3 && !occ.some((o) => o.owner !== me);
}

function coverButtons(me) {
  const list = [];
  const soldier = state.soldiers.find((s) => s.id === ui.soldiers[0] && s.owner === me);
  const cover = state.covers.find((c) => c.id === ui.cover && !c.destroyed);
  const inZone = soldier ? state.covers.filter((c) => coverFits(me, soldier, c)) : [];
  const targets = cover && coverFits(me, soldier, cover) ? [cover] : inZone;
  targets.forEach((token, i) => {
    const occ = soldiersIn(state, token.loc, { matchCover: true, coverId: token.id }).length;
    const label = targets.length > 1 ? `Dig into cover ${token.revealed ? token.defense : "?"} (${occ}/3)` : "Dig in";
    list.push({
      label,
      primary: i === 0,
      run: () => commit({ type: "SHOVEL", mode: "dig", soldierId: soldier.id, coverId: token.id }),
    });
  });
  if (soldier?.coverId) list.push({ label: "Leave cover", run: () => commit({ type: "SHOVEL", mode: "leave", soldierId: soldier.id }) });
  if (ui.zone && controllerOf(state, ui.zone) === me && state.coverSupply.length) {
    list.push({ label: `Prepare cover in ${ZONE_LABELS[ui.zone]}`, run: () => commit({ type: "SHOVEL", mode: "prepare", zone: ui.zone }) });
  }
  if (cover && ui.zone && ui.zone !== cover.loc && zoneDistance(cover.loc, ui.zone) === 1 && controllerOf(state, ui.zone) === me) {
    list.push({ label: `Relocate cover to ${ZONE_LABELS[ui.zone]}`, run: () => commit({ type: "SHOVEL", mode: "relocate", coverId: cover.id, zone: ui.zone }) });
  }
  list.push({ label: "Done with cover", primary: list.length === 0, run: () => askLeave({ type: "SKIP_COVER" }) });
  return list;
}

function machineGunLabel(shot) {
  const place = ZONE_LABELS[shot.zone];
  if (shot.kind === "exposed") return `Machine gun fires at exposed in ${place}`;
  if (shot.kind === "mg" || shot.kind === "mortar") return `Machine gun fires at the ${capType(shot.kind)} in ${place}`;
  const covers = coversIn(state, shot.zone);
  const cover = covers.find((c) => c.id === shot.coverId);
  const which = covers.length > 1 && cover
    ? ` ${covers.indexOf(cover) + 1}${cover.revealed ? ` (defense ${cover.defense})` : ""}`
    : "";
  if (shot.kind === "cover-empty") return `Machine gun tries to destroy cover${which} in ${place}`;
  return `Machine gun fires at soldiers in cover${which} in ${place}`;
}

function shotKey(shot) {
  return [shot.kind, shot.zone, shot.coverId || "", shot.unitId || ""].join(":");
}

function attackDice(me, soldierCount, gunJoins, zone) {
  let dice = soldierCount;
  if (gunJoins) dice += zone === "obj" ? 4 : 3;
  if (soldierCount > 0 && state.effects.cavalryCharge === me) dice += 1;
  return dice;
}

function dicePhrase(n) {
  return `${n} attack ${n === 1 ? "die" : "dice"}`;
}

function targetPhrase(shot) {
  const place = ZONE_LABELS[shot.zone];
  if (shot.kind === "exposed") return `exposed soldiers in ${place}`;
  if (shot.kind === "tank") return `the tank in ${place}`;
  if (shot.kind === "mg" || shot.kind === "mortar") return `the ${capType(shot.kind).toLowerCase()} in ${place}`;
  const covers = coversIn(state, shot.zone);
  const cover = covers.find((c) => c.id === shot.coverId);
  const which = covers.length > 1 && cover
    ? ` ${covers.indexOf(cover) + 1}${cover.revealed ? ` (defense ${cover.defense})` : ""}`
    : "";
  if (shot.kind === "cover-empty") return `empty cover${which} in ${place}`;
  return `soldiers in cover${which} in ${place}`;
}

function mgCanJoin(gun, target) {
  if (!machineGunOperational(state, gun) || !target || target.kind === "tank" || !isBattlefield(target.zone)) return false;
  if (zoneDistance(gun.loc, target.zone) > 2) return false;
  if (smoked(state, gun.loc, target.zone)) return false;
  return true;
}

function machineGunHoldReason(me, gun) {
  if (!gun) return "";
  if (!isBattlefield(gun.loc)) return "The machine gun is not on the field.";
  if (gun.damage >= 1) return "The machine gun has 1 damage, so it cannot fire until repaired.";
  const player = state.players[me];
  if (player.attackedIds.includes(gun.id)) return "The machine gun already attacked.";
  if (player.movedEquip.includes(gun.id)) return "The machine gun already moved, so it cannot attack this round.";
  if (state.effects.suppression === "mg" && gun.owner !== state.effects.suppressionBy) {
    return "That machine gun is suppressed and cannot fire.";
  }
  return "";
}

function loneSoldierLabel(shot) {
  const place = ZONE_LABELS[shot.zone];
  if (shot.kind === "exposed") return `Fire at exposed in ${place}`;
  if (shot.kind === "cover") return "Fire at soldiers in that cover";
  if (shot.kind === "cover-empty") return "Try to destroy that cover";
  if (shot.kind === "tank") return "Soldiers attack the tank";
  if (shot.kind === "mg" || shot.kind === "mortar") return `Fire at the ${capType(shot.kind)}`;
  return `Fire at ${targetPhrase(shot)}`;
}

function infantryLabel(me, soldierCount, selectedCount, gunJoins, shot) {
  const diceText = dicePhrase(attackDice(me, soldierCount, gunJoins, shot.zone));
  if (!soldierCount && gunJoins) return `${machineGunLabel(shot)} · ${diceText}`;
  if (soldierCount === 1 && selectedCount === 1 && !gunJoins) {
    const base = loneSoldierLabel(shot);
    return state.effects.cavalryCharge === me ? `${base} · ${diceText}` : base;
  }
  const who = soldierCount === selectedCount
    ? `${soldierCount} soldier${soldierCount === 1 ? "" : "s"}`
    : `${soldierCount} of ${selectedCount} soldiers`;
  const group = gunJoins ? `${who} and the machine gun` : who;
  const verb = soldierCount === 1 && !gunJoins ? "fires" : "fire";
  const sentence = `${group} ${verb} at ${targetPhrase(shot)} · ${diceText}`;
  return gunJoins ? `Combined fire: ${sentence}` : sentence;
}

function zoneAttackTargets(me, zone) {
  if (!isBattlefield(zone)) return [];
  const targets = soldierStrikeTargets(state, me, zone);
  const cover = state.covers.find((c) => c.id === ui.cover && c.loc === zone && !c.destroyed);
  if (cover && !targets.some((target) => target.coverId === cover.id)) {
    const inside = soldiersIn(state, zone, { matchCover: true, coverId: cover.id });
    if (!inside.length) targets.push({ kind: "cover-empty", zone, coverId: cover.id });
  }
  const gear = state.equipment.find((u) => u.id === ui.targetUnit && u.loc === zone && u.owner !== me);
  if (gear) targets.push({ kind: gear.type, zone, unitId: gear.id });
  return targets;
}

function chooseAttackPrimary(list) {
  if (!list.length) return;
  const score = (button) => {
    if (button.combined && button.zone === ui.zone) return 0;
    if (button.combined) return 1;
    if (button.infantry && button.zone === ui.zone) return 2;
    if (button.infantry) return 3;
    if (button.primary) return 4;
    return 5;
  };
  let best = 0;
  for (let i = 1; i < list.length; i += 1) {
    if (score(list[i]) < score(list[best])) best = i;
  }
  list.forEach((button, i) => { button.primary = i === best; });
}

function attackButtons(me) {
  const list = [];
  const zone = ui.zone;
  const player = state.players[me];
  const selected = ui.soldiers
    .map((id) => state.soldiers.find((s) => s.id === id && s.owner === me))
    .filter(Boolean);
  const spent = selected.filter((s) => player.attackedIds.includes(s.id));
  const benched = selected.filter((s) => !player.attackedIds.includes(s.id) && !isBattlefield(s.loc));
  const fresh = selected.filter((s) => soldierMayFire(s, player.attackedIds));
  const unit = state.equipment.find((u) => u.id === ui.unit && u.owner === me);
  if (unit?.type === "mortar" && isBattlefield(unit.loc)) {
    const precision = state.effects.precision.includes(unit.id);
    if (!precision || isBattlefield(zone)) {
      list.push({
        label: precision ? `Precision barrage on ${ZONE_LABELS[zone]}` : "Fire the mortar",
        primary: true,
        run: () => commit({ type: "START_ATTACK", kind: "mortar", unitId: unit.id, target: { kind: "allocate", zone } }),
      });
    }
  }
  if (unit?.type === "tank" && isBattlefield(unit.loc)) {
    const cover = state.covers.find((c) => c.id === ui.cover && !c.destroyed);
    const friendlyInside = cover && soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id }).some((s) => s.owner === me);
    if (cover && cover.loc === unit.loc && !friendlyInside) {
      list.push({ label: "Overrun this cover", primary: true, run: () => commit({ type: "OVERRUN", unitId: unit.id, coverId: cover.id }) });
    }
    if (zone && zoneDistance(unit.loc, zone) <= 1 && zone !== unit.loc) {
      list.push({
        label: `Tank fires on exposed in ${ZONE_LABELS[zone]}`,
        run: () => commit({ type: "START_ATTACK", kind: "tank", unitId: unit.id, target: { kind: "exposed", zone } }),
      });
    } else if (zone === unit.loc) {
      list.push({
        label: "Tank fires on exposed here",
        run: () => commit({ type: "START_ATTACK", kind: "tank", unitId: unit.id, target: { kind: "exposed", zone } }),
      });
    }
    if (zone && zoneDistance(unit.loc, zone) <= 1) {
      for (const shot of soldierStrikeTargets(state, me, zone)) {
        if (shot.kind !== "cover") continue;
        const place = zone === unit.loc ? "here" : `in ${ZONE_LABELS[zone]}`;
        list.push({
          label: `Tank fires on soldiers in cover ${place}`,
          run: () => commit({
            type: "START_ATTACK",
            kind: "tank",
            unitId: unit.id,
            target: { kind: "cover", zone: shot.zone, coverId: shot.coverId },
          }),
        });
      }
    }
  }
  const selectedGun = unit?.type === "mg" ? unit : null;
  const gun = machineGunOperational(state, selectedGun) ? selectedGun : null;
  const aimed = state.equipment.find((u) => u.id === ui.targetUnit && u.owner !== me);
  const shots = [];
  const seen = new Set();
  let order = 0;
  const addShot = (shot) => {
    if (!shot?.zone) return;
    const key = shotKey(shot);
    if (seen.has(key)) return;
    seen.add(key);
    const dist = shot.dist ?? (gun ? zoneDistance(gun.loc, shot.zone) : 0);
    shots.push({ ...shot, dist, order: order += 1 });
  };
  if (fresh.length && isBattlefield(zone)) {
    infantryFireOffers(state, me, fresh.map((s) => s.id), zone).forEach((offer) => addShot(offer.target));
    zoneAttackTargets(me, zone).forEach(addShot);
  }
  if (gun) {
    machineGunTargets(state, gun)
      .slice()
      .sort((a, b) => a.dist - b.dist || BATTLEFIELD.indexOf(a.zone) - BATTLEFIELD.indexOf(b.zone))
      .forEach(addShot);
  }
  shots.sort((a, b) => {
    const rank = (shot) => {
      const soldiers = fresh.filter((s) => canSoldierTarget(s, shot)).length;
      const joins = mgCanJoin(gun, shot);
      if (soldiers && joins && shot.zone === zone) return 0;
      if (soldiers && joins) return 1;
      if (shot.zone === zone) return 2;
      return 3;
    };
    return rank(a) - rank(b) || a.dist - b.dist || a.order - b.order;
  });
  for (const shot of shots) {
    const firing = fresh.filter((s) => canSoldierTarget(s, shot));
    const joins = mgCanJoin(gun, shot);
    if (!firing.length && !joins) continue;
    list.push({
      label: infantryLabel(me, firing.length, fresh.length, joins, shot),
      combined: Boolean(firing.length && joins),
      infantry: true,
      gunJoins: joins,
      soldierCount: firing.length,
      zone: shot.zone,
      run: () => commit({
        type: "START_ATTACK",
        kind: "infantry",
        attackerIds: joins ? [...firing.map((s) => s.id), gun.id] : firing.map((s) => s.id),
        target: { kind: shot.kind, zone: shot.zone, coverId: shot.coverId, unitId: shot.unitId },
      }),
    });
  }
  const notes = [];
  const addNote = (text) => {
    if (text && !notes.includes(text)) notes.push(text);
  };
  if (spent.length === 1) addNote("That soldier already attacked.");
  else if (spent.length) addNote("Some selected soldiers already attacked.");
  if (benched.length) addNote("Soldiers in the trench cannot attack.");
  if (unit?.type === "mortar" && fresh.length) addNote("Mortars never join combined fire. Fire the mortar on its own.");
  if (unit?.type === "tank" && fresh.length) addNote("Tanks never join combined fire. Fire the tank on its own.");
  const held = machineGunHoldReason(me, selectedGun);
  if (selectedGun && held) addNote(held);
  if (isBattlefield(zone) && fresh.length) {
    if (aimed?.type === "tank" && aimed.loc === zone) {
      const left = fresh.length - fresh.filter((s) => s.loc === zone).length;
      if (left === 1) addNote("1 selected soldier is not in the tank's zone. Only soldiers there can attack a tank.");
      else if (left) addNote(`${left} selected soldiers are not in the tank's zone. Only soldiers there can attack a tank.`);
    } else {
      const left = fresh.length - fresh.filter((s) => canSoldierTarget(s, { kind: "exposed", zone })).length;
      if (left === 1) addNote("1 selected soldier cannot reach the selected zone, so they are left out of a shot there.");
      else if (left) addNote(`${left} selected soldiers cannot reach the selected zone, so they are left out of a shot there.`);
    }
  }
  const combined = list.some((button) => button.combined);
  const aloneZones = [...new Set(list.filter((button) => button.gunJoins && !button.soldierCount).map((button) => ZONE_LABELS[button.zone]))];
  if (gun && fresh.length && aloneZones.length) {
    const where = aloneZones.length === 1 ? aloneZones[0] : aloneZones.join(", ");
    addNote(fresh.length === 1
      ? `That soldier cannot reach ${where}, so the machine gun fires there alone.`
      : `Those soldiers cannot reach ${where}, so the machine gun fires there alone.`);
  }
  if (list.some((button) => button.soldierCount > 0 && button.soldierCount < fresh.length)) {
    addNote("Only soldiers in a target's zone, or the next one, join that shot.");
  }
  if (gun && aimed?.type === "tank") addNote("Machine guns cannot shoot tanks.");
  if (gun && fresh.length && !combined) {
    if (isBattlefield(zone) && zoneDistance(gun.loc, zone) > 2) {
      addNote("The machine gun is out of range of that zone, and it shares no other target with these soldiers.");
    } else if (isBattlefield(zone) && smoked(state, gun.loc, zone)) {
      addNote("Smoke blocks the machine gun from that zone, and it shares no other target with these soldiers.");
    } else {
      addNote("Those soldiers and the machine gun have no target they can both reach.");
    }
  } else if (gun && isBattlefield(zone) && !list.some((button) => button.zone === zone && button.gunJoins)) {
    if (zoneDistance(gun.loc, zone) > 2) addNote("The machine gun is out of range of that zone. It can fire up to two zones away.");
    else if (smoked(state, gun.loc, zone)) addNote("Smoke blocks the machine gun from that zone.");
  }
  if (state.effects.cavalryCharge === me && list.some((button) => button.soldierCount > 0)) {
    addNote("Cavalry Charge adds 1 attack die because soldiers are firing.");
  }
  attackHint = notes.join(" ");
  chooseAttackPrimary(list);
  list.push({ label: "End attacks", primary: list.length === 0, run: () => askLeave({ type: "SKIP_ATTACK" }) });
  return list;
}

function mortarName(_owner, face) {
  if (face === "z1") return "Enemy Zone 1";
  if (face === "z2") return "Enemy Zone 2";
  if (face === "z3") return "Enemy Zone 3";
  return ZONE_LABELS[face] || face;
}

function extraControls() {
  const card = selectedCard();
  if (!card || state.actionStep !== "event" || !myTurn()) return "";
  const bits = [];
  if (card.title === "Patrol") {
    bits.push(`<div class="subrow">
      <button type="button" class="${ui.dir !== "back" ? "on" : ""}" data-click="dir" data-value="forward">Forward</button>
      <button type="button" class="${ui.dir === "back" ? "on" : ""}" data-click="dir" data-value="back">Backward</button>
    </div>`);
  }
  if (eventNeeds(card.title).includes("supportType")) {
    bits.push(`<div class="subrow">
      <button type="button" class="${ui.supportType !== "mortar" ? "on" : ""}" data-click="support" data-value="mg">Suppress machine guns</button>
      <button type="button" class="${ui.supportType === "mortar" ? "on" : ""}" data-click="support" data-value="mortar">Suppress mortars</button>
    </div>`);
  }
  if (card.title === "Heavy Barrage" || card.title === "Bombing Run") {
    bits.push(`<div class="subrow">
      ${["exposed", "cover", "unit"].map((kind) => `<button type="button" class="${ui.targetKind === kind ? "on" : ""}" data-click="target-kind" data-value="${kind}">${kind === "exposed" ? "Exposed soldiers" : kind === "cover" ? "A cover" : "A weapon"}</button>`).join("")}
    </div>`);
  }
  const needs = eventNeeds(card.title);
  const notes = [];
  if (needs.includes("soldiers")) notes.push(`${ui.soldiers.length} soldier${ui.soldiers.length === 1 ? "" : "s"} selected`);
  if (needs.some((n) => ["zone", "enemyZone", "controlledZone"].includes(n))) notes.push(ui.zone ? ZONE_LABELS[ui.zone] : "select a zone on the map");
  if (needs.includes("covers") || needs.includes("enemyCover")) notes.push(ui.cover ? "cover selected" : "select a cover token");
  if (needs.includes("enemySoldier")) notes.push(ui.enemy ? "enemy soldier selected" : "select an enemy soldier");
  if (needs.some((n) => n.startsWith("friendly"))) notes.push(ui.unit ? "your unit selected" : "select one of your weapons");
  if (needs.includes("enemyDie")) notes.push(ui.dieIndex == null ? "click one of their dice" : `die ${ui.dieIndex + 1}`);
  if (card.reminder) notes.push(card.reminder);
  return `${bits.join("")}${notes.length ? `<div class="hint">${esc(notes.join(" · "))}</div>` : ""}`;
}

function wildControls() {
  if (!myTurn() || state.phase !== "reroll") return "";
  const me = viewer();
  if (!state.players[me].dice.includes("wild")) return "";
  const choices = ["boot", "whistle", "shovel", "bayonet"].filter((f) => naturalFaces(state.players[me].dice).includes(f));
  if (!choices.length) return `<div class="hint">All five dice are Wild. They have nothing to copy.</div>`;
  return `<div class="subrow">${choices.map((face) => `<button type="button" class="${ui.wildAs === face ? "on" : ""}" data-click="wild" data-value="${face}">Wilds as ${FACE_LABEL[face]}</button>`).join("")}</div>`;
}

function cardBlurb(card) {
  const main = card.text || card.condition || "";
  const extra = card.reminder && card.reminder !== main ? card.reminder : "";
  return [main, extra].filter(Boolean).join(" ");
}

function buttonRow(list) {
  buttons = list;
  const hintText = [attackHint, deployNote].filter(Boolean).join(" ");
  const hint = hintText ? `<div class="hint">${esc(hintText)}</div>` : "";
  return `${hint}<div class="actions">${actionUndoButton()}${list.map((b, i) => `<button type="button" class="${b.primary ? "primary" : ""}" data-click="act" data-i="${i}"${b.hint ? ` data-tip="${esc(b.hint)}"` : ""}>${esc(b.label)}</button>`).join("")}</div>`;
}

function attackDieFace(face, key) {
  const spinning = Boolean(key && tumble?.keys.has(key));
  const shown = spinning ? flicker(key, face, ATTACK_POOL) : face;
  const hit = shown === "hit";
  const src = ATTACK_ICON[hit ? "hit" : "miss"];
  const word = hit ? "Hit" : "Miss";
  const motion = spinning ? tumbleAttrs(key, "attack", face, ATTACK_POOL) : "";
  return `<span class="die attack ${hit ? "hit" : "miss"}${spinning ? " tumbling" : ""}"${motion}><img src="${src}" alt="" draggable="false"><span>${word}</span></span>`;
}

function mortarDieFace(face, key) {
  const spinning = Boolean(key && face && tumble?.keys.has(key));
  const shown = spinning ? flicker(key, face, MORTAR_POOL) : face;
  const src = MORTAR_ICON[shown];
  const word = shown === "z1" ? "Zone 1" : shown === "z2" ? "Zone 2" : shown === "z3" ? "Zone 3" : mortarName(viewer(), shown);
  const motion = spinning ? tumbleAttrs(key, "mortar", face, MORTAR_POOL) : "";
  if (!src) return `<span class="die attack miss${spinning ? " tumbling" : ""}"${motion}><span>${esc(word)}</span></span>`;
  return `<span class="die attack zone${spinning ? " tumbling" : ""}"${motion}><img src="${src}" alt="" draggable="false"><span>${esc(word)}</span></span>`;
}

function attackReadoutLive() {
  const roll = state.lastRoll;
  if (!roll) return false;
  const pending = state.pending?.type;
  if (pending === "allocate-hits" || pending === "spotter" || pending === "mortar-target") return true;
  return roll.kind === "mustard" && state.phase === "action" && state.actionStep === "shock";
}

function lastRoll() {
  if (!attackReadoutLive()) {
    if (!glance?.faces?.length) return "";
    const hits = glance.hits;
    return `<div class="dice-row"><span class="tag">Attack</span>${glance.faces.map((face, index) => attackDieFace(face, `attack:${index}`)).join("")}<span class="quiet">${hits} hit${hits === 1 ? "" : "s"} · 3 Hit / 3 Miss</span></div>`;
  }
  const roll = state.lastRoll;
  if (roll?.kind === "mustard" && roll.zones?.length) {
    const rows = roll.zones.map((zoneRoll, zi) => {
      const hits = zoneRoll.hits;
      const name = ZONE_LABELS[zoneRoll.zone] || zoneRoll.zone;
      const faces = (zoneRoll.faces || []).map((face, fi) => attackDieFace(face, `mustard:${zi}:${fi}`)).join("");
      return `<div class="dice-row mustard-zone"><span class="tag">${esc(name)}</span>${faces}<span class="quiet">${hits} hit${hits === 1 ? "" : "s"}</span></div>`;
    }).join("");
    return `<div class="mustard-rolls">${rows}</div>`;
  }
  if (!roll?.faces?.length) return "";
  if (roll.kind === "mortar") {
    return `<div class="dice-row"><span class="tag">Mortar</span>${roll.faces.map((face, index) => mortarDieFace(face, `mortar:${index}`)).join("")}</div>`;
  }
  const hits = roll.hits;
  return `<div class="dice-row"><span class="tag">Attack</span>${roll.faces.map((face, index) => attackDieFace(face, `attack:${index}`)).join("")}<span class="quiet">${hits} hit${hits === 1 ? "" : "s"} · 3 Hit / 3 Miss</span></div>`;
}

function stepRail() {
  if (state.phase !== "action") return "";
  const current = STEPS.findIndex(([id]) => id === state.actionStep);
  return `<ol class="steps">${STEPS.map(([id, label], i) => `<li class="${i === current ? "now" : i < current ? "done" : ""}">${label}</li>`).join("")}</ol>`;
}

function cardButton(card, kind) {
  const selected = ui.card === card.inst ? "selected" : "";
  const blurb = cardBlurb(card);
  return `<button type="button" class="card ${kind} ${selected}" data-click="card" data-id="${card.inst}"${blurb ? ` data-tip="${esc(blurb)}"` : ""}>
    <div class="meta">${esc(card.type || card.category || card.timing || "")}${card.vp ? ` · ${card.vp} VP` : ""}${card.whistle ? " · 1 whistle" : ""}</div>
    <h4>${esc(card.title)}</h4>
    <p>${esc(card.text || card.condition || "")}</p>
    ${kind === "mission" ? `<div class="progress">${esc(missionNote(viewer(), card))}</div>` : ""}
  </button>`;
}

function sidebar() {
  const me = viewer();
  const you = state.players[me];
  const foe = state.players[me === "uk" ? "de" : "uk"];
  if (ui.tab === "log") {
    return `<div class="panel">${state.log.map((line) => `<div class="log-item"><b>R${line.round}</b> ${esc(line.text)}</div>`).join("")}</div>`;
  }
  if (ui.tab === "missions") {
    const done = you.completedMissions.map((m) => `<div class="quiet">${esc(m.title)} · +${m.vp}</div>`).join("");
    return `<div class="panel"><h3>Your missions</h3>${you.missionHand.map((m) => cardButton(m, "mission")).join("") || `<p class="quiet">No missions in hand.</p>`}
      <h3>Completed</h3>${done || `<p class="quiet">None yet.</p>`}
      <h3>${labelSide(foe.side)} </h3><p class="quiet">${foe.missionHand.length} hidden mission${foe.missionHand.length === 1 ? "" : "s"} · ${foe.completedMissions.length} completed · ${foe.destroyedCover.length} cover destroyed</p></div>`;
  }
  const table = state.eventDisplay.length
    ? `<h3>Face up on the table</h3>${state.eventDisplay.map((c) => `<div class="quiet tip-host" data-tip="${esc(cardBlurb(c))}">${esc(c.title)}</div>`).join("")}`
    : "";
  return `<div class="panel"><h3>Your events ${you.eventHand.length}/7</h3>${you.eventHand.map((c) => cardButton(c, "")).join("") || `<p class="quiet">No events.</p>`}
    ${table}
    <h3>Opponent</h3><p class="quiet">${labelSide(foe.side)} holds ${foe.eventHand.length} event${foe.eventHand.length === 1 ? "" : "s"}.</p></div>`;
}

function supplyToken(src, count, label) {
  return `<div class="supply-token" title="${esc(label)} ${count}"><img src="${src}" alt="" draggable="false"><b>${count}</b><span>${esc(label)}</span></div>`;
}

function supplyLine() {
  const me = viewer();
  const soldier = me === "de" ? "assets/soldier-german.png" : "assets/soldier-british.png";
  const tank = me === "de" ? "assets/tank-german.png" : "assets/tank-british.png";
  return `<div class="supply-row" aria-label="Supply">${supplyToken(soldier, countAt(me, "available"), "Soldiers")}${supplyToken("assets/mortar.png", mortarsInSupply(state, me), "Mortars")}${supplyToken("assets/machine-gun.png", machineGunsInSupply(state, me), "Machine guns")}${supplyToken(tank, tanksInSupply(state, me), "Tanks")}${supplyToken("assets/cover-token.jpg", state.coverSupply.length, "Cover")}</div>`;
}

function ledgerStats() {
  let games = [];
  try {
    games = readLedger(localStorage);
  } catch {
    games = [];
  }
  return summarize(games);
}

function resultBanner() {
  if (state.phase !== "end") return "";
  const title = state.winner ? `${labelSide(state.winner)} wins` : "The battle is a draw";
  const stats = ledgerStats();
  const games = `${stats.played} ${stats.played === 1 ? "game" : "games"}`;
  const totals = `${games} · Britain ${stats.britain} · Germany ${stats.germany} · Draws ${stats.draws}`;
  return `<div class="result"><strong>${title}</strong><span>${state.vp.uk}–${state.vp.de} · ${esc(state.tiebreak || "")}</span><button type="button" class="primary" data-click="new">New battle</button><button type="button" data-click="export-excel">Export to Excel</button><span class="ledger-totals">${esc(totals)}</span></div>`;
}

function showCardTip(el) {
  let tip = document.getElementById("card-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "card-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  tip.textContent = el.dataset.tip || "";
  tip.hidden = false;
  const margin = 10;
  const rect = el.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - margin * 2);
  tip.style.width = `${width}px`;
  tip.style.left = "0px";
  tip.style.top = "0px";
  const height = tip.offsetHeight;
  let left = rect.right + margin;
  if (left + width > window.innerWidth - margin || rect.left > window.innerWidth * 0.5) {
    left = rect.left - width - margin;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  let top = rect.top + (rect.height - height) / 2;
  if (rect.bottom > window.innerHeight - 140) top = rect.top - height - margin;
  if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
  if (top < margin) top = margin;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideCardTip() {
  const tip = document.getElementById("card-tip");
  if (tip) tip.hidden = true;
}

function battleStamp(game) {
  try {
    return JSON.stringify(game);
  } catch {
    return "";
  }
}

function unsavedBattle() {
  if (!state || state.phase === "end") return false;
  return battleStamp(state) !== savedStamp;
}

function saveRecord() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !data.state?.players?.uk || !data.state?.players?.de) return null;
    return data;
  } catch {
    return null;
  }
}

function actingSide(game) {
  const pending = game?.pending;
  if (pending?.type === "generals-order" || pending?.type === "spotter" || pending?.type === "mortar-target" || pending?.type === "gambit" || pending?.type === "pick-mission") {
    return pending.side;
  }
  if (game?.phase === "reroll" || game?.phase === "action" || game?.phase === "regroup") return game.active;
  return game?.human;
}

function stepName(game) {
  if (!game) return "Battle";
  if (game.phase === "end") return "Battle over";
  if (game.pending?.type === "pick-mission") return "Choose a mission";
  if (game.pending?.type === "generals-order") return "General's Order";
  if (game.pending?.type === "spotter") return "Spotter";
  if (game.pending?.type === "gambit") return "Mission Gambit";
  if (game.pending?.type === "mortar-target") return "Mortar";
  if (game.phase === "reroll") return "Action dice";
  if (game.phase === "regroup") return "Regroup";
  if (game.phase === "action") return STEPS.find(([id]) => id === game.actionStep)?.[1] || "Action";
  return game.phase || "Battle";
}

function saveSummary(record) {
  const game = record?.state;
  if (!game) return "No saved battle.";
  const side = actingSide(game);
  const who = side === "uk" || side === "de" ? labelSide(side) : "Saved battle";
  return `${who} · round ${game.round} · ${stepName(game)}.`;
}

function adoptIds(game) {
  let max = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if ((key === "id" || key === "inst") && typeof value === "string") {
        const match = /(\d+)$/.exec(value);
        if (match) max = Math.max(max, Number(match[1]));
      } else if (value && typeof value === "object") visit(value);
    }
  };
  visit(game);
  resetIds(max + 1);
}

function restoreSetup(record) {
  const saved = record.setup || {};
  const game = record.state || {};
  if (saved.format === "short" || saved.format === "standard" || saved.format === "extended") setup.format = saved.format;
  else if (game.format === "short" || game.format === "standard" || game.format === "extended") setup.format = game.format;
  if (saved.human === "uk" || saved.human === "de") setup.human = saved.human;
  else if (game.human === "uk" || game.human === "de") setup.human = game.human;
  if (saved.mode === "solo" || saved.mode === "hotseat") setup.mode = saved.mode;
  else setup.mode = game.mode === "hotseat" ? "hotseat" : "solo";
  if (saved.undo === "on" || saved.undo === "off") setup.undo = saved.undo;
  if (saved.difficulty === "Easy" || saved.difficulty === "Difficult" || saved.difficulty === "Hard") setup.difficulty = saved.difficulty;
  else if (game.difficulty === "Easy" || game.difficulty === "Difficult" || game.difficulty === "Hard") setup.difficulty = game.difficulty;
}

function leaveToSetup() {
  clearMissionCelebration();
  clearEmptyTimer();
  resetPresentation();
  coverMemory = null;
  state = null;
  coverAsk = null;
  history = [];
  leaveAsk = null;
  stepReturn = null;
  actionUndo = null;
  attackDraft = null;
  holdEmpty = null;
  emptyMemo = null;
  ui = freshUi();
  paused = false;
  menuOpen = false;
  menuConfirm = null;
  menuNote = "";
  render();
}

function applyLoad(record) {
  clearMissionCelebration();
  clearEmptyTimer();
  resetPresentation();
  coverMemory = null;
  history = [];
  leaveAsk = null;
  stepReturn = null;
  actionUndo = null;
  attackDraft = null;
  holdEmpty = null;
  emptyMemo = null;
  state = record.state;
  adoptIds(state);
  restoreSetup(record);
  ui = freshUi();
  ui.tab = record.tab === "missions" || record.tab === "log" ? record.tab : "events";
  ui.acked = record.acked || null;
  try {
    onBattleLoaded(localStorage, state);
  } catch {
    /* A ledger problem must not block the loaded battle. */
  }
  savedStamp = battleStamp(state);
  paused = false;
  menuOpen = false;
  menuConfirm = null;
  menuNote = "";
  render();
}

function writeSave() {
  if (!state) {
    menuNote = "There is no battle to save.";
    render();
    return;
  }
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    setup: { format: setup.format, human: setup.human, mode: setup.mode, undo: setup.undo, difficulty: setup.difficulty },
    acked: ui.acked,
    tab: ui.tab,
    state,
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  } catch {
    menuNote = "Could not save on this device.";
    render();
    return;
  }
  savedStamp = battleStamp(state);
  menuNote = "Battle saved on this device.";
  render();
}

function confirmCopy() {
  if (menuConfirm === "load") {
    return {
      title: "Load the saved battle?",
      body: "The battle on the table will be replaced.",
      yes: "Load",
      kind: "menu-load-yes",
    };
  }
  if (menuConfirm === "quit") {
    return {
      title: "Quit to the start screen?",
      body: unsavedBattle()
        ? "This battle has not been saved. Quit leaves any battle already saved on this device."
        : "You will return to the start screen. The saved battle stays on this device.",
      yes: "Quit",
      kind: "menu-quit-yes",
    };
  }
  if (menuConfirm === "new") {
    return {
      title: "Start a new game?",
      body: "This battle has not been saved. You will return to the start screen. A battle already saved on this device stays.",
      yes: "New game",
      kind: "menu-new-yes",
    };
  }
  if (menuConfirm === "update") {
    const unfinished = state && state.phase !== "end";
    return {
      title: "Update this game?",
      body: unfinished
        ? "A newer version is available. The page reloads when the download finishes. An unfinished battle in this browser will still be there only if you saved it. A reload does not wipe localStorage saves, but it does leave the current on-screen battle."
        : "A newer version is available. The page reloads when the download finishes.",
      yes: "Update",
      kind: "menu-update-yes",
    };
  }
  return {
    title: "Delete the saved battle?",
    body: "This removes it from this device. The battle on the table stays.",
    yes: "Delete save",
    kind: "menu-delete-yes",
  };
}

function noteBattleOutcome(game) {
  if (!game || game.phase !== "end") return;
  try {
    recordFinished(localStorage, game);
  } catch {
    /* The battle stands even if this browser cannot store the ledger. */
  }
}

function forgetUndoneResult(game) {
  if (!game || game.phase === "end") return;
  try {
    dropIfUnfinished(localStorage, game);
  } catch {
    /* Undoing the battle still works if the ledger cannot be updated. */
  }
}

function downloadBytes(filename, bytes) {
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadBalance() {
  let games = [];
  let failed = false;
  try {
    if (state?.phase === "end") {
      const result = recordFinished(localStorage, state);
      games = result.games;
      failed = Boolean(result.error);
    } else {
      games = readLedger(localStorage);
    }
  } catch {
    failed = true;
    games = [];
  }
  try {
    const log = state?.phase === "end" ? state.log || [] : null;
    downloadBytes(FILENAME, buildBalanceWorkbook(games, log));
    if (failed) {
      menuOpen = true;
      menuNote = "The spreadsheet downloaded, but this browser could not store the balance ledger.";
    } else if (menuOpen) {
      menuNote = "Balance spreadsheet downloaded.";
    }
  } catch {
    menuOpen = true;
    menuNote = "Could not download the spreadsheet.";
  }
  render();
}

function showZipUpdate(reason) {
  menuConfirm = null;
  menuLink = UPDATE_PAGE;
  menuNote = `${reason} Download the latest ZIP:`;
}

function takeUpdateNote() {
  try {
    const note = sessionStorage.getItem(UPDATE_NOTE_KEY) || "";
    if (note) sessionStorage.removeItem(UPDATE_NOTE_KEY);
    return note;
  } catch {
    return "";
  }
}

function reloadGame(note) {
  updateLeaving = true;
  try {
    sessionStorage.setItem(UPDATE_NOTE_KEY, note);
  } catch {
    /* The navigation still loads the current files. */
  }
  const url = new URL(location.href);
  url.searchParams.set("v", String(Date.now()));
  location.replace(url.href);
}

function updateReloadNote(data) {
  const unfinished = Boolean(state && state.phase !== "end");
  let note;
  if (data.localNewer) note = "This copy already has newer local work than GitHub.";
  else if (data.updated) note = "The update is downloaded. This page reloaded so you are playing it.";
  else if (data.upToDate) note = "The game is already the latest.";
  else note = data.message || "The game reloaded.";
  if (unfinished) {
    note += " An unfinished battle in this browser will still be there only if you saved it. A reload does not wipe localStorage saves, but it does leave the current on-screen battle.";
  }
  return note;
}

function finishUpdate(data) {
  menuLink = "";
  menuConfirm = null;
  if (!data || typeof data !== "object") {
    menuNote = "The update failed.";
    return;
  }
  if (data.git === false) {
    showZipUpdate("Git is missing, so this copy cannot update itself.");
    return;
  }
  if (data.clone === false) {
    showZipUpdate("This copy is not a git clone, so it cannot update itself.");
    return;
  }
  if (data.conflict) {
    menuNote = "This copy has a merge conflict. Update was not run.";
    return;
  }
  if (data.behind) {
    menuConfirm = "update";
    menuNote = "";
    return;
  }
  if (data.ok === false) {
    menuNote = data.message || "The update failed.";
    return;
  }
  if (data.reload || data.upToDate || data.localNewer || data.updated === true || data.updated === false) {
    reloadGame(updateReloadNote(data));
    return;
  }
  menuNote = data.message || "Could not check for an update.";
}

async function checkForUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  menuOpen = true;
  menuConfirm = null;
  menuLink = "";
  menuNote = "Checking for an update…";
  render();
  try {
    let response;
    try {
      response = await fetch("/local-update/status", {
        cache: "no-store",
        headers: { "X-Trench-Local": "1" },
      });
    } catch {
      menuNote = "Close the server and start again with start.bat (Windows) so Update can run.";
      return;
    }
    if (response.status === 404) {
      menuNote = "Close the server and start again with start.bat (Windows) so Update can run.";
      return;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") {
      menuNote = "Could not check for an update.";
      return;
    }
    finishUpdate(data);
  } finally {
    if (!updateLeaving) {
      updateBusy = false;
      menuOpen = true;
      render();
    }
  }
}

async function runGameUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  menuOpen = true;
  menuConfirm = null;
  menuLink = "";
  menuNote = "Updating the game…";
  render();
  try {
    let response;
    try {
      response = await fetch("/local-update/pull", {
        method: "POST",
        cache: "no-store",
        headers: { "X-Trench-Local": "1" },
      });
    } catch {
      menuNote = "Close the server and start again with start.bat (Windows) so Update can run.";
      return;
    }
    if (response.status === 404) {
      menuNote = "Close the server and start again with start.bat (Windows) so Update can run.";
      return;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    finishUpdate(data);
  } finally {
    if (!updateLeaving) {
      updateBusy = false;
      menuOpen = true;
      render();
    }
  }
}

function menuActionsHtml(record) {
  const load = `<button type="button" data-click="menu-load"${record ? "" : " disabled"}>Load</button>`;
  const drop = `<button type="button" data-click="menu-delete"${record ? "" : " disabled"}>Delete save</button>`;
  const excel = `<button type="button" data-click="export-excel">Export to Excel</button>`;
  const update = `<button type="button" data-click="menu-update"${updateBusy ? " disabled" : ""}>Update game</button>`;
  if (!state) return `${load}${drop}${excel}${update}`;
  return `<button type="button" class="primary" data-click="menu-resume">Resume</button>
    <button type="button" data-click="menu-pause"${paused ? " disabled" : ""}>Pause</button>
    <button type="button" data-click="menu-save">Save</button>
    ${excel}
    ${load}
    <button type="button" data-click="menu-new">New game</button>
    <button type="button" data-click="menu-quit">Quit</button>
    ${drop}
    ${update}`;
}

function soundControlHtml() {
  const on = soundEnabled();
  return `<button type="button" data-click="menu-sound" aria-pressed="${on ? "true" : "false"}">Sound ${on ? "on" : "off"}</button>`;
}

function menuPanelHtml() {
  const record = saveRecord();
  const ask = confirmCopy();
  const body = menuConfirm
    ? `<p class="menu-ask">${esc(ask.title)}</p><p class="menu-note">${esc(ask.body)}</p><button type="button" class="primary" data-click="${ask.kind}">${esc(ask.yes)}</button><button type="button" data-click="menu-cancel">Cancel</button>`
    : menuActionsHtml(record);
  const note = menuNote ? `<p class="menu-note">${esc(menuNote)}</p>` : "";
  const link = menuLink ? `<p class="menu-note"><a href="${esc(menuLink)}">${esc(menuLink)}</a></p>` : "";
  return `<div class="game-menu" id="game-menu" role="dialog" aria-label="Menu"><h2>Menu</h2><p class="game-version">${esc(versionLabel())}</p>${soundControlHtml()}${body}<p class="menu-status">${esc(record ? saveSummary(record) : "No saved battle.")}</p>${note}${link}</div>`;
}

function menuChrome() {
  const open = menuOpen ? "true" : "false";
  const panel = menuOpen ? menuPanelHtml() : "";
  const hold = state && paused
    ? `<div class="pause-veil" data-click="pause-hold" role="dialog" aria-labelledby="pause-title"><div class="veil-card"><h2 id="pause-title">Pause</h2><p>The field is held. Open Menu and choose Resume, or press Escape.</p></div></div>`
    : "";
  return `<button type="button" class="menu-launch" data-click="menu" aria-expanded="${open}" aria-haspopup="dialog" aria-controls="game-menu">Menu</button>${panel}${hold}`;
}

function handleMenu(kind) {
  if (kind === "menu-sound") {
    setSoundEnabled(!soundEnabled());
    render();
    return true;
  }
  if (kind === "pause-hold") return true;
  if (kind !== "menu-update" && kind !== "menu-update-yes") menuLink = "";
  if (kind === "export-excel") {
    downloadBalance();
    return true;
  }
  if (kind === "menu-update") {
    checkForUpdate();
    return true;
  }
  if (kind === "menu-update-yes") {
    runGameUpdate();
    return true;
  }
  if (kind === "menu") {
    menuOpen = !menuOpen;
    if (!menuOpen) menuConfirm = null;
    if (menuOpen) {
      menuNote = "";
      menuLink = "";
    }
    render();
    return true;
  }
  if (kind === "menu-cancel") {
    menuConfirm = null;
    render();
    return true;
  }
  if (kind === "menu-resume") {
    paused = false;
    menuOpen = false;
    menuConfirm = null;
    render();
    return true;
  }
  if (kind === "menu-pause") {
    if (!state || paused) return true;
    paused = true;
    menuOpen = false;
    menuConfirm = null;
    render();
    return true;
  }
  if (kind === "menu-save") {
    writeSave();
    return true;
  }
  if (kind === "menu-load") {
    const record = saveRecord();
    if (!record) {
      menuNote = "No saved battle.";
      render();
      return true;
    }
    if (state) {
      menuConfirm = "load";
      menuNote = "";
      render();
      return true;
    }
    applyLoad(record);
    return true;
  }
  if (kind === "menu-load-yes") {
    const record = saveRecord();
    menuConfirm = null;
    if (!record) {
      menuNote = "No saved battle.";
      render();
      return true;
    }
    applyLoad(record);
    return true;
  }
  if (kind === "menu-new") {
    if (!state) return true;
    if (unsavedBattle()) {
      menuOpen = true;
      menuConfirm = "new";
      menuNote = "";
      render();
      return true;
    }
    leaveToSetup();
    return true;
  }
  if (kind === "menu-new-yes" || kind === "menu-quit-yes") {
    leaveToSetup();
    return true;
  }
  if (kind === "menu-quit") {
    if (!state) return true;
    menuOpen = true;
    menuConfirm = "quit";
    menuNote = "";
    render();
    return true;
  }
  if (kind === "menu-delete") {
    if (!saveRecord()) {
      menuNote = "No saved battle.";
      render();
      return true;
    }
    menuConfirm = "delete";
    menuNote = "";
    render();
    return true;
  }
  if (kind === "menu-delete-yes") {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      menuConfirm = null;
      menuNote = "Could not delete the saved battle.";
      render();
      return true;
    }
    savedStamp = null;
    menuConfirm = null;
    menuNote = "Saved battle deleted.";
    render();
    return true;
  }
  return false;
}

function onMenuKey(event) {
  if (event.key !== "Escape") return;
  if (!menuOpen && !paused && !menuConfirm && !leaveAsk) return;
  event.preventDefault();
  if (leaveAsk && !menuOpen && !menuConfirm) {
    leaveAsk = null;
    render();
    return;
  }
  if (menuConfirm) {
    menuConfirm = null;
    render();
    return;
  }
  if (menuOpen) {
    menuOpen = false;
    render();
    return;
  }
  if (paused) {
    paused = false;
    render();
  }
}

function emptyStepView() {
  if (!state || state.phase !== "action" || state.pending?.type !== "action" || !myTurn()) return null;
  if (emptyMemo?.state === state && emptyMemo.step === state.actionStep && emptyMemo.active === state.active) {
    return emptyMemo.view;
  }
  const empty = !stepHasLegalAction();
  const view = empty ? { advance: true, reason: emptyStepReason(state, viewer()) || "" } : null;
  emptyMemo = { state, step: state.actionStep, active: state.active, view };
  return view;
}

function scheduleEmptyAdvance() {
  clearEmptyTimer();
  const view = emptyStepView();
  if (!view?.advance || paused || leaveAsk || missionToast || killToast || menuOpen || ui.help) return;
  if (holdEmpty && holdEmpty.step === state.actionStep && holdEmpty.active === state.active && holdEmpty.round === state.round) return;
  const step = state.actionStep;
  const active = state.active;
  const round = state.round;
  const type = EMPTY_SKIP[step];
  if (!type) return;
  emptyTimer = window.setTimeout(() => {
    emptyTimer = 0;
    if (!state || state.phase !== "action" || state.actionStep !== step || state.active !== active || state.round !== round) return;
    if (state.pending?.type !== "action" || !myTurn() || paused || leaveAsk) return;
    if (holdEmpty && holdEmpty.step === step && holdEmpty.active === active && holdEmpty.round === round) return;
    if (stepHasLegalAction()) return;
    commit({ type }, { leaving: true });
  }, 900);
}

function roundNotes() {
  if (Array.isArray(state.roundBrief)) {
    return state.roundBrief.filter((line) => line && line.round === state.round).slice(-12);
  }
  const patterns = [/wins Initiative/, /mortar hits/i, /most kills/, /completes .+\(\+/];
  return (state.log || [])
    .filter((line) => line.round === state.round && patterns.some((re) => re.test(line.text || "")))
    .slice(0, 12)
    .reverse();
}

function roundLogHtml() {
  const notes = roundNotes();
  const items = notes.length
    ? `<ul>${notes.map((line) => `<li>${esc(line.text)}</li>`).join("")}</ul>`
    : `<p class="quiet">Nothing recorded yet this round.</p>`;
  return `<div class="round-log"><h3>Round ${state.round}</h3>${items}</div>`;
}

function render() {
  hideCardTip();
  clearEmptyTimer();
  const root = document.getElementById("app");
  const board = root.querySelector(".theatre");
  const map = root.querySelector(".map-scroll");
  const side = root.querySelector(".side-scroll");
  const boardTop = board?.scrollTop || 0;
  const mapLeft = map?.scrollLeft || 0;
  const sideTop = side?.scrollTop || 0;
  if (!state) {
    clearFx();
    root.innerHTML = `${menuChrome()}${coverAsk ? coverPlaceHtml() : splashHtml()}`;
    return;
  }
  noteCoverFlips();
  const seatHidden = state.mode === "hotseat" && state.phase !== "end" && ui.acked !== actorSide() && actorSide();
  if (seatHidden) {
    root.innerHTML = `${menuChrome()}${veilHtml()}${helpHtml()}${killHtml()}${missionHtml()}${leaveHtml()}`;
    return;
  }
  const me = viewer();
  const foeSide = me === "uk" ? "de" : "uk";
  const rounds = Array.from({ length: state.maxRounds }, (_, i) => `<i class="pip-round ${i < state.round ? "on" : ""}"></i>`).join("");
  const conceal = paused;
  root.innerHTML = `${menuChrome()}<div class="app"${conceal ? " inert aria-hidden=\"true\"" : ""}>
    <header class="topbar">
      <div class="brand"><h1>Trench Shock</h1><span>${esc(formatName())} · seed ${state.initialSeed}</span></div>
      <div class="pips" title="Round ${state.round} of ${state.maxRounds}">${rounds}</div>
      <div class="scores">
        <div class="score uk"><div><small>Britain</small></div><b>${state.vp.uk}</b></div>
        <div class="score de"><div><small>Germany</small></div><b>${state.vp.de}</b></div>
      </div>
      ${undoButton()}
      <button type="button" class="ghost" data-click="help">How to play</button>
      <button type="button" class="ghost" data-click="new">New battle</button>
    </header>
    <div class="layout">
      <div class="theatre"><div class="map-scroll"><div class="board">${TRENCH_LINE.map(renderZone).join("")}</div></div>${supplyLine()}</div>
      <aside class="sidebar">
        ${roundLogHtml()}
        <div class="tabs">
          ${["events", "missions", "log"].map((tab) => `<button type="button" class="${ui.tab === tab ? "on" : ""}" data-click="tab" data-tab="${tab}">${tab}</button>`).join("")}
        </div>
        <div class="side-scroll">${sidebar()}</div>
      </aside>
    </div>
    <footer class="tray">
      ${resultBanner()}
      ${stepRail()}
      <div class="who"><h2>${esc(phaseTitle())}</h2><div class="pool">${esc(poolText(me))}</div></div>
      <div class="prompt${promptFlashClass()}" aria-live="polite">${promptText()}</div>
      ${lastRoll()}
      ${roundBanner()}
      ${state.initiative?.winner ? `<div class="quiet table-label">On the table</div>` : ""}
      <div class="dice-row"><span class="tag">${labelSide(me)}${state.player1 === me ? " · first" : ""}</span>${state.players[me].dice.map((f, i) => dieButton(me, f, i)).join("")}${diceCombo(me)}</div>
      <div class="dice-row"><span class="tag">${labelSide(foeSide)}${state.player1 === foeSide ? " · first" : ""}</span>${state.players[foeSide].dice.map((f, i) => dieButton(foeSide, f, i)).join("")}${diceCombo(foeSide)}</div>
      ${wildControls()}
      ${extraControls()}
      ${veilShowing() ? "" : backControl()}
      ${buttonRow(actionList())}
      ${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}
    </footer>
  </div>
  ${veilHtml()}
  ${helpHtml()}
  ${killHtml()}
  ${missionHtml()}
  ${leaveHtml()}`;
  const nextBoard = root.querySelector(".theatre");
  const nextMap = root.querySelector(".map-scroll");
  const nextSide = root.querySelector(".side-scroll");
  if (nextBoard) nextBoard.scrollTop = boardTop;
  if (nextMap) nextMap.scrollLeft = mapLeft;
  if (nextSide) nextSide.scrollTop = sideTop;
  if (fxLive.length) kickFx();
  scheduleEmptyAdvance();
}

function pinFace(face) {
  const src = FACE_ICON[face];
  if (!src) return "";
  return `<span class="pin-die"><img src="${src}" alt="" draggable="false"></span>`;
}

function roundTitleText() {
  const round = state?.round || 1;
  const first = state?.player1;
  if (first === "uk" || first === "de") return `Round ${round} — ${labelSide(first)} acts first`;
  return `Round ${round}`;
}

function roundBanner() {
  return `<div class="round-banner"><p class="round-title">${esc(roundTitleText())}</p>${initiativeLine()}</div>`;
}

function initiativeLine() {
  const pin = pinnedInitiative(state);
  if (!pin) return "";
  const roll = pin.tieRolls ? "Deciding roll" : "Roll 1";
  return `<div class="initiative-pin">
    <div><b>${esc(labelSide(pin.winner))} wins initiative</b><span class="pin-note">${esc(roll)} · wilds ignored</span></div>
    <div class="pin-side"><span>Britain</span>${pin.ukDice.map(pinFace).join("")}<em>${esc(pin.uk)}</em></div>
    <div class="pin-side"><span>Germany</span>${pin.deDice.map(pinFace).join("")}<em>${esc(pin.de)}</em></div>
  </div>`;
}

function diceCombo(side) {
  if (state.initiative?.winner) return "";
  const label = comboLabel(state.players[side].dice);
  return label ? `<span class="quiet">${esc(label)}</span>` : "";
}

function formatName() {
  return { short: "Short battle", standard: "Standard battle", extended: "Extended battle" }[state.format] || "Battle";
}

function veilHtml() {
  if (state.mode !== "hotseat" || state.phase === "end" || ui.acked === actorSide() || !actorSide()) return "";
  const side = actorSide();
  const file = side === "de" ? "soldier-german.png" : "soldier-british.png";
  const name = labelSide(side);
  return `<div class="veil seat-screen" role="dialog" aria-modal="true" aria-label="Pass the seat"><div class="veil-card seat-card">
    <img class="seat-portrait" src="assets/${file}" alt="">
    <h2>${esc(name)}</h2>
    ${undoButton("veil-undo")}
    ${backControl()}
    <button type="button" class="primary" data-click="ready">I am ${esc(name)}</button>
  </div></div>`;
}

function helpHtml() {
  if (!ui.help) return "";
  return `<div class="modal"><div class="modal-card"><div class="rules">
    <h2>How to play</h2>
    <p>Two armies fight for the Objective Zone. Britain is on the left and advances to the right. Germany is on the right and advances to the left. A tank in a zone contests it, so nobody controls that ground.</p>
    <h3>The round</h3>
    <ul>
      <li>Both sides roll five action dice. That opening roll sets initiative. Wilds are ignored: they do not make a pair, a full house, or five of a kind. Five of a kind beats four, then a full house, three of a kind, two pair, one pair, then the highest face: Bayonet, Whistle, Shovel, Boot. If that comparison ties, both sides roll all five again and the tied roll is discarded. The roll-off does not use Roll 2 or Roll 3.</li>
      <li>General's Order, if played, happens after the opening roll and before initiative is fixed. It may reroll two dice or change one die to a natural face already showing. The dice after that card are the ones compared. Later rolls never change the result.</li>
      <li>The loser of initiative sets their dice first. Each side may take Roll 2 and Roll 3. On each of those rolls, any number of dice may be rerolled, including dice kept earlier. Then the winner of initiative acts through all seven steps before the loser.</li>
      <li>On your turn: Shock, tank movement, events, deployment, movement, cover, then attacks. Empty steps are skipped.</li>
      <li>At regroup, the side that eliminated more soldiers scores 1 VP. Each side may exchange up to two unused dice for soldiers in the trench, then draws one event. After rounds 3, 6, and 9, each side also draws a mission.</li>
      <li>Before the first round, each side places one cover token in Zone 1, Zone 2, or Zone 3 on its own side. Headquarters places its cover in Zone 1.</li>
      <li>Headquarters plays Easy, Hard, or Difficult. Hard is the standard opponent. Pass and play does not use a difficulty.</li>
      <li>A side completes at most one mission each round. If more than one is ready, that commander chooses which one scores. The others stay incomplete.</li>
    </ul>
    <h3>Dice</h3>
    <ul>
      <li>Boot — move one soldier or support weapon one zone. One Boot also advances a soldier from your trench into Zone 1.</li>
      <li>Shovel — dig one soldier into cover, leave cover, prepare a cover token, or relocate an empty one.</li>
      <li>Bayonet — select the bayonet dice to spend. One deploys a soldier from supply into a zone you control (once a round) or repairs one damage. Two deploys a mortar into Zone 1 if you control it and a mortar remains in supply. Each side has three mortars, three machine guns, and three tanks. Three deploys a machine gun onto a zone you control on your side if one remains in supply. Four deploys a tank into Zone 1 if one remains in supply.</li>
      <li>Whistle — play an event that was already in your hand. Regroup draws the next event, not a Whistle.</li>
      <li>Wild — copies one natural face when you commit. The die then shows that face and spends as if that symbol was rolled.</li>
    </ul>
    <h3>Fighting</h3>
    <ul>
      <li>Control is exposed soldiers 1, soldiers in cover 2, and an undamaged machine gun or mortar 2. One damage disables a machine gun or mortar. Tanks add nothing and contest every zone they occupy.</li>
      <li>Seizing the objective scores 2 VP. Seizing an enemy-side zone scores 1. A tank that enters the enemy trench scores 3 and goes back to supply. The side that caused more casualties scores 1 VP at the end of the round.</li>
      <li>Attack dice are even: 3 Hit faces and 3 Miss faces. Soldiers roll 1 against the same zone or the next one. Machine guns roll 3, or 4 against the objective, out to two zones, and cannot shoot tanks. A machine gun or mortar may move or attack, not both. Soldiers and machine guns may combine their dice on one target each can reach, while mortars and tanks shoot on their own. A mortar die shows enemy Zone 1, 2, or 3 and places 1 hit there. Tanks roll 3 dice at the same zone or the next one, or overrun cover unless an enemy tank has them engaged.</li>
      <li>Soldiers in cover can attack and be attacked. Hits on exposed soldiers eliminate them. Cover is face down until revealed. An attack destroys that cover when its hits at least equal the defense, and reveals it even when they do not. Hits beyond the defense eliminate soldiers inside. A soldier still inside when the cover is destroyed becomes exposed.</li>
      <li>Machine guns and mortars are destroyed at 2 damage. Tanks are destroyed at 3. Destroyed weapons return to supply.</li>
    </ul>
    <h3>Winning</h3>
    <p>When the rounds run out, or the mission deck is exhausted at the end of a round, the higher victory point total wins. A tie goes to whoever controls the objective, then to whoever holds more enemy zones.</p>
    <button type="button" class="primary" data-click="help">Back to the field</button>
  </div></div></div>`;
}

function splashHtml() {
  const choice = (key, value, label) => `<button type="button" class="choice ${setup[key] === value ? "on" : ""}" data-click="setup" data-key="${key}" data-value="${value}">${label}</button>`;
  const sideChoices = setup.mode === "hotseat" ? `<p class="quiet">Britain's trench is on the left. Germany's is on the right. Pass the seat when asked.</p>` : `<div class="choices">${choice("human", "uk", "Britain")}${choice("human", "de", "Germany")}</div>`;
  return `<div class="splash"><div class="splash-card">
    <div class="portraits"><div class="badge uk">${helmet("uk")}</div><div class="badge de">${helmet("de")}</div></div>
    <h1>Trench Shock</h1>
    <p class="game-version">${esc(versionLabel())}</p>
    <p class="lede">A World War I battle of dice, cover, and missions. Roll your action dice, push infantry across no man's land, and hold the Objective Zone.</p>
    <div class="field"><p>Length</p><div class="choices">${choice("format", "short", "Short · 8 rounds")}${choice("format", "standard", "Standard · 10")}${choice("format", "extended", "Extended · 12")}</div></div>
    <div class="field"><p>Opposition</p><div class="choices">${choice("mode", "solo", "Headquarters")}${choice("mode", "hotseat", "Pass and play")}</div></div>
    <div class="field"><p>${setup.mode === "hotseat" ? "The table" : "You command"}</p>${sideChoices}</div>
    ${setup.mode === "hotseat" ? "" : `<div class="field"><p>Difficulty</p><div class="choices">${choice("difficulty", "Easy", "Easy")}${choice("difficulty", "Hard", "Hard")}${choice("difficulty", "Difficult", "Difficult")}</div><p class="note">Headquarters plays this way. Hard is the standard opponent.</p></div>`}
    <div class="field"><p>Undo</p><div class="choices">${choice("undo", "off", "Off")}${choice("undo", "on", "On")}</div><p class="note">On lets you take back the previous action. In pass and play, that closes when the other commander takes the seat.</p></div>
    <button type="button" class="primary" data-click="begin">Begin battle</button>
    <button type="button" class="ghost" data-click="help" style="margin-left:8px">How to play</button>
    ${ui.help ? helpHtml() : ""}
  </div></div>`;
}

function coverPlaceHtml() {
  const side = coverAsk?.side === "de" ? "de" : "uk";
  const zones = sideZones(side);
  const names = zones.map((zone) => ZONE_LABELS[zone]);
  const choices = zones.map((zone) => `<button type="button" class="choice" data-click="cover-zone" data-zone="${zone}">${esc(ZONE_LABELS[zone])}</button>`).join("");
  const hq = setup.mode === "hotseat" ? "" : `<p class="note">Headquarters places its own cover in Zone 1.</p>`;
  return `<div class="splash"><div class="splash-card">
    <div class="portraits"><div class="badge uk">${helmet("uk")}</div><div class="badge de">${helmet("de")}</div></div>
    <h1>Starting cover</h1>
    <p class="lede">${esc(labelSide(side))}: place your starting cover in ${esc(names[0])}, ${esc(names[1])}, or ${esc(names[2])}.</p>
    <div class="choices">${choices}</div>
    ${hq}
    <button type="button" class="ghost" data-click="cover-back">Back</button>
    <button type="button" class="ghost" data-click="help" style="margin-left:8px">How to play</button>
    ${ui.help ? helpHtml() : ""}
  </div></div>`;
}

function launchBattle(coverZones) {
  clearMissionCelebration();
  clearEmptyTimer();
  ui = freshUi();
  history = [];
  leaveAsk = null;
  stepReturn = null;
  actionUndo = null;
  attackDraft = null;
  holdEmpty = null;
  emptyMemo = null;
  paused = false;
  menuOpen = false;
  menuConfirm = null;
  menuNote = "";
  savedStamp = null;
  coverAsk = null;
  resetPresentation();
  coverMemory = null;
  state = startMatch(catalog.events, catalog.missions, {
    format: setup.format,
    human: setup.mode === "hotseat" ? "uk" : setup.human,
    mode: setup.mode,
    difficulty: setup.mode === "solo" ? setup.difficulty : null,
    coverZones,
  });
  ensureMatchId(state);
  noteBattleOutcome(state);
  tumbleFreshDice(state);
  render();
}

function onClick(event) {
  if (killToast || missionToast) {
    event.preventDefault();
    event.stopPropagation();
    if (killToast) dismissKill();
    else dismissMission();
    return;
  }
  const el = event.target.closest("[data-click]");
  if (!el) return;
  const kind = el.dataset.click;
  if (handleMenu(kind)) return;
  if (kind === "leave-yes") {
    confirmLeave();
    return;
  }
  if (kind === "leave-no") {
    stayOnStep();
    return;
  }
  if (kind === "back-step") {
    backToSkipped();
    return;
  }
  if (leaveAsk || paused) return;
  if (kind === "setup") {
    setup[el.dataset.key] = el.dataset.value;
    render();
    return;
  }
  if (kind === "help") {
    ui.help = !ui.help;
    render();
    return;
  }
  if (kind === "new") {
    if (unsavedBattle()) {
      menuOpen = true;
      menuConfirm = "new";
      menuNote = "";
      render();
      return;
    }
    leaveToSetup();
    return;
  }
  if (kind === "undo") {
    undoLast();
    return;
  }
  if (kind === "undo-action") {
    undoLastAction();
    return;
  }
  if (kind === "begin") {
    coverAsk = { side: setup.mode === "hotseat" ? "uk" : setup.human, uk: null, de: null };
    ui.help = false;
    render();
    return;
  }
  if (kind === "cover-back") {
    coverAsk = null;
    render();
    return;
  }
  if (kind === "cover-zone" && coverAsk) {
    const zone = el.dataset.zone;
    const side = coverAsk.side === "de" ? "de" : "uk";
    if (!sideZones(side).includes(zone)) return;
    coverAsk[side] = zone;
    if (setup.mode === "hotseat" && side === "uk") {
      coverAsk.side = "de";
      render();
      return;
    }
    const coverZones = setup.mode === "hotseat"
      ? { uk: coverAsk.uk, de: coverAsk.de }
      : { [setup.human]: zone };
    launchBattle(coverZones);
    return;
  }
  if (!state) return;
  if (kind === "ready") {
    history = [];
    leaveAsk = null;
    stepReturn = null;
    ui.acked = actorSide();
    render();
    return;
  }
  if (kind === "tab") {
    ui.tab = el.dataset.tab;
    render();
    return;
  }
  if (kind === "act") {
    buttons[Number(el.dataset.i)]?.run();
    return;
  }
  if (kind === "wild") {
    ui.wildAs = el.dataset.value;
    render();
    return;
  }
  if (kind === "dir") {
    ui.dir = el.dataset.value;
    render();
    return;
  }
  if (kind === "support") {
    ui.supportType = el.dataset.value;
    render();
    return;
  }
  if (kind === "target-kind") {
    ui.targetKind = el.dataset.value;
    render();
    return;
  }
  if (!myTurn()) return;
  if (kind === "soldier") return clickSoldier(el.dataset.id);
  if (kind === "cover") return clickCover(el.dataset.id);
  if (kind === "unit") return clickUnit(el.dataset.id);
  if (kind === "zone") return clickZone(el.dataset.id);
  if (kind === "card") {
    ui.card = ui.card === el.dataset.id ? null : el.dataset.id;
    if (selectedCard()?.title !== "Patrol") ui.dir = "forward";
    render();
    return;
  }
  if (kind === "die") return clickDie(el.dataset.side, Number(el.dataset.index));
}

function clickSoldier(id) {
  if (state.pending?.type === "allocate-hits") {
    if ((state.pending.options || []).length > 1) clickAllocTarget(id);
    return;
  }
  const soldier = state.soldiers.find((s) => s.id === id);
  if (!soldier) return;
  const me = viewer();
  if (state.actionStep === "move" && soldier.owner !== me) {
    clickZone(soldier.loc);
    return;
  }
  if (soldier.owner !== me) {
    ui.enemy = ui.enemy === id ? null : id;
    ui.zone = soldier.loc;
  } else if (state.actionStep === "event" && (selectedCard()?.title === "Bayonet Charge" || selectedCard()?.title === "Charge")) {
    const title = selectedCard().title;
    const current = ui.soldiers
      .map((sid) => state.soldiers.find((s) => s.id === sid && s.owner === me))
      .filter(Boolean);
    if (!current.length || current.some((s) => s.loc !== soldier.loc)) ui.soldiers = [id];
    else if (ui.soldiers.includes(id)) ui.soldiers = ui.soldiers.filter((x) => x !== id);
    else if (ui.soldiers.length >= 3) ui.soldiers = [...ui.soldiers.slice(0, 2), id];
    else ui.soldiers = [...ui.soldiers, id];
    if (title === "Bayonet Charge") {
      const options = bayonetDestinations(state, me, soldier.loc);
      if (!options.includes(ui.zone)) ui.zone = options.includes(stepZone(me, soldier.loc, "forward"))
        ? stepZone(me, soldier.loc, "forward")
        : (options[0] || null);
    } else {
      ui.dir = "forward";
      ui.zone = stepZone(me, soldier.loc, "forward");
    }
  } else if (state.actionStep === "attack" || state.actionStep === "event") {
    ui.soldiers = ui.soldiers.includes(id) ? ui.soldiers.filter((x) => x !== id) : [...ui.soldiers, id];
    ui.zone = ui.zone || soldier.loc;
  } else {
    ui.soldiers = ui.soldiers[0] === id ? [] : [id];
    ui.unit = null;
    if (state.actionStep === "cover" && ui.soldiers.length) {
      ui.zone = soldier.loc;
      const open = state.covers.filter((c) => coverFits(me, soldier, c));
      if (open.length === 1) ui.cover = open[0].id;
    }
  }
  render();
}

function clickCover(id) {
  if (state.pending?.type === "allocate-hits") {
    if ((state.pending.options || []).length > 1) clickAllocTarget(id);
    return;
  }
  ui.cover = ui.cover === id ? null : id;
  const cover = state.covers.find((c) => c.id === id);
  if (cover) ui.zone = cover.loc;
  render();
}

function clickUnit(id) {
  if (state.pending?.type === "allocate-hits") {
    if ((state.pending.options || []).length > 1) clickAllocTarget(id);
    return;
  }
  const unit = state.equipment.find((u) => u.id === id);
  if (!unit) return;
  const mine = unit.owner === viewer();
  if (mine && state.actionStep === "attack") {
    ui.unit = ui.unit === id ? null : id;
    if (!ui.zone) ui.zone = unit.loc;
    render();
    return;
  }
  ui.zone = unit.loc;
  if (mine) {
    ui.unit = ui.unit === id ? null : id;
    ui.soldiers = [];
  } else {
    ui.targetUnit = ui.targetUnit === id ? null : id;
  }
  render();
}

function clickZone(id) {
  const me = viewer();
  if (state.phase === "action" && state.actionStep === "event") {
    const card = selectedCard();
    const opened = state.players[me].eventsAtStep;
    const picked = chargeSelection(me);
    if (card && picked && (!opened || opened.includes(card.inst))) {
      if (card.title === "Bayonet Charge" && bayonetDestinations(state, me, picked[0].loc).includes(id)) {
        commit({
          type: "PLAY_EVENT",
          cardInst: card.inst,
          params: { ...eventParams(), soldierIds: picked.map((s) => s.id), zone: id },
        });
        return;
      }
      if (card.title === "Charge" && isBattlefield(picked[0].loc) && id === stepZone(me, picked[0].loc, "forward")) {
        commit({
          type: "PLAY_EVENT",
          cardInst: card.inst,
          params: { ...eventParams(), soldierIds: picked.map((s) => s.id), zone: id, dir: "forward" },
        });
        return;
      }
    }
  }
  if (state.phase === "action" && state.actionStep === "move") {
    const soldier = state.soldiers.find((s) => s.id === ui.soldiers[0] && s.owner === me);
    if (soldier) {
      const forward = stepZone(me, soldier.loc, "forward");
      const back = stepZone(me, soldier.loc, "back");
      if (id === forward || id === back) {
        const dir = id === forward ? "forward" : "back";
        commit(soldier.coverId
          ? { type: "LEAVE_COVER_THEN_MOVE", unitId: soldier.id, dir, kind: "soldier" }
          : { type: "MOVE_UNIT", kind: "soldier", unitId: soldier.id, dir });
        return;
      }
    }
    const unit = state.equipment.find((u) => u.id === ui.unit && u.owner === me && u.type !== "tank");
    if (unit) {
      const forward = stepZone(me, unit.loc, "forward");
      const back = stepZone(me, unit.loc, "back");
      if (id === forward || id === back) {
        commit({ type: "MOVE_UNIT", kind: "weapon", unitId: unit.id, dir: id === forward ? "forward" : "back" });
        return;
      }
    }
  }
  ui.zone = id;
  render();
}

function clickDie(side, index) {
  const me = viewer();
  if (state.phase === "action" && state.actionStep === "deploy" && side === me) {
    if (!bayonetChoice(me, index)) return;
    const current = ui.dice.map(Number);
    ui.dice = current.includes(index) ? current.filter((i) => i !== index) : [...current, index];
    render();
    return;
  }
  if (state.phase === "reroll" && state.active === me && side === me) {
    commit({ type: "TOGGLE_KEEP", side: me, index }, { keepUi: true });
    return;
  }
  if (state.pending?.type === "generals-order" && ui.order === "yes" && side === me) {
    ui.dice = ui.dice.includes(index) ? ui.dice.filter((i) => i !== index) : [...ui.dice, index].slice(-2);
    render();
    return;
  }
  if (side !== me && selectedCard()?.title === "Sabotage") {
    ui.dieIndex = index;
    render();
  }
}

async function boot() {
  const root = document.getElementById("app");
  root.addEventListener("click", onClick);
  root.addEventListener("pointerover", (event) => {
    const el = event.target.closest("[data-tip]");
    if (el) showCardTip(el);
  });
  root.addEventListener("pointerout", (event) => {
    const el = event.target.closest("[data-tip]");
    if (!el) return;
    const next = event.relatedTarget?.closest?.("[data-tip]");
    if (next !== el) hideCardTip();
  });
  try {
    const url = (name) => new URL(`../data/${name}`, import.meta.url);
    const [events, missions] = await Promise.all([
      fetch(url("events.json")).then((r) => r.json()),
      fetch(url("missions.json")).then((r) => r.json()),
    ]);
    catalog = { events, missions };
  } catch (err) {
    root.innerHTML = `<div class="splash"><div class="splash-card"><h1>Trench Shock</h1><p class="lede">The game files need to be served over http. Run start.bat in this folder, then open http://127.0.0.1:8080.</p></div></div>`;
    return;
  }
  document.addEventListener("keydown", onMenuKey);
  if (new URLSearchParams(location.search).has("sim")) {
    const result = simulateGames(catalog.events, catalog.missions, 20);
    root.innerHTML = `<pre class="sim">${esc(JSON.stringify(result, null, 2))}</pre>`;
    return;
  }
  const updateNote = takeUpdateNote();
  if (updateNote) {
    menuOpen = true;
    menuConfirm = null;
    menuLink = "";
    menuNote = updateNote;
  }
  render();
}

boot();
