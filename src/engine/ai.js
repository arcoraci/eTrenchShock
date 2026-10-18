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
} from "./core.js";
import { remaining, hasShock, naturalFaces, unusedDice } from "./dice.js";
import { eventNeeds, bayonetDestinations } from "./events.js";
import { tanksReadyToMove } from "./game.js";

const HOSTILE = new Set(["Bayonet Charge", "Bombing Run", "Heavy Barrage", "Sniper", "Trench Fever"]);

export function chooseAiAction(state) {
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
