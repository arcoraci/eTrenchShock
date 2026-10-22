export const SIDES = ["uk", "de"];

export const ZONES = ["ukTrench", "uk1", "uk2", "uk3", "obj", "de3", "de2", "de1", "deTrench"];
export const BATTLEFIELD = ["uk1", "uk2", "uk3", "obj", "de3", "de2", "de1"];
export const UK_SIDE = ["uk1", "uk2", "uk3"];
export const DE_SIDE = ["de1", "de2", "de3"];

export const ACTION_FACES = ["boot", "boot", "whistle", "wild", "shovel", "bayonet"];
export const ATTACK_FACES = ["hit", "hit", "hit", "miss", "miss", "miss"];
export const MORTAR_FACES = ["z1", "z1", "z2", "z2", "z3", "z3"];

export const SYMBOL_RANK = { bayonet: 4, whistle: 3, shovel: 2, boot: 1 };
export const COMBO_RANK = {
  five: 6,
  four: 5,
  fullHouse: 4,
  three: 3,
  twoPair: 2,
  pair: 1,
  none: 0,
};

export const FORMATS = {
  short: { rounds: 8, missions: 10, remove: 6 },
  standard: { rounds: 10, missions: 12, remove: 4 },
  extended: { rounds: 12, missions: 16, remove: 0 },
};

export const ZONE_LABELS = {
  ukTrench: "British Trench",
  uk1: "British Zone 1",
  uk2: "British Zone 2",
  uk3: "British Zone 3",
  obj: "Objective Zone",
  de3: "German Zone 3",
  de2: "German Zone 2",
  de1: "German Zone 1",
  deTrench: "German Trench",
};

export const FACE_LABELS = {
  boot: "Boot",
  whistle: "Whistle",
  wild: "Wild",
  shovel: "Shovel",
  bayonet: "Bayonet",
  hit: "Hit",
  miss: "Miss",
  blank: "Blank",
};

let nextId = 1;

export function uid(prefix = "id") {
  const value = `${prefix}-${nextId}`;
  nextId += 1;
  return value;
}

export function resetIds(n = 1) {
  nextId = n;
}

export function nextSeed(state) {
  state.seed = (Math.imul(state.seed >>> 0, 1664525) + 1013904223) >>> 0;
  return state.seed;
}

export function rng(state) {
  return nextSeed(state) / 0xffffffff;
}

export function shuffle(state, list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng(state) * (i + 1));
    const swap = arr[i];
    arr[i] = arr[j];
    arr[j] = swap;
  }
  return arr;
}

export function rollFace(state, faces) {
  return faces[Math.floor(rng(state) * faces.length) % faces.length];
}

export function other(side) {
  return side === "uk" ? "de" : "uk";
}

export function sideZones(side) {
  return side === "uk" ? UK_SIDE : DE_SIDE;
}

export function enemySideZones(side) {
  return side === "uk" ? DE_SIDE : UK_SIDE;
}

export function ownZone1(side) {
  return side === "uk" ? "uk1" : "de1";
}

export function ownTrench(side) {
  return side === "uk" ? "ukTrench" : "deTrench";
}

export function enemyTrench(side) {
  return side === "uk" ? "deTrench" : "ukTrench";
}

export function forwardPath(side) {
  if (side === "uk") return ["ukTrench", "uk1", "uk2", "uk3", "obj", "de3", "de2", "de1", "deTrench"];
  return ["deTrench", "de1", "de2", "de3", "obj", "uk3", "uk2", "uk1", "ukTrench"];
}

export function stepZone(side, zone, direction) {
  const path = forwardPath(side);
  const i = path.indexOf(zone);
  if (i < 0) return null;
  const j = direction === "forward" ? i + 1 : i - 1;
  if (j < 0 || j >= path.length) return null;
  return path[j];
}

export function zoneDistance(a, b) {
  const ia = BATTLEFIELD.indexOf(a);
  const ib = BATTLEFIELD.indexOf(b);
  if (ia < 0 || ib < 0) return 99;
  return Math.abs(ia - ib);
}

export function isBattlefield(zone) {
  return BATTLEFIELD.includes(zone);
}

export function clone(state) {
  return structuredClone(state);
}

export function pushFx(state, beat) {
  if (!state || !beat?.kind) return;
  if (!Array.isArray(state.fx)) state.fx = [];
  const id = (state.fxSeq || 0) + 1;
  state.fxSeq = id;
  state.fx.push({ id, ...beat });
  if (state.fx.length > 48) state.fx.splice(0, state.fx.length - 48);
}

export function presentFx(beats, reduced) {
  const list = Array.isArray(beats) ? beats.filter((beat) => beat && beat.kind) : [];
  if (!reduced) return list.map((beat) => ({ ...beat, motion: true }));
  return list.filter((beat) => beat.kind === "mortar").map((beat) => ({ ...beat, motion: false }));
}

export function log(state, text) {
  state.log.unshift({ round: state.round, text });
  if (state.log.length > 80) state.log.length = 80;
}

export function pushRoundBrief(state, text) {
  if (!state || !text) return;
  if (!Array.isArray(state.roundBrief)) state.roundBrief = [];
  const round = state.round || 1;
  if (state.roundBrief.some((line) => line.round === round && line.text === text)) return;
  state.roundBrief.push({ round, text });
  state.roundBrief = state.roundBrief.filter((line) => line.round >= round - 1).slice(-16);
}

export function noteMoved(state, side, id) {
  const player = state.players?.[side];
  if (!player || !id) return;
  if (!Array.isArray(player.movedIds)) player.movedIds = [];
  if (!player.movedIds.includes(id)) player.movedIds.push(id);
}

export function soldiersIn(state, zone, opts = {}) {
  const { side = null, exposed = null, coverId = null, matchCover = false } = opts;
  return state.soldiers.filter((s) => {
    if (s.loc !== zone) return false;
    if (side && s.owner !== side) return false;
    if (exposed === true && s.coverId) return false;
    if (exposed === false && !s.coverId) return false;
    if (matchCover && s.coverId !== coverId) return false;
    return true;
  });
}

export function unitsIn(state, zone, opts = {}) {
  const { side = null, type = null } = opts;
  return state.equipment.filter((u) => {
    if (u.loc !== zone) return false;
    if (side && u.owner !== side) return false;
    if (type && u.type !== type) return false;
    return true;
  });
}

export function coversIn(state, zone) {
  return state.covers.filter((c) => c.loc === zone && !c.destroyed);
}

export function controlValue(state, zone, side) {
  if (!isBattlefield(zone)) return 0;
  let n = 0;
  for (const s of soldiersIn(state, zone, { side })) n += s.coverId ? 2 : 1;
  for (const u of unitsIn(state, zone, { side })) {
    if (u.type === "tank") continue;
    if (u.damage >= 1) continue;
    n += 2;
  }
  return n;
}

export function isContested(state, zone) {
  return unitsIn(state, zone).some((u) => u.type === "tank");
}

export function controllerOf(state, zone) {
  if (!isBattlefield(zone) || isContested(state, zone)) return null;
  const uk = controlValue(state, zone, "uk");
  const de = controlValue(state, zone, "de");
  if (uk > de) return "uk";
  if (de > uk) return "de";
  return null;
}

export function labelSide(side) {
  return side === "uk" ? "Britain" : "Germany";
}

export function capType(type) {
  return { mg: "Machine Gun", mortar: "Mortar", tank: "Tank" }[type] || type;
}

export function refreshControl(state, opts = {}) {
  const before = {};
  const contested = {};
  for (const zone of BATTLEFIELD) {
    before[zone] = controllerOf(state, zone);
    contested[zone] = isContested(state, zone);
  }
  for (const zone of BATTLEFIELD) {
    const now = contested[zone] ? null : before[zone];
    const prevStored = state.control[zone];
    if (now && now !== prevStored) {
      const gainedOnlyBecauseTankLeft = Boolean(opts.tankLeft) && state.hadTank[zone];
      if (!gainedOnlyBecauseTankLeft) {
        const last = state.territoryOwner[zone];
        if (last !== now) {
          if (zone === "obj") {
            state.vp[now] += 2;
            log(state, `${labelSide(now)} gains the Objective Zone (+2 VP).`);
          } else if (enemySideZones(now).includes(zone)) {
            state.vp[now] += 1;
            log(state, `${labelSide(now)} takes ${ZONE_LABELS[zone]} (+1 VP).`);
          }
          state.territoryOwner[zone] = now;
        }
      }
    }
    state.control[zone] = now;
    state.hadTank[zone] = contested[zone];
  }
}

export function smoked(state, from, to) {
  if (!from || !to || from === to) return false;
  const smoke = state.effects?.smoke || [];
  return smoke.includes(from) || smoke.includes(to);
}

export function canSoldierTarget(soldier, target) {
  if (target?.kind === "tank") return soldier.loc === target.zone;
  return zoneDistance(soldier.loc, target?.zone) <= 1;
}

export function soldierMayFire(soldier, attackedIds = []) {
  if (!soldier || soldier.type) return false;
  if (!isBattlefield(soldier.loc)) return false;
  if (attackedIds.includes(soldier.id)) return false;
  return true;
}

export function soldierStrikeTargets(state, side, zone) {
  if (!isBattlefield(zone)) return [];
  const foe = other(side);
  const targets = [];
  if (soldiersIn(state, zone, { side: foe, exposed: true }).length) {
    targets.push({ kind: "exposed", zone });
  }
  for (const cover of coversIn(state, zone)) {
    const inside = soldiersIn(state, zone, { matchCover: true, coverId: cover.id });
    if (inside.some((soldier) => soldier.owner === foe)) {
      targets.push({ kind: "cover", zone, coverId: cover.id });
    }
  }
  return targets;
}

export function infantryFireOffers(state, side, soldierIds, zone) {
  const attacked = state.players?.[side]?.attackedIds || [];
  const fresh = [];
  for (const id of soldierIds || []) {
    const soldier = state.soldiers.find((s) => s.id === id && s.owner === side);
    if (soldierMayFire(soldier, attacked)) fresh.push(soldier);
  }
  if (!fresh.length || !isBattlefield(zone)) return [];
  const offers = [];
  for (const target of soldierStrikeTargets(state, side, zone)) {
    const firing = fresh.filter((soldier) => canSoldierTarget(soldier, target));
    if (!firing.length) continue;
    offers.push({
      attackerIds: firing.map((soldier) => soldier.id),
      target: {
        kind: target.kind,
        zone: target.zone,
        coverId: target.coverId || null,
      },
    });
  }
  return offers;
}

export function machineGunOperational(state, unit) {
  if (!unit || unit.type !== "mg" || !isBattlefield(unit.loc) || unit.damage >= 1) return false;
  const player = state.players?.[unit.owner];
  if (!player) return false;
  if (player.attackedIds.includes(unit.id) || player.movedEquip.includes(unit.id)) return false;
  if (state.effects?.suppression === "mg" && unit.owner !== state.effects.suppressionBy) return false;
  return true;
}

export function machineGunTargets(state, unit) {
  if (!unit || unit.type !== "mg" || !isBattlefield(unit.loc)) return [];
  const foe = other(unit.owner);
  const targets = [];
  for (const zone of BATTLEFIELD) {
    const dist = zoneDistance(unit.loc, zone);
    if (dist > 2) continue;
    if (smoked(state, unit.loc, zone)) continue;
    if (soldiersIn(state, zone, { side: foe, exposed: true }).length) {
      targets.push({ kind: "exposed", zone, dist });
    }
    for (const cover of coversIn(state, zone)) {
      const inside = soldiersIn(state, zone, { matchCover: true, coverId: cover.id });
      if (inside.some((s) => s.owner === foe)) targets.push({ kind: "cover", zone, coverId: cover.id, dist });
      else if (!inside.length) targets.push({ kind: "cover-empty", zone, coverId: cover.id, dist });
    }
    for (const gear of unitsIn(state, zone, { side: foe })) {
      if (gear.type === "mg" || gear.type === "mortar") {
        targets.push({ kind: gear.type, zone, unitId: gear.id, dist });
      }
    }
  }
  return targets;
}
