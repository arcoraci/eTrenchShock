import {
  log,
  labelSide,
  other,
  ownTrench,
  soldiersIn,
  coversIn,
  controllerOf,
  isBattlefield,
  stepZone,
  zoneDistance,
  enemyTrench,
  ZONE_LABELS,
  refreshControl,
  nextSeed,
} from "./core.js";
import { rollHits, remaining } from "./dice.js";
import { applyHits, eliminateSoldier } from "./combat.js";
import { drawMission, trimMissions } from "./missions.js";

const HOSTILE = new Set(["Bayonet Charge", "Bombing Run", "Heavy Barrage", "Sniper", "Trench Fever"]);

export function eventNeeds(title) {
  return {
    Reinforce: [],
    Patrol: ["zone", "soldiers"],
    Charge: ["zone", "soldiers"],
    "Bayonet Charge": ["zone", "soldiers"],
    "Bogged Down": [],
    "Bombing Run": ["zone"],
    "Carrier Pigeon": [],
    "Cavalry Charge": [],
    "Christmas Truce": [],
    Entrench: ["soldiers", "covers"],
    Espionage: [],
    "Field Hospital": [],
    "Field Repairs": ["friendlyEquip"],
    "Heavy Barrage": ["enemyZone"],
    Mobility: ["friendlyMortar"],
    "Precision Barrage": ["friendlyMortar"],
    Raid: ["zone", "soldiers"],
    "Recon Flight": ["zone"],
    Sabotage: ["enemyDie"],
    Scout: ["enemyCover"],
    "Smoke Screen": ["zone"],
    Sniper: ["enemySoldier"],
    Spotter: ["friendlyMortar"],
    Suppression: ["supportType"],
    "Trench Fever": ["zone"],
    "Trench Foot": [],
    "Armored Advance": ["friendlyTank"],
    Tunnel: ["soldiers", "controlledZone"],
  }[title] || [];
}

export function discardEvent(state, side, inst) {
  const hand = state.players[side].eventHand;
  const i = hand.findIndex((c) => c.inst === inst);
  if (i >= 0) state.eventDiscard.push(hand.splice(i, 1)[0]);
}

export function playEvent(state, side, card, params = {}) {
  const fn = TABLE[card.title];
  if (!fn) {
    log(state, `${card.title} is not implemented yet.`);
    return;
  }
  if (state.effects.christmasTruce && HOSTILE.has(card.title)) {
    throw new Error("Christmas Truce: that Event cannot cause casualties.");
  }
  log(state, `${labelSide(side)} plays ${card.title}.`);
  fn(state, side, params || {}, card);
}

function soldiersById(state, side, ids) {
  return (ids || [])
    .map((id) => state.soldiers.find((s) => s.id === id && s.owner === side))
    .filter(Boolean);
}

function footLocked(state, side) {
  return Boolean(state.effects.trenchFoot && side !== state.effects.trenchFootBy);
}

function moveGroup(state, side, params, maximum, allowBack) {
  if (footLocked(state, side)) throw new Error("Trench Foot prevents Soldier movement.");
  const direction = params.dir || "forward";
  if (!allowBack && direction !== "forward") throw new Error("Charge is forward only.");
  const soldiers = soldiersById(state, side, (params.soldierIds || []).slice(0, maximum));
  if (!soldiers.length) throw new Error("Choose soldiers for this Event.");
  const origin = soldiers[0].loc;
  if (soldiers.some((s) => s.loc !== origin)) throw new Error("Choose soldiers in the same zone.");
  if (!isBattlefield(origin)) throw new Error("Cannot move from the Trench with this Event.");
  const dest = stepZone(side, origin, direction);
  if (!dest || !isBattlefield(dest)) throw new Error("Illegal destination.");
  for (const s of soldiers) {
    s.coverId = null;
    s.loc = dest;
  }
  log(state, `${soldiers.length} Soldier(s) move to ${ZONE_LABELS[dest]}.`);
}

export function bayonetDestinations(state, side, origin) {
  if (!isBattlefield(origin) || controllerOf(state, origin) !== side) return [];
  const found = [];
  for (const dir of ["forward", "back"]) {
    const dest = stepZone(side, origin, dir);
    if (dest && isBattlefield(dest) && controllerOf(state, dest) === other(side)) found.push(dest);
  }
  return found;
}

function reinforce(state, side) {
  const avail = state.soldiers.filter((s) => s.owner === side && s.loc === "available");
  const trench = ownTrench(side);
  let room = 5 - state.soldiers.filter((s) => s.owner === side && s.loc === trench).length;
  let n = 0;
  for (const s of avail) {
    if (room <= 0 || n >= 3) break;
    s.loc = trench;
    room -= 1;
    n += 1;
  }
  log(state, `${n} Soldier(s) enter the Trench reinforcement area.`);
}

function bayonetCharge(state, side, params) {
  if (footLocked(state, side)) throw new Error("Trench Foot prevents Soldier movement.");
  const soldiers = soldiersById(state, side, (params.soldierIds || []).slice(0, 3));
  if (!soldiers.length) throw new Error("Choose soldiers for Bayonet Charge.");
  const origin = soldiers[0].loc;
  if (soldiers.some((s) => s.loc !== origin)) throw new Error("Choose soldiers in the same zone.");
  const options = bayonetDestinations(state, side, origin);
  if (!options.length) {
    if (!isBattlefield(origin) || controllerOf(state, origin) !== side) {
      throw new Error("Must start in a friendly-controlled zone.");
    }
    throw new Error("Must charge into an adjacent enemy-controlled zone.");
  }
  let dest = null;
  if (options.includes(params.zone)) dest = params.zone;
  else if (params.zone && params.zone !== origin && isBattlefield(params.zone)) {
    throw new Error("Must charge into an adjacent enemy-controlled zone.");
  } else {
    const forward = stepZone(side, origin, "forward");
    dest = options.includes(forward) ? forward : options[0];
  }
  for (const s of soldiers) {
    s.coverId = null;
    s.loc = dest;
  }
  log(state, `${soldiers.length} Soldier(s) charge into ${ZONE_LABELS[dest]}.`);
  const first = rollHits(state, soldiers.length);
  const reroll = rollHits(state, first.faces.filter((f) => f === "miss").length);
  const total = first.hits + reroll.hits;
  log(state, `Bayonet Charge: ${soldiers.length} dice, reroll misses → ${total} Hit(s).`);
  applyHits(state, side, { kind: "exposed", zone: dest }, total);
  for (const s of soldiers) state.players[side].attackedIds.push(s.id);
}

function bombingRun(state, side, params) {
  const zone = params.zone;
  if (!isBattlefield(zone)) throw new Error("Choose a battlefield zone.");
  const foe = other(side);
  const targets = soldiersIn(state, zone, { side: foe });
  const result = rollHits(state, targets.length);
  log(state, `Bombing Run rolls ${targets.length} dice → ${result.hits} Hit(s).`);
  applyHits(state, side, {
    kind: params.targetKind || "exposed",
    zone,
    coverId: params.coverId,
    unitId: params.unitId,
  }, result.hits);
}

function carrierPigeon(state, side) {
  const mission = drawMission(state, true);
  if (mission) state.players[side].missionHand.push(mission);
  trimMissions(state, side);
}

function entrench(state, side, params) {
  const trench = ownTrench(side);
  const ids = (params.soldierIds || []).slice(0, 3);
  const cover = state.covers.find((c) => c.id === params.coverId && !c.destroyed);
  if (!cover) throw new Error("Choose a Cover position.");
  if (controllerOf(state, cover.loc) !== side) throw new Error("That Cover is not in a zone you control.");
  let n = 0;
  for (const id of ids) {
    const s = state.soldiers.find((x) => x.id === id && x.owner === side && x.loc === trench);
    if (!s) continue;
    const occ = soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id });
    if (occ.length >= 3 || occ.some((o) => o.owner !== side)) continue;
    s.loc = cover.loc;
    s.coverId = cover.id;
    n += 1;
  }
  if (!n) throw new Error("No trench soldiers could enter that Cover.");
  log(state, `${n} Soldier(s) entrench.`);
  refreshControl(state);
}

function espionage(state, side) {
  const foe = state.players[other(side)].eventHand;
  if (!foe.length) {
    log(state, "Opponent has no Events.");
    return;
  }
  const seed = nextSeed(state);
  const i = Math.floor((seed / 0xffffffff) * foe.length) % foe.length;
  const taken = foe.splice(i, 1)[0];
  if (state.players[side].eventHand.length < 7) state.players[side].eventHand.push(taken);
  else state.eventDiscard.push(taken);
  log(state, `${labelSide(side)} steals ${taken.title}.`);
}

function fieldHospital(state, side) {
  const trench = ownTrench(side);
  let room = 5 - state.soldiers.filter((s) => s.owner === side && s.loc === trench).length;
  const cas = state.soldiers.filter((s) => s.owner === side && s.loc === "casualties" && !s.overflow);
  let n = 0;
  for (const s of cas) {
    if (n >= 3 || room <= 0) break;
    s.loc = trench;
    room -= 1;
    n += 1;
  }
  log(state, `Field Hospital returns ${n} Soldier(s).`);
}

function fieldRepairs(state, side, params) {
  const unit = state.equipment.find((e) => e.id === params.unitId && e.owner === side);
  if (!unit || unit.damage < 1) throw new Error("Choose a damaged friendly Unit.");
  const n = unit.type === "tank" ? Math.min(2, unit.damage) : 1;
  unit.damage -= n;
  log(state, `Field Repairs removes ${n} Damage from the ${unit.type}.`);
}

function heavyBarrage(state, side, params) {
  const zone = params.zone;
  if (controllerOf(state, zone) !== other(side)) throw new Error("Must target an enemy-controlled zone.");
  applyHits(state, side, {
    kind: params.targetKind || "exposed",
    zone,
    coverId: params.coverId,
    unitId: params.unitId,
  }, 3);
}

function markMortar(state, side, params, key) {
  const unit = state.equipment.find(
    (e) => e.id === params.unitId && e.type === "mortar" && e.owner === side && e.damage < 1,
  );
  if (!unit) throw new Error("Choose an undamaged Mortar.");
  state.effects[key].push(unit.id);
  log(state, `${labelSide(side)} marks a Mortar for ${key}.`);
}

function raid(state, side, params) {
  const soldiers = soldiersById(state, side, (params.soldierIds || []).slice(0, 2));
  if (!soldiers.length) throw new Error("Choose soldiers for Raid.");
  const origin = soldiers[0].loc;
  if (soldiers.some((s) => s.loc !== origin)) throw new Error("Choose soldiers in the same zone.");
  if (controllerOf(state, origin) !== side) throw new Error("Raid starts in a zone you control.");
  const dest = stepZone(side, origin, "forward");
  if (!dest || !isBattlefield(dest)) throw new Error("Illegal destination.");
  for (const s of soldiers) {
    s.loc = dest;
    s.coverId = null;
  }
  let cover = null;
  for (const c of coversIn(state, dest)) {
    const occ = soldiersIn(state, dest, { matchCover: true, coverId: c.id });
    if (occ.length < 3 && !occ.some((o) => o.owner !== side)) {
      cover = c;
      break;
    }
  }
  if (cover) {
    for (const s of soldiers) {
      const occ = soldiersIn(state, dest, { matchCover: true, coverId: cover.id });
      if (occ.length < 3) s.coverId = cover.id;
    }
  }
  log(state, `${soldiers.length} Soldier(s) raid ${ZONE_LABELS[dest]}.`);
}

function reconFlight(state, params) {
  if (!isBattlefield(params.zone)) throw new Error("Choose a battlefield zone.");
  const covers = coversIn(state, params.zone);
  for (const c of covers) c.revealed = true;
  log(state, covers.length ? `${covers.length} Cover position(s) revealed.` : "No Cover there.");
}

function sabotage(state, side, params) {
  const foe = other(side);
  const dice = state.players[foe].dice;
  const i = params.dieIndex;
  if (i == null || i < 0 || i >= dice.length) throw new Error("Choose an enemy Action Die.");
  const face = dice[i];
  if (!face) throw new Error("That die is already gone.");
  const bucket = face === "wild" ? state.players[foe].wildAs : face;
  if (!bucket || remaining(state, foe, bucket) < 1) throw new Error("That die is already used.");
  dice[i] = null;
  state.effects.stolenDie = { owner: side, face, from: foe };
  log(state, `${labelSide(side)} steals a ${face} die.`);
}

function scout(state, side, params) {
  const cover = state.covers.find((c) => c.id === params.coverId && !c.destroyed);
  if (!cover) throw new Error("Choose an enemy Cover.");
  const near = state.soldiers.some(
    (s) => s.owner === side && isBattlefield(s.loc) && zoneDistance(s.loc, cover.loc) <= 1,
  );
  if (!near) throw new Error("Need a Soldier in or adjacent to that zone.");
  cover.revealed = true;
  const occ = soldiersIn(state, cover.loc, { side: other(side), matchCover: true, coverId: cover.id });
  if (occ.length) {
    occ[0].coverId = null;
    log(state, "Scout reveals the Cover and drives one Soldier into the open.");
  } else {
    log(state, `Scout reveals Cover Defense ${cover.defense}.`);
  }
}

function smokeScreen(state, params) {
  if (!isBattlefield(params.zone)) throw new Error("Choose a battlefield zone.");
  state.effects.smoke.push(params.zone);
  log(state, `Smoke fills ${ZONE_LABELS[params.zone]}.`);
}

function sniper(state, side, params) {
  const soldier = state.soldiers.find(
    (s) => s.id === params.soldierId && s.owner === other(side) && isBattlefield(s.loc),
  );
  if (!soldier) throw new Error("Choose an enemy Soldier.");
  const result = rollHits(state, 2);
  if (result.hits >= 1) {
    eliminateSoldier(state, soldier);
    state.roundElim[side] = (state.roundElim[side] || 0) + 1;
  } else {
    log(state, "Sniper misses.");
  }
}

function suppression(state, side, params) {
  state.effects.suppression = params.supportType === "mortar" ? "mortar" : "mg";
  state.effects.suppressionBy = side;
  log(state, `Enemy ${state.effects.suppression === "mortar" ? "Mortars" : "Machine Guns"} are suppressed.`);
}

function trenchFever(state, side, params) {
  if (!isBattlefield(params.zone)) throw new Error("Choose a battlefield zone.");
  const list = soldiersIn(state, params.zone, { side: other(side), exposed: true }).slice(0, 2);
  for (const s of list) {
    eliminateSoldier(state, s);
    state.roundElim[side] = (state.roundElim[side] || 0) + 1;
  }
  if (!list.length) log(state, "No exposed enemy soldiers there.");
}

function armoredAdvance(state, side, params) {
  const tank = state.equipment.find(
    (e) => e.id === params.unitId && e.type === "tank" && e.owner === side && isBattlefield(e.loc),
  );
  if (!tank) throw new Error("Choose a Tank on the battlefield.");
  const dest = stepZone(side, tank.loc, "forward");
  if (!dest) throw new Error("That Tank cannot advance.");
  if (dest === enemyTrench(side)) {
    state.vp[side] += 1;
    tank.loc = "supply";
    tank.damage = 0;
    log(state, "Armored Advance — Tank enters the enemy Trench (+1 VP).");
    refreshControl(state, { tankLeft: true });
    return;
  }
  tank.loc = dest;
  log(state, `Tank advances to ${ZONE_LABELS[dest]}.`);
  refreshControl(state);
}

function tunnel(state, side, params) {
  const trench = ownTrench(side);
  const dest = params.zone;
  if (controllerOf(state, dest) !== side) throw new Error("Tunnel into a zone you control.");
  const ids = (params.soldierIds || []).slice(0, 2);
  let n = 0;
  for (const id of ids) {
    const s = state.soldiers.find((x) => x.id === id && x.owner === side && x.loc === trench);
    if (!s) continue;
    s.loc = dest;
    s.coverId = null;
    state.players[side].attackedIds.push(s.id);
    n += 1;
  }
  if (!n) throw new Error("Choose soldiers in your Trench.");
  log(state, `${n} Soldier(s) tunnel to ${ZONE_LABELS[dest]}.`);
}

const TABLE = {
  Reinforce: (state, side) => reinforce(state, side),
  Patrol: (state, side, params) => moveGroup(state, side, params, 2, true),
  Charge: (state, side, params) => moveGroup(state, side, params, 3, false),
  "Bayonet Charge": (state, side, params) => bayonetCharge(state, side, params),
  "Bogged Down": (state, side) => {
    state.effects.boggedDown = true;
    state.effects.boggedDownBy = side;
  },
  "Bombing Run": (state, side, params) => bombingRun(state, side, params),
  "Carrier Pigeon": (state, side) => carrierPigeon(state, side),
  "Cavalry Charge": (state, side) => {
    state.effects.cavalryCharge = side;
  },
  "Christmas Truce": (state) => {
    state.effects.christmasTruce = true;
  },
  Entrench: (state, side, params) => entrench(state, side, params),
  Espionage: (state, side) => espionage(state, side),
  "Field Hospital": (state, side) => fieldHospital(state, side),
  "Field Repairs": (state, side, params) => fieldRepairs(state, side, params),
  "Heavy Barrage": (state, side, params) => heavyBarrage(state, side, params),
  Mobility: (state, side, params) => markMortar(state, side, params, "mobility"),
  "Precision Barrage": (state, side, params) => markMortar(state, side, params, "precision"),
  Raid: (state, side, params) => raid(state, side, params),
  "Recon Flight": (state, _side, params) => reconFlight(state, params),
  Sabotage: (state, side, params) => sabotage(state, side, params),
  Scout: (state, side, params) => scout(state, side, params),
  "Smoke Screen": (state, _side, params) => smokeScreen(state, params),
  Sniper: (state, side, params) => sniper(state, side, params),
  Spotter: (state, side, params) => markMortar(state, side, params, "spotter"),
  Suppression: (state, side, params) => suppression(state, side, params),
  "Trench Fever": (state, side, params) => trenchFever(state, side, params),
  "Trench Foot": (state, side) => {
    state.effects.trenchFoot = true;
    state.effects.trenchFootBy = side;
  },
  "Armored Advance": (state, side, params) => armoredAdvance(state, side, params),
  Tunnel: (state, side, params) => tunnel(state, side, params),
};
