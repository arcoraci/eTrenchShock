import {
  soldiersIn,
  coversIn,
  controllerOf,
  isBattlefield,
  stepZone,
  other,
  BATTLEFIELD,
  ownZone1,
  sideZones,
  ownTrench,
  enemySideZones,
  smoked,
  zoneDistance,
  machineGunOperational,
  machineGunTargets,
  soldierMayFire,
  soldierStrikeTargets,
  canSoldierTarget,
  SYMBOL_RANK,
  enemyTrench,
  forwardPath,
} from "./core.js";
import { remaining, hasShock, naturalFaces, unusedDice } from "./dice.js";
import { eventNeeds, bayonetDestinations } from "./events.js";
import { tanksReadyToMove } from "./game.js";
import { preferredMissionAction } from "./missions.js";

const HOSTILE = new Set(["Bayonet Charge", "Bombing Run", "Heavy Barrage", "Sniper", "Trench Fever"]);

function difficultyOf(state) {
  const value = state?.difficulty;
  if (value === "Easy" || value === "Difficult" || value === "Hard") return value;
  return "Difficult";
}

export function chooseAiAction(state) {
  const level = difficultyOf(state);
  if (level === "Easy") return chooseEasyAction(state);
  if (level === "Hard") return chooseHardAction(state);
  return chooseDifficultAction(state);
}

function chooseDifficultAction(state) {
  const pending = state.pending || {};
  if (state.phase === "initiative" && pending.type === "roll1") return { type: "ROLL_1" };
  if (pending.type === "generals-order") return { type: "SKIP_GENERALS_ORDER" };
  if (pending.type === "spotter") {
    return { type: "PICK_SPOTTER", face: pending.options[0] };
  }
  if (pending.type === "mortar-target") {
    const pick = pending.options.find((o) => o.kind === "exposed") || pending.options[0];
    return { type: "ALLOCATE_MORTAR", targetId: pick.id };
  }
  if (pending.type === "gambit" && pending.stage === "keep") {
    const best = pending.cards.slice().sort((a, b) => b.vp - a.vp)[0];
    return { type: "PICK_GAMBIT", inst: best.inst };
  }
  if (pending.type === "gambit") return { type: "FINISH_GAMBIT" };
  if (pending.type === "allocate-hits") return { type: "ALLOCATE_HITS", auto: true };
  if (pending.type === "pick-mission") return preferredMissionAction(state);
  if (state.phase === "reroll") return aiReroll(state, state.active);
  if (state.phase === "action") return aiAction(state, state.active);
  if (state.phase === "regroup") return aiRegroup(state, state.active);
  return null;
}

function aiReroll(state, side) {
  const p = state.players[side];
  if (!p.committed && p.rollsUsed < 3) {
    const keep = p.dice.map((f) => ["boot", "wild", "whistle", "bayonet"].includes(f));
    if (p.rollsUsed === 1 && keep.some((k) => !k)) return { type: "REROLL", keep };
    if (p.rollsUsed === 2 && p.dice.includes("shovel") && p.dice.filter((f) => f === "boot").length < 2) {
      return { type: "REROLL", keep: p.dice.map((f) => f !== "shovel") };
    }
  }
  const nat = naturalFaces(p.dice);
  const prefer = ["boot", "whistle", "bayonet", "shovel"].find((s) => nat.includes(s)) || null;
  return { type: "COMMIT", wildAs: prefer };
}

function aiAction(state, side) {
  const step = state.actionStep;
  if (step === "shock") {
    if (hasShock(state, side)) {
      const exposed = enemySideZones(side).reduce(
        (n, z) => n + soldiersIn(state, z, { side: other(side), exposed: true }).length,
        0,
      );
      return { type: "SHOCK", option: exposed >= 4 ? "gas" : "gambit" };
    }
    return { type: "SKIP_SHOCK" };
  }
  if (step === "tank") {
    const tank = tanksReadyToMove(state, side)[0];
    if (tank) return { type: "MOVE_TANK", unitId: tank.id, steps: 2 };
    return { type: "SKIP_TANK" };
  }
  if (step === "event") return pickEvent(state, side) || { type: "SKIP_EVENT" };
  if (step === "deploy") return deployAction(state, side);
  if (step === "move") return moveAction(state, side);
  if (step === "cover") return coverAction(state, side);
  if (step === "attack") return pickAttack(state, side) || { type: "SKIP_ATTACK" };
  return { type: "SKIP_ATTACK" };
}

function deployAction(state, side) {
  const bayonets = remaining(state, side, "bayonet");
  if (bayonets >= 4) {
    const tank = state.equipment.find((u) => u.owner === side && u.type === "tank" && u.loc === "supply");
    if (tank) return { type: "DEPLOY", kind: "tank" };
  }
  const zone1 = ownZone1(side);
  if (bayonets >= 3 && controllerOf(state, zone1) === side) {
    const mg = state.equipment.find((u) => u.owner === side && u.type === "mg" && u.loc === "supply");
    if (mg) return { type: "DEPLOY", kind: "mg", zone: zone1 };
  }
  if (bayonets >= 2 && controllerOf(state, zone1) === side) {
    const mortar = state.equipment.find((u) => u.owner === side && u.type === "mortar" && u.loc === "supply");
    if (mortar) return { type: "DEPLOY", kind: "mortar", zone: zone1 };
  }
  const damaged = state.equipment.find((u) => u.owner === side && isBattlefield(u.loc) && u.damage >= 1);
  if (damaged && bayonets >= 1) return { type: "REPAIR", unitId: damaged.id };
  if (!state.players[side].soldierDeployed && bayonets >= 1) {
    const available = state.soldiers.some((s) => s.owner === side && s.loc === "available");
    const zone = [...enemySideZones(side), "obj", ...sideZones(side)].find((z) => controllerOf(state, z) === side);
    if (available && zone) return { type: "DEPLOY", kind: "soldier", zone };
  }
  return { type: "SKIP_DEPLOY" };
}

function moveAction(state, side) {
  if (remaining(state, side, "boot") < 1) return { type: "SKIP_MOVE" };
  const foot = state.effects.trenchFoot && side !== state.effects.trenchFootBy;
  if (!foot) {
    const soldiers = state.soldiers.filter((s) => (
      s.owner === side && !s.coverId && (isBattlefield(s.loc) || s.loc === ownTrench(side))
    ));
    soldiers.sort((a, b) => moveScore(state, side, a.loc) - moveScore(state, side, b.loc));
    for (const s of soldiers) {
      const dest = stepZone(side, s.loc, "forward");
      if (dest && isBattlefield(dest)) {
        return { type: "MOVE_UNIT", kind: "soldier", unitId: s.id, dir: "forward" };
      }
    }
  }
  const p = state.players[side];
  const weapon = state.equipment.find((u) => (
    u.owner === side &&
    u.type !== "tank" &&
    isBattlefield(u.loc) &&
    u.damage < 1 &&
    !p.movedEquip.includes(u.id) &&
    !p.firedEquip.includes(u.id) &&
    isBattlefield(stepZone(side, u.loc, "forward"))
  ));
  if (weapon) return { type: "MOVE_UNIT", kind: "weapon", unitId: weapon.id, dir: "forward" };
  return { type: "SKIP_MOVE" };
}

function moveScore(state, side, loc) {
  const dest = stepZone(side, loc, "forward");
  if (!dest || !isBattlefield(dest)) return 50;
  if (dest === "obj") return 0;
  if (enemySideZones(side).includes(dest)) return 1;
  if (loc === ownTrench(side)) return 20;
  return 2 + BATTLEFIELD.indexOf(loc);
}

function coverAction(state, side) {
  if (remaining(state, side, "shovel") < 1) return { type: "SKIP_COVER" };
  const zones = ["obj", ...sideZones(side), ...enemySideZones(side)];
  for (const zone of zones) {
    const soldier = soldiersIn(state, zone, { side, exposed: true })[0];
    const cover = (coversIn(state, zone) || []).find((c) => {
      const occ = soldiersIn(state, zone, { matchCover: true, coverId: c.id });
      return occ.length < 3 && !occ.some((o) => o.owner !== side);
    });
    if (soldier && cover) return { type: "SHOVEL", mode: "dig", soldierId: soldier.id, coverId: cover.id };
  }
  return { type: "SKIP_COVER" };
}

function pickEvent(state, side) {
  if (remaining(state, side, "whistle") < 1) return null;
  const opened = state.players[side].eventsAtStep;
  const hand = state.players[side].eventHand.filter((c) => c.title !== "General's Order" && (!opened || opened.includes(c.inst)));
  const order = [
    "Precision Barrage", "Spotter", "Charge", "Bayonet Charge", "Raid", "Patrol", "Cavalry Charge",
    "Sniper", "Trench Fever", "Bombing Run", "Heavy Barrage", "Scout", "Reinforce", "Field Hospital",
    "Entrench", "Tunnel", "Armored Advance", "Field Repairs", "Mobility", "Trench Foot", "Bogged Down",
    "Suppression", "Smoke Screen", "Recon Flight", "Sabotage", "Espionage", "Carrier Pigeon", "Christmas Truce",
  ];
  for (const title of order) {
    const card = hand.find((c) => c.title === title);
    if (!card) continue;
    if (state.effects.christmasTruce && HOSTILE.has(title)) continue;
    const params = fillParams(state, side, card);
    if (!params) continue;
    return { type: "PLAY_EVENT", cardInst: card.inst, params };
  }
  return null;
}

function fillParams(state, side, card) {
  const title = card.title;
  const foe = other(side);
  const needs = eventNeeds(title);
  if (["Trench Foot", "Bogged Down", "Suppression", "Christmas Truce"].includes(title) && state.active !== state.player1) {
    return null;
  }
  if (title === "Bogged Down") {
    const enemyTank = state.equipment.some((u) => u.owner === foe && u.type === "tank" && isBattlefield(u.loc));
    return enemyTank ? {} : null;
  }
  if (title === "Suppression") {
    const enemyMg = state.equipment.some((u) => u.owner === foe && u.type === "mg" && isBattlefield(u.loc));
    const enemyMortar = state.equipment.some((u) => u.owner === foe && u.type === "mortar" && isBattlefield(u.loc));
    if (enemyMg) return { supportType: "mg" };
    if (enemyMortar) return { supportType: "mortar" };
    return null;
  }
  if (title === "Christmas Truce") {
    const exposed = BATTLEFIELD.reduce((n, z) => n + soldiersIn(state, z, { side: foe, exposed: true }).length, 0);
    return exposed >= 6 ? {} : null;
  }
  if (title === "Cavalry Charge" || title === "Trench Foot") return {};
  if (title === "Reinforce") {
    const avail = state.soldiers.some((s) => s.owner === side && s.loc === "available");
    const room = 5 - state.soldiers.filter((s) => s.owner === side && s.loc === ownTrench(side)).length;
    return avail && room > 0 ? {} : null;
  }
  if (title === "Field Hospital") {
    const cas = state.soldiers.some((s) => s.owner === side && s.loc === "casualties" && !s.overflow);
    const room = 5 - state.soldiers.filter((s) => s.owner === side && s.loc === ownTrench(side)).length;
    return cas && room > 0 ? {} : null;
  }
  if (title === "Carrier Pigeon") return state.missionDeck.length && state.players[side].missionHand.length < 5 ? {} : null;
  if (title === "Espionage") {
    return state.players[foe].eventHand.length && state.players[side].eventHand.length < 7 ? {} : null;
  }
  if (state.effects.trenchFoot && side !== state.effects.trenchFootBy && ["Charge", "Patrol", "Bayonet Charge", "Raid"].includes(title)) {
    return null;
  }
  if (title === "Charge" || title === "Patrol") return movingSoldiers(state, side, title === "Charge" ? 3 : 2);
  if (title === "Bayonet Charge") return bayonetParams(state, side);
  if (title === "Raid") return raidParams(state, side);
  if (title === "Sniper") {
    const s = state.soldiers.find((x) => x.owner === foe && isBattlefield(x.loc) && !x.coverId)
      || state.soldiers.find((x) => x.owner === foe && isBattlefield(x.loc));
    return s ? { soldierId: s.id } : null;
  }
  if (title === "Trench Fever" || title === "Bombing Run" || title === "Heavy Barrage" || title === "Recon Flight" || title === "Smoke Screen") {
    return zoneParams(state, side, title);
  }
  if (title === "Scout") return scoutParams(state, side);
  if (title === "Entrench") return entrenchParams(state, side);
  if (title === "Tunnel") return tunnelParams(state, side);
  if (title === "Armored Advance") {
    const tank = state.equipment.find((u) => u.owner === side && u.type === "tank" && isBattlefield(u.loc) && stepZone(side, u.loc, "forward"));
    return tank ? { unitId: tank.id } : null;
  }
  if (title === "Field Repairs") {
    const unit = state.equipment.find((u) => u.owner === side && u.damage >= 1);
    return unit ? { unitId: unit.id } : null;
  }
  if (title === "Mobility" || title === "Precision Barrage" || title === "Spotter") {
    const mortar = state.equipment.find((u) => u.owner === side && u.type === "mortar" && isBattlefield(u.loc) && u.damage < 1);
    return mortar ? { unitId: mortar.id } : null;
  }
  if (title === "Sabotage") return sabotageParams(state, side);
  if (!needs.length) return {};
  return null;
}

function movingSoldiers(state, side, maximum) {
  for (const zone of BATTLEFIELD) {
    const dest = stepZone(side, zone, "forward");
    if (!dest || !isBattlefield(dest)) continue;
    const soldiers = soldiersIn(state, zone, { side });
    if (!soldiers.length) continue;
    return { soldierIds: soldiers.slice(0, maximum).map((s) => s.id), zone, dir: "forward" };
  }
  return null;
}

function bayonetParams(state, side) {
  for (const zone of BATTLEFIELD) {
    const options = bayonetDestinations(state, side, zone);
    if (!options.length) continue;
    const forward = stepZone(side, zone, "forward");
    const dest = options.includes(forward) ? forward : options[0];
    const soldiers = soldiersIn(state, zone, { side });
    if (!soldiers.length) continue;
    return { soldierIds: soldiers.slice(0, 3).map((s) => s.id), zone: dest };
  }
  return null;
}

function raidParams(state, side) {
  for (const zone of BATTLEFIELD) {
    if (controllerOf(state, zone) !== side) continue;
    const dest = stepZone(side, zone, "forward");
    if (!dest || !isBattlefield(dest)) continue;
    const soldiers = soldiersIn(state, zone, { side });
    if (!soldiers.length) continue;
    return { soldierIds: soldiers.slice(0, 2).map((s) => s.id), zone };
  }
  return null;
}

function zoneParams(state, side, title) {
  const foe = other(side);
  if (title === "Smoke Screen") return { zone: "obj" };
  if (title === "Recon Flight") {
    const zone = BATTLEFIELD.find((z) => coversIn(state, z).some((c) => !c.revealed));
    return zone ? { zone } : null;
  }
  if (title === "Heavy Barrage") {
    const zone = BATTLEFIELD.find((z) => controllerOf(state, z) === foe && soldiersIn(state, z, { side: foe, exposed: true }).length);
    return zone ? { zone, targetKind: "exposed" } : null;
  }
  let best = null;
  let bestN = 0;
  for (const zone of BATTLEFIELD) {
    const opts = { side: foe };
    if (title === "Trench Fever") opts.exposed = true;
    const n = soldiersIn(state, zone, opts).length;
    if (n > bestN) {
      bestN = n;
      best = zone;
    }
  }
  if (!best) return null;
  return { zone: best, targetKind: "exposed" };
}

function scoutParams(state, side) {
  for (const cover of state.covers) {
    if (cover.destroyed) continue;
    const occ = soldiersIn(state, cover.loc, { side: other(side), matchCover: true, coverId: cover.id });
    if (!occ.length) continue;
    const near = state.soldiers.some((s) => s.owner === side && isBattlefield(s.loc) && zoneDistance(s.loc, cover.loc) <= 1);
    if (near) return { coverId: cover.id };
  }
  return null;
}

function entrenchParams(state, side) {
  const soldiers = state.soldiers.filter((s) => s.owner === side && s.loc === ownTrench(side));
  if (!soldiers.length) return null;
  for (const cover of state.covers) {
    if (cover.destroyed || controllerOf(state, cover.loc) !== side) continue;
    const occ = soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id });
    if (occ.length >= 3 || occ.some((o) => o.owner !== side)) continue;
    return { soldierIds: soldiers.slice(0, 3).map((s) => s.id), coverId: cover.id };
  }
  return null;
}

function tunnelParams(state, side) {
  const soldiers = state.soldiers.filter((s) => s.owner === side && s.loc === ownTrench(side));
  if (!soldiers.length) return null;
  const zone = ["obj", ...enemySideZones(side), ...sideZones(side)].find((z) => controllerOf(state, z) === side);
  if (!zone) return null;
  return { soldierIds: soldiers.slice(0, 2).map((s) => s.id), zone };
}

function sabotageParams(state, side) {
  const dice = state.players[other(side)].dice;
  const rank = { bayonet: 4, whistle: 3, shovel: 2, boot: 1, wild: 0 };
  let best = -1;
  let index = -1;
  dice.forEach((face, i) => {
    if (!face) return;
    const bucket = face === "wild" ? state.players[other(side)].wildAs : face;
    if (!bucket || remaining(state, other(side), bucket) < 1) return;
    const score = rank[face] ?? 0;
    if (score > best) {
      best = score;
      index = i;
    }
  });
  return index >= 0 ? { dieIndex: index } : null;
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  return a.kind === b.kind
    && a.zone === b.zone
    && (a.coverId || null) === (b.coverId || null)
    && (a.unitId || null) === (b.unitId || null);
}

function plannedSoldierAttack(state, side) {
  const foe = other(side);
  const p = state.players[side];
  const groups = [];
  for (const zone of BATTLEFIELD) {
    const mine = soldiersIn(state, zone, { side }).filter((s) => soldierMayFire(s, p.attackedIds));
    if (mine.length) groups.push({ zone, mine });
  }
  const seek = (coverOnly) => {
    for (const group of groups) {
      const zi = BATTLEFIELD.indexOf(group.zone);
      for (const tz of BATTLEFIELD) {
        if (Math.abs(BATTLEFIELD.indexOf(tz) - zi) > 1) continue;
        if (smoked(state, group.zone, tz)) continue;
        if (!coverOnly) {
          if (!soldiersIn(state, tz, { side: foe, exposed: true }).length) continue;
          return {
            attackerIds: group.mine.slice(0, 6).map((s) => s.id),
            target: { kind: "exposed", zone: tz },
          };
        }
        const cover = soldierStrikeTargets(state, side, tz).find((target) => target.kind === "cover");
        if (!cover) continue;
        return {
          attackerIds: group.mine.slice(0, 6).map((s) => s.id),
          target: { kind: "cover", zone: tz, coverId: cover.coverId },
        };
      }
    }
    return null;
  };
  return seek(false) || seek(true);
}

function plannedMgAttack(state, side) {
  const mg = state.equipment.find((u) => u.owner === side && machineGunOperational(state, u));
  if (!mg) return null;
  const shots = machineGunTargets(state, mg);
  const shot = shots.find((t) => t.kind === "exposed")
    || shots.find((t) => t.kind === "cover" || t.kind === "mg" || t.kind === "mortar");
  if (!shot) return null;
  return {
    mg,
    attackerIds: [mg.id],
    target: { kind: shot.kind, zone: shot.zone, coverId: shot.coverId, unitId: shot.unitId },
  };
}

function pickAttack(state, side) {
  if (state.effects.christmasTruce) return { type: "SKIP_ATTACK" };
  const foe = other(side);
  const p = state.players[side];
  const soldiers = plannedSoldierAttack(state, side);
  const mgShot = plannedMgAttack(state, side);
  if (soldiers && mgShot && sameTarget(soldiers.target, mgShot.target)) {
    const mg = mgShot.mg;
    const target = soldiers.target;
    if (target.kind !== "tank" && zoneDistance(mg.loc, target.zone) <= 2 && !smoked(state, mg.loc, target.zone)) {
      return {
        type: "START_ATTACK",
        kind: "infantry",
        attackerIds: [...soldiers.attackerIds, mg.id],
        target,
      };
    }
  }
  if (soldiers) {
    return { type: "START_ATTACK", kind: "infantry", attackerIds: soldiers.attackerIds, target: soldiers.target };
  }
  if (mgShot) {
    return { type: "START_ATTACK", kind: "infantry", attackerIds: mgShot.attackerIds, target: mgShot.target };
  }
  const tank = state.equipment.find((u) => (
    u.owner === side && u.type === "tank" && isBattlefield(u.loc) && !p.attackedIds.includes(u.id)
  ));
  if (tank) {
    const ti = BATTLEFIELD.indexOf(tank.loc);
    const tz = BATTLEFIELD.find((z) => (
      Math.abs(BATTLEFIELD.indexOf(z) - ti) <= 1 &&
      !smoked(state, tank.loc, z) &&
      soldiersIn(state, z, { side: foe, exposed: true }).length
    ));
    if (tz) {
      return {
        type: "START_ATTACK",
        kind: "tank",
        unitId: tank.id,
        target: { kind: "exposed", zone: tz },
      };
    }
    const cover = coversIn(state, tank.loc).find((c) => {
      const occ = soldiersIn(state, tank.loc, { matchCover: true, coverId: c.id });
      return occ.some((s) => s.owner === foe);
    });
    const engaged = state.equipment.some((u) => u.owner === foe && u.type === "tank" && u.loc === tank.loc);
    if (cover && !engaged) return { type: "OVERRUN", unitId: tank.id, coverId: cover.id };
    const dug = BATTLEFIELD.find((z) => (
      Math.abs(BATTLEFIELD.indexOf(z) - ti) <= 1 &&
      !smoked(state, tank.loc, z) &&
      soldierStrikeTargets(state, side, z).some((target) => target.kind === "cover")
    ));
    if (dug) {
      const target = soldierStrikeTargets(state, side, dug).find((shot) => shot.kind === "cover");
      return { type: "START_ATTACK", kind: "tank", unitId: tank.id, target };
    }
  }
  const mortar = state.equipment.find((u) => (
    u.owner === side &&
    u.type === "mortar" &&
    isBattlefield(u.loc) &&
    u.damage < 1 &&
    !p.attackedIds.includes(u.id) &&
    !p.firedEquip.includes(u.id) &&
    !(p.movedEquip.includes(u.id) && !state.effects.mobility.includes(u.id)) &&
    !(state.effects.suppression === "mortar" && u.owner !== state.effects.suppressionBy)
  ));
  if (mortar) {
    const aimed = state.effects.precision.includes(mortar.id)
      ? BATTLEFIELD.find((z) => soldiersIn(state, z, { side: foe, exposed: true }).length) || null
      : null;
    if (state.effects.precision.includes(mortar.id) && !aimed) return { type: "SKIP_ATTACK" };
    return {
      type: "START_ATTACK",
      kind: "mortar",
      unitId: mortar.id,
      target: { kind: "allocate", zone: aimed },
    };
  }
  return null;
}

function aiRegroup(state, side) {
  const p = state.players[side];
  const trench = state.soldiers.filter((s) => s.owner === side && s.loc === ownTrench(side)).length;
  const available = state.soldiers.some((s) => s.owner === side && s.loc === "available");
  if ((p.regroupExchanged || 0) < 2 && unusedDice(state, side) > 0 && trench < 4 && available) {
    return { type: "REGROUP_EXCHANGE" };
  }
  if (!p.regroupDrew && p.eventHand.length < 7 && (state.eventDisplay.length || state.eventDeck.length)) {
    const face = state.eventDisplay[0];
    return { type: "REGROUP_DRAW", side, source: face ? face.inst : "deck" };
  }
  return { type: "SKIP_REGROUP" };
}

function showingFace(dice) {
  return (dice || []).find((face) => face && face !== "wild") || null;
}

function highestFace(dice) {
  const natural = naturalFaces(dice);
  if (!natural.length) return null;
  return natural.reduce((best, face) => ((SYMBOL_RANK[face] || 0) > (SYMBOL_RANK[best] || 0) ? face : best));
}

function poolIsWeak(dice) {
  const high = dice.filter((face) => face === "bayonet" || face === "whistle").length;
  return high < 2 || dice.includes("shovel");
}

function chooseEasyAction(state) {
  const pending = state.pending || {};
  if (state.phase === "initiative" && pending.type === "roll1") return { type: "ROLL_1" };
  if (pending.type === "generals-order") return { type: "SKIP_GENERALS_ORDER" };
  if (pending.type === "spotter") return { type: "PICK_SPOTTER", face: pending.options[0] };
  if (pending.type === "mortar-target") {
    return { type: "ALLOCATE_MORTAR", targetId: pending.options[0].id };
  }
  if (pending.type === "gambit" && pending.stage === "keep") {
    return { type: "PICK_GAMBIT", inst: pending.cards[0].inst };
  }
  if (pending.type === "gambit") return { type: "FINISH_GAMBIT" };
  if (pending.type === "allocate-hits") return { type: "ALLOCATE_HITS", auto: true };
  if (pending.type === "pick-mission") {
    const inst = pending.insts?.[0];
    return inst ? { type: "PICK_MISSION", inst } : preferredMissionAction(state);
  }
  if (state.phase === "reroll") return easyReroll(state, state.active);
  if (state.phase === "action") return easyAction(state, state.active);
  if (state.phase === "regroup") return aiRegroup(state, state.active);
  return null;
}

function chooseHardAction(state) {
  const pending = state.pending || {};
  if (state.phase === "initiative" && pending.type === "roll1") return { type: "ROLL_1" };
  if (pending.type === "generals-order") return { type: "SKIP_GENERALS_ORDER" };
  if (pending.type === "spotter") return { type: "PICK_SPOTTER", face: pending.options[0] };
  if (pending.type === "mortar-target") {
    const options = pending.options || [];
    const pick = options.find((o) => o.kind === "exposed" && o.zone === "obj")
      || options.find((o) => o.zone === "obj" && o.kind !== "cover-empty")
      || options.find((o) => o.kind === "exposed")
      || options[0];
    return { type: "ALLOCATE_MORTAR", targetId: pick.id };
  }
  if (pending.type === "gambit" && pending.stage === "keep") {
    const best = pending.cards.slice().sort((a, b) => b.vp - a.vp)[0];
    return { type: "PICK_GAMBIT", inst: best.inst };
  }
  if (pending.type === "gambit") return { type: "FINISH_GAMBIT" };
  if (pending.type === "allocate-hits") return { type: "ALLOCATE_HITS", auto: true };
  if (pending.type === "pick-mission") return preferredMissionAction(state);
  if (state.phase === "reroll") return hardReroll(state, state.active);
  if (state.phase === "action") return hardAction(state, state.active);
  if (state.phase === "regroup") return aiRegroup(state, state.active);
  return null;
}

function easyReroll(state, side) {
  return { type: "COMMIT", wildAs: showingFace(state.players[side].dice) };
}

function hardReroll(state, side) {
  const p = state.players[side];
  if (!p.committed && p.rollsUsed < 3 && poolIsWeak(p.dice)) {
    const high = p.dice.filter((face) => face === "bayonet" || face === "whistle").length;
    const keep = p.dice.map((face) => {
      if (face === "wild" || face === "bayonet" || face === "whistle") return true;
      if (face === "boot") return high >= 2;
      return false;
    });
    if (keep.some((held) => !held)) return { type: "REROLL", keep };
  }
  return { type: "COMMIT", wildAs: highestFace(p.dice) };
}

function easyAction(state, side) {
  const step = state.actionStep;
  if (step === "shock") {
    if (hasShock(state, side)) return { type: "SHOCK", option: "gambit" };
    return { type: "SKIP_SHOCK" };
  }
  if (step === "tank") return easyTank(state, side);
  if (step === "event") return easyEvent(state, side) || { type: "SKIP_EVENT" };
  if (step === "deploy") return easyDeploy(state, side);
  if (step === "move") return easyMove(state, side);
  if (step === "cover") return easyCover(state, side);
  if (step === "attack") return easyAttack(state, side);
  return { type: "SKIP_ATTACK" };
}

function hardAction(state, side) {
  const step = state.actionStep;
  if (step === "shock") {
    if (hasShock(state, side)) {
      const exposed = enemySideZones(side).reduce(
        (n, zone) => n + soldiersIn(state, zone, { side: other(side), exposed: true }).length,
        0,
      );
      return { type: "SHOCK", option: exposed >= 1 ? "gas" : "gambit" };
    }
    return { type: "SKIP_SHOCK" };
  }
  if (step === "tank") return hardTank(state, side);
  if (step === "event") return hardEvent(state, side) || { type: "SKIP_EVENT" };
  if (step === "deploy") return hardDeploy(state, side);
  if (step === "move") return moveAction(state, side);
  if (step === "cover") return hardCover(state, side);
  if (step === "attack") return hardAttack(state, side) || { type: "SKIP_ATTACK" };
  return { type: "SKIP_ATTACK" };
}

function easyTank(state, side) {
  const tank = tanksReadyToMove(state, side)[0];
  if (!tank) return { type: "SKIP_TANK" };
  return { type: "MOVE_TANK", unitId: tank.id, steps: 1 };
}

function hardTank(state, side) {
  const tanks = tanksReadyToMove(state, side);
  if (!tanks.length) return { type: "SKIP_TANK" };
  const tank = tanks.slice().sort((a, b) => stepsToTrench(side, a.loc) - stepsToTrench(side, b.loc))[0];
  return { type: "MOVE_TANK", unitId: tank.id, steps: 2 };
}

function stepsToTrench(side, loc) {
  const path = forwardPath(side);
  const here = path.indexOf(loc);
  const trench = path.indexOf(enemyTrench(side));
  if (here < 0 || trench < 0) return 99;
  return trench - here;
}

function controlledZone(state, side, hunt) {
  const order = hunt
    ? [...enemySideZones(side), "obj", ...sideZones(side)]
    : [...sideZones(side), "obj", ...enemySideZones(side)];
  return order.find((zone) => controllerOf(state, zone) === side) || null;
}

function supplyUnit(state, side, type) {
  return state.equipment.find((unit) => unit.owner === side && unit.type === type && unit.loc === "supply") || null;
}

function easyDeploy(state, side) {
  const bayonets = remaining(state, side, "bayonet");
  const zone = controlledZone(state, side, false);
  if (!state.players[side].soldierDeployed && bayonets >= 1) {
    const available = state.soldiers.some((soldier) => soldier.owner === side && soldier.loc === "available");
    if (available && zone) return { type: "DEPLOY", kind: "soldier", zone };
  }
  const damaged = state.equipment.find((unit) => unit.owner === side && isBattlefield(unit.loc) && unit.damage >= 1);
  if (damaged && bayonets >= 1) return { type: "REPAIR", unitId: damaged.id };
  const zone1 = ownZone1(side);
  if (bayonets >= 2 && controllerOf(state, zone1) === side && supplyUnit(state, side, "mortar")) {
    return { type: "DEPLOY", kind: "mortar", zone: zone1 };
  }
  const mgZone = sideZones(side).find((candidate) => controllerOf(state, candidate) === side);
  if (bayonets >= 3 && mgZone && supplyUnit(state, side, "mg")) {
    return { type: "DEPLOY", kind: "mg", zone: mgZone };
  }
  if (bayonets >= 4 && supplyUnit(state, side, "tank")) return { type: "DEPLOY", kind: "tank" };
  return { type: "SKIP_DEPLOY" };
}

function gunIsClose(state, side, bayonets) {
  const hold1 = controllerOf(state, ownZone1(side)) === side;
  const ownHeld = sideZones(side).some((zone) => controllerOf(state, zone) === side);
  if (supplyUnit(state, side, "tank") && bayonets === 3) return true;
  if (supplyUnit(state, side, "mg") && ownHeld && bayonets === 2) return true;
  if (supplyUnit(state, side, "mortar") && hold1 && bayonets === 1) return true;
  return false;
}

function hardDeploy(state, side) {
  const bayonets = remaining(state, side, "bayonet");
  if (bayonets >= 4 && supplyUnit(state, side, "tank")) return { type: "DEPLOY", kind: "tank" };
  const mgZone = sideZones(side).find((zone) => controllerOf(state, zone) === side);
  if (bayonets >= 3 && mgZone && supplyUnit(state, side, "mg")) {
    return { type: "DEPLOY", kind: "mg", zone: mgZone };
  }
  const zone1 = ownZone1(side);
  if (bayonets >= 2 && controllerOf(state, zone1) === side && supplyUnit(state, side, "mortar")) {
    return { type: "DEPLOY", kind: "mortar", zone: zone1 };
  }
  if (gunIsClose(state, side, bayonets)) return { type: "SKIP_DEPLOY" };
  const damaged = state.equipment.find((unit) => unit.owner === side && isBattlefield(unit.loc) && unit.damage >= 1);
  if (damaged && bayonets >= 1) return { type: "REPAIR", unitId: damaged.id };
  if (!state.players[side].soldierDeployed && bayonets >= 1) {
    const available = state.soldiers.some((soldier) => soldier.owner === side && soldier.loc === "available");
    const zone = controlledZone(state, side, true);
    if (available && zone) return { type: "DEPLOY", kind: "soldier", zone };
  }
  return { type: "SKIP_DEPLOY" };
}

function forwardWeapon(state, side) {
  const p = state.players[side];
  const weapon = state.equipment.find((unit) => (
    unit.owner === side &&
    unit.type !== "tank" &&
    isBattlefield(unit.loc) &&
    unit.damage < 1 &&
    !p.movedEquip.includes(unit.id) &&
    !p.firedEquip.includes(unit.id) &&
    isBattlefield(stepZone(side, unit.loc, "forward"))
  ));
  if (weapon) return { type: "MOVE_UNIT", kind: "weapon", unitId: weapon.id, dir: "forward" };
  return { type: "SKIP_MOVE" };
}

function easyMove(state, side) {
  if (remaining(state, side, "boot") < 1) return { type: "SKIP_MOVE" };
  const foot = state.effects.trenchFoot && side !== state.effects.trenchFootBy;
  if (!foot) {
    const soldiers = state.soldiers.filter((soldier) => (
      soldier.owner === side && !soldier.coverId && (isBattlefield(soldier.loc) || soldier.loc === ownTrench(side))
    ));
    for (const soldier of soldiers) {
      const dest = stepZone(side, soldier.loc, "forward");
      if (dest && isBattlefield(dest)) {
        return { type: "MOVE_UNIT", kind: "soldier", unitId: soldier.id, dir: "forward" };
      }
    }
  }
  return forwardWeapon(state, side);
}

function listDigs(state, side) {
  const digs = [];
  const zones = ["obj", ...sideZones(side), ...enemySideZones(side)];
  for (const zone of zones) {
    const soldier = soldiersIn(state, zone, { side, exposed: true })[0];
    const cover = coversIn(state, zone).find((token) => {
      const occ = soldiersIn(state, zone, { matchCover: true, coverId: token.id });
      return occ.length < 3 && !occ.some((otherSoldier) => otherSoldier.owner !== side);
    });
    if (soldier && cover) digs.push({ soldierId: soldier.id, coverId: cover.id, zone });
  }
  return digs;
}

function firstRelocate(state, side, allowFar) {
  for (const cover of state.covers) {
    if (cover.destroyed) continue;
    if (soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id }).length) continue;
    for (const zone of BATTLEFIELD) {
      if (!allowFar && (zone === "obj" || enemySideZones(side).includes(zone))) continue;
      if (zoneDistance(cover.loc, zone) !== 1) continue;
      if (controllerOf(state, zone) !== side) continue;
      return { coverId: cover.id, zone };
    }
  }
  return null;
}

function easyCover(state, side) {
  if (remaining(state, side, "shovel") < 1) return { type: "SKIP_COVER" };
  if (state.coverSupply?.length) {
    const own = sideZones(side).find((zone) => controllerOf(state, zone) === side);
    if (own) return { type: "SHOVEL", mode: "prepare", zone: own };
  }
  const near = firstRelocate(state, side, false);
  if (near) return { type: "SHOVEL", mode: "relocate", coverId: near.coverId, zone: near.zone };
  if (state.coverSupply?.length) {
    const any = BATTLEFIELD.find((zone) => controllerOf(state, zone) === side);
    if (any) return { type: "SHOVEL", mode: "prepare", zone: any };
  }
  const far = firstRelocate(state, side, true);
  if (far) return { type: "SHOVEL", mode: "relocate", coverId: far.coverId, zone: far.zone };
  const leaver = state.soldiers.find((soldier) => soldier.owner === side && soldier.coverId);
  if (leaver) return { type: "SHOVEL", mode: "leave", soldierId: leaver.id };
  const dig = listDigs(state, side)[0];
  if (dig) return { type: "SHOVEL", mode: "dig", soldierId: dig.soldierId, coverId: dig.coverId };
  return { type: "SKIP_COVER" };
}

function zoneThreatened(state, side, zone) {
  const foe = other(side);
  for (const from of BATTLEFIELD) {
    if (zoneDistance(from, zone) > 1) continue;
    if (soldiersIn(state, from, { side: foe }).length) return true;
    if (state.equipment.some((unit) => unit.owner === foe && unit.type === "tank" && unit.loc === from)) return true;
  }
  return state.equipment.some((unit) => (
    unit.owner === foe && machineGunOperational(state, unit) && zoneDistance(unit.loc, zone) <= 2
  ));
}

function hardCover(state, side) {
  if (remaining(state, side, "shovel") < 1) return { type: "SKIP_COVER" };
  const threatened = listDigs(state, side).find((dig) => zoneThreatened(state, side, dig.zone));
  if (threatened) return { type: "SHOVEL", mode: "dig", soldierId: threatened.soldierId, coverId: threatened.coverId };
  return coverAction(state, side);
}

function easyEvent(state, side) {
  if (remaining(state, side, "whistle") < 1) return null;
  const opened = state.players[side].eventsAtStep;
  const hand = state.players[side].eventHand.filter((card) => card.title !== "General's Order" && (!opened || opened.includes(card.inst)));
  for (const card of hand) {
    if (state.effects.christmasTruce && HOSTILE.has(card.title)) continue;
    const params = easyParams(state, side, card);
    if (!params) continue;
    return { type: "PLAY_EVENT", cardInst: card.inst, params };
  }
  return null;
}

function easyParams(state, side, card) {
  const params = fillParams(state, side, card);
  if (!params) return null;
  const simpler = simplerTarget(state, side, card.title);
  return simpler || params;
}

function simplerTarget(state, side, title) {
  const foe = other(side);
  if (title === "Smoke Screen") return { zone: ownZone1(side) };
  if (title === "Sniper") {
    const soldier = state.soldiers.find((unit) => unit.owner === foe && isBattlefield(unit.loc));
    return soldier ? { soldierId: soldier.id } : null;
  }
  if (title === "Sabotage") {
    const dice = state.players[foe].dice;
    const index = dice.findIndex((face) => {
      if (!face) return false;
      const bucket = face === "wild" ? state.players[foe].wildAs : face;
      return Boolean(bucket) && remaining(state, foe, bucket) >= 1;
    });
    return index >= 0 ? { dieIndex: index } : null;
  }
  if (title === "Trench Fever" || title === "Bombing Run") {
    const exposed = title === "Trench Fever";
    const zone = BATTLEFIELD.find((candidate) => soldiersIn(state, candidate, exposed ? { side: foe, exposed: true } : { side: foe }).length);
    return zone ? { zone, targetKind: "exposed" } : null;
  }
  if (title === "Heavy Barrage") {
    const zone = BATTLEFIELD.find((candidate) => (
      controllerOf(state, candidate) === foe && soldiersIn(state, candidate, { side: foe, exposed: true }).length
    ));
    return zone ? { zone, targetKind: "exposed" } : null;
  }
  if (title === "Recon Flight") {
    const zone = BATTLEFIELD.find((candidate) => coversIn(state, candidate).some((cover) => !cover.revealed));
    return zone ? { zone } : null;
  }
  return null;
}

function hardEvent(state, side) {
  const action = pickEvent(state, side);
  if (!action?.params) return action;
  const card = state.players[side].eventHand.find((entry) => entry.inst === action.cardInst);
  if (!card) return action;
  const zone = hardZone(state, side, card.title);
  if (!zone) return action;
  return { ...action, params: { ...action.params, zone } };
}

function hardZone(state, side, title) {
  const foe = other(side);
  const gate = ownZone1(foe);
  const ok = (zone) => {
    if (title === "Recon Flight") return coversIn(state, zone).some((cover) => !cover.revealed);
    if (title === "Smoke Screen") return isBattlefield(zone);
    if (title === "Heavy Barrage") {
      return controllerOf(state, zone) === foe && soldiersIn(state, zone, { side: foe, exposed: true }).length > 0;
    }
    if (title === "Trench Fever") return soldiersIn(state, zone, { side: foe, exposed: true }).length > 0;
    if (title === "Bombing Run") return soldiersIn(state, zone, { side: foe }).length > 0;
    return false;
  };
  if (ok("obj")) return "obj";
  if (ok(gate)) return gate;
  return null;
}

function easyAttack(state, side) {
  if (state.effects.christmasTruce) return { type: "SKIP_ATTACK" };
  const single = firstSoldierShot(state, side);
  if (single) return single;
  const shot = pickAttack(state, side);
  if (!shot) return { type: "SKIP_ATTACK" };
  if (shot.type === "START_ATTACK" && shot.attackerIds?.length > 1) {
    return { ...shot, attackerIds: shot.attackerIds.slice(0, 1) };
  }
  return shot;
}

function firstSoldierShot(state, side) {
  const foe = other(side);
  const attacked = state.players[side].attackedIds;
  for (const zone of BATTLEFIELD) {
    const mine = soldiersIn(state, zone, { side }).filter((soldier) => soldierMayFire(soldier, attacked));
    for (const soldier of mine) {
      const origin = BATTLEFIELD.indexOf(soldier.loc);
      for (const targetZone of BATTLEFIELD) {
        if (Math.abs(BATTLEFIELD.indexOf(targetZone) - origin) > 1) continue;
        if (smoked(state, soldier.loc, targetZone)) continue;
        if (soldiersIn(state, targetZone, { side: foe, exposed: true }).length) {
          return {
            type: "START_ATTACK",
            kind: "infantry",
            attackerIds: [soldier.id],
            target: { kind: "exposed", zone: targetZone },
          };
        }
        const cover = soldierStrikeTargets(state, side, targetZone).find((target) => target.kind === "cover");
        if (cover) {
          return {
            type: "START_ATTACK",
            kind: "infantry",
            attackerIds: [soldier.id],
            target: { kind: "cover", zone: targetZone, coverId: cover.coverId },
          };
        }
      }
    }
  }
  return null;
}

function shotScore(side, target, attackerIds, flags) {
  let score = attackerIds.length;
  if (attackerIds.length > 1 || flags.mg) score += 30;
  if (flags.mg && attackerIds.length > 1) score += 20;
  if (target.zone === "obj") score += 100;
  if (target.zone === ownZone1(other(side))) score += 70;
  else if (enemySideZones(side).includes(target.zone)) score += 35;
  if (target.kind === "exposed") score += 8;
  else if (target.kind === "cover" || target.kind === "mg" || target.kind === "mortar") score += 4;
  if (flags.tank) score += 6;
  return score;
}

function hardInfantryOffers(state, side) {
  const offers = [];
  const seen = new Set();
  const attacked = state.players[side].attackedIds;
  for (const zone of BATTLEFIELD) {
    for (const strike of soldierStrikeTargets(state, side, zone)) {
      const target = { kind: strike.kind, zone: strike.zone };
      if (strike.coverId) target.coverId = strike.coverId;
      const key = `${target.kind}:${target.zone}:${target.coverId || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const soldiers = [];
      for (const soldier of state.soldiers) {
        if (soldier.owner !== side || !soldierMayFire(soldier, attacked)) continue;
        if (smoked(state, soldier.loc, target.zone)) continue;
        if (!canSoldierTarget(soldier, target)) continue;
        soldiers.push(soldier.id);
      }
      const mg = state.equipment.find((unit) => (
        unit.owner === side &&
        machineGunOperational(state, unit) &&
        zoneDistance(unit.loc, target.zone) <= 2 &&
        !smoked(state, unit.loc, target.zone)
      ));
      const attackerIds = mg ? [...soldiers, mg.id] : soldiers.slice();
      if (!attackerIds.length) continue;
      offers.push({
        score: shotScore(side, target, attackerIds, { mg: Boolean(mg) }),
        action: { type: "START_ATTACK", kind: "infantry", attackerIds, target },
      });
    }
  }
  for (const mg of state.equipment) {
    if (!machineGunOperational(state, mg) || mg.owner !== side) continue;
    for (const shot of machineGunTargets(state, mg)) {
      if (shot.kind !== "mg" && shot.kind !== "mortar") continue;
      const target = { kind: shot.kind, zone: shot.zone, unitId: shot.unitId };
      const key = `${target.kind}:${target.zone}:${target.unitId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      offers.push({
        score: shotScore(side, target, [mg.id], { mg: true }),
        action: { type: "START_ATTACK", kind: "infantry", attackerIds: [mg.id], target },
      });
    }
  }
  return offers;
}

function hardTankOffers(state, side) {
  const foe = other(side);
  const p = state.players[side];
  const tank = state.equipment.find((unit) => (
    unit.owner === side && unit.type === "tank" && isBattlefield(unit.loc) && !p.attackedIds.includes(unit.id)
  ));
  if (!tank) return [];
  const offers = [];
  const origin = BATTLEFIELD.indexOf(tank.loc);
  for (const zone of BATTLEFIELD) {
    if (Math.abs(BATTLEFIELD.indexOf(zone) - origin) > 1) continue;
    if (smoked(state, tank.loc, zone)) continue;
    if (soldiersIn(state, zone, { side: foe, exposed: true }).length) {
      const target = { kind: "exposed", zone };
      offers.push({
        score: shotScore(side, target, [tank.id], { tank: true }),
        action: { type: "START_ATTACK", kind: "tank", unitId: tank.id, target },
      });
    }
    const dug = soldierStrikeTargets(state, side, zone).find((shot) => shot.kind === "cover");
    if (dug) {
      const target = { kind: "cover", zone, coverId: dug.coverId };
      offers.push({
        score: shotScore(side, target, [tank.id], { tank: true }),
        action: { type: "START_ATTACK", kind: "tank", unitId: tank.id, target },
      });
    }
  }
  const engaged = state.equipment.some((unit) => unit.owner === foe && unit.type === "tank" && unit.loc === tank.loc);
  if (!engaged) {
    const cover = coversIn(state, tank.loc).find((token) => {
      const occ = soldiersIn(state, tank.loc, { matchCover: true, coverId: token.id });
      return occ.some((soldier) => soldier.owner === foe);
    });
    if (cover) {
      const target = { kind: "cover", zone: tank.loc, coverId: cover.id };
      offers.push({
        score: shotScore(side, target, [tank.id], { tank: true }) + 5,
        action: { type: "OVERRUN", unitId: tank.id, coverId: cover.id },
      });
    }
  }
  return offers;
}

function hardAttack(state, side) {
  if (state.effects.christmasTruce) return { type: "SKIP_ATTACK" };
  const offers = [...hardInfantryOffers(state, side), ...hardTankOffers(state, side)];
  if (offers.length) {
    offers.sort((a, b) => b.score - a.score);
    return offers[0].action;
  }
  return pickAttack(state, side);
}
