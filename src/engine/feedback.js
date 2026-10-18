import {
  BATTLEFIELD,
  canSoldierTarget,
  controllerOf,
  coversIn,
  enemySideZones,
  isBattlefield,
  machineGunOperational,
  machineGunTargets,
  other,
  ownTrench,
  ownZone1,
  sideZones,
  soldiersIn,
  stepZone,
  unitsIn,
  zoneDistance,
} from "./core.js";
import { hasShock, remaining } from "./dice.js";
import { canDeployMortar, machineGunsInSupply, tanksInSupply, tanksReadyToMove } from "./game.js";

export function coverCountdown(defense, hitsChosen, occupants = 0) {
  const defenseN = Math.max(0, Number(defense) || 0);
  const hits = Math.max(0, Number(hitsChosen) || 0);
  const inside = Math.max(0, Number(occupants) || 0);
  const absorbed = Math.min(hits, defenseN);
  const remainingDefense = defenseN - absorbed;
  const overflow = Math.max(0, hits - defenseN);
  const eliminated = Math.min(overflow, inside);
  const destroyed = hits >= defenseN;
  const nextDestroys = !destroyed && hits + 1 >= defenseN;
  const nextEliminates = destroyed && eliminated < inside;
  return {
    defense: defenseN,
    hits,
    remaining: remainingDefense,
    absorbed,
    overflow,
    eliminated,
    destroyed,
    nextDestroys,
    nextEliminates,
  };
}

export function coverCountdownText(defense, hitsChosen, occupants = 0) {
  const view = coverCountdown(defense, hitsChosen, occupants);
  const hits = view.hits;
  const word = hits === 1 ? "hit" : "hits";
  if (hits <= 0) {
    if (view.defense <= 1) return `Cover defense ${view.defense}. The next hit destroys this cover.`;
    return `Cover defense ${view.defense}. The next hit leaves defense ${view.defense - 1}.`;
  }
  if (view.nextDestroys) return `Defense ${view.remaining}. The next hit destroys this cover.`;
  if (!view.destroyed) return `Defense ${view.remaining} of ${view.defense} after ${hits} ${word}. The cover holds.`;
  if (view.nextEliminates && view.eliminated === 0) {
    const lead = hits === 1 ? "This hit destroys the cover." : "These hits destroy the cover.";
    return `${lead} A further hit eliminates a soldier.`;
  }
  if (view.nextEliminates) {
    const lost = view.eliminated === 1 ? "1 soldier eliminated" : `${view.eliminated} soldiers eliminated`;
    return `Cover destroyed. ${lost}. A further hit eliminates another.`;
  }
  if (view.eliminated) {
    const lost = view.eliminated === 1 ? "1 soldier eliminated" : `${view.eliminated} soldiers eliminated`;
    return `Cover destroyed. ${lost}.`;
  }
  if (hits === 1) return "This hit destroys the cover.";
  return `These ${hits} hits destroy the cover.`;
}

export function pinnedInitiative(state) {
  const init = state?.initiative;
  if (!init?.winner || !init.uk?.label || !init.de?.label) return null;
  return {
    winner: init.winner,
    tieRolls: init.tieRolls || 0,
    uk: init.uk.label,
    de: init.de.label,
    ukDice: Array.isArray(init.uk.dice) ? init.uk.dice.slice() : [],
    deDice: Array.isArray(init.de.dice) ? init.de.dice.slice() : [],
  };
}

export function attackPending(state) {
  const type = state?.pending?.type;
  return type === "allocate-hits" || type === "spotter" || type === "mortar-target";
}

export function sameActionSeat(before, after) {
  if (!before || !after || before.phase === "end" || after.phase === "end") return false;
  return before.phase === after.phase
    && before.actionStep === after.actionStep
    && before.active === after.active
    && before.round === after.round;
}

export function undoOffer(before, after, action, draft) {
  if (!before || !after || after.error || after.phase === "end") return { clear: true };
  const type = action?.type;
  if (type === "START_ATTACK" || type === "OVERRUN") {
    if (attackPending(after)) return { pending: true, before };
    if (!sameActionSeat(before, after)) return { clear: true };
    return { kind: "attack", before };
  }
  if (type === "PICK_SPOTTER" || type === "ALLOCATE_MORTAR" || type === "ALLOCATE_HITS") {
    const origin = draft || before;
    if (attackPending(after)) return { pending: true, before: origin };
    if (!sameActionSeat(origin, after)) return { clear: true };
    return { kind: "attack", before: origin };
  }
  if (type === "MOVE_UNIT" || type === "LEAVE_COVER_THEN_MOVE" || type === "MOVE_TANK") {
    if (!sameActionSeat(before, after)) return { clear: true };
    return { kind: "move", before };
  }
  return { clear: true };
}

function controlsAny(state, side) {
  return ["obj", ...sideZones(side), ...enemySideZones(side)].some((zone) => controllerOf(state, zone) === side);
}

function soldierCanReach(state, side, soldier) {
  const foe = other(side);
  for (const zone of BATTLEFIELD) {
    if (zoneDistance(soldier.loc, zone) > 1) continue;
    if (soldiersIn(state, zone, { side: foe, exposed: true }).length && canSoldierTarget(soldier, { kind: "exposed", zone })) {
      return true;
    }
    for (const cover of coversIn(state, zone)) {
      const inside = soldiersIn(state, zone, { matchCover: true, coverId: cover.id });
      if (inside.some((s) => s.owner === foe) && canSoldierTarget(soldier, { kind: "cover", zone })) return true;
    }
    for (const unit of unitsIn(state, zone, { side: foe })) {
      const kind = unit.type === "tank" ? "tank" : unit.type;
      if (canSoldierTarget(soldier, { kind, zone })) return true;
    }
  }
  return false;
}

function mortarReady(state, side, unit) {
  if (!unit || unit.owner !== side || unit.type !== "mortar" || !isBattlefield(unit.loc) || unit.damage >= 1) return false;
  const player = state.players[side];
  if ((player.attackedIds || []).includes(unit.id) || (player.movedEquip || []).includes(unit.id)) return false;
  if (state.effects?.suppression === "mortar" && unit.owner !== state.effects.suppressionBy) return false;
  return true;
}

function tankCanFire(state, side, tank) {
  if (!tank || (state.players[side].attackedIds || []).includes(tank.id)) return false;
  const foe = other(side);
  const engaged = unitsIn(state, tank.loc, { side: foe, type: "tank" }).length > 0;
  if (!engaged) {
    const cover = coversIn(state, tank.loc).find((token) => {
      const inside = soldiersIn(state, tank.loc, { matchCover: true, coverId: token.id });
      return !inside.some((s) => s.owner === side);
    });
    if (cover) return true;
  }
  for (const zone of BATTLEFIELD) {
    if (zoneDistance(tank.loc, zone) > 1) continue;
    if (state.effects?.smoke?.includes(tank.loc) || state.effects?.smoke?.includes(zone)) {
      if (tank.loc !== zone) continue;
    }
    if (soldiersIn(state, zone, { side: foe, exposed: true }).length) return true;
    if (coversIn(state, zone).some((token) => soldiersIn(state, zone, { matchCover: true, coverId: token.id }).some((s) => s.owner === foe))) {
      return true;
    }
  }
  return false;
}

function movePossible(state, side) {
  if (remaining(state, side, "boot") < 1) return false;
  const foot = Boolean(state.effects?.trenchFoot && side !== state.effects.trenchFootBy);
  const shovel = remaining(state, side, "shovel") >= 1;
  if (!foot) {
    for (const soldier of state.soldiers) {
      if (soldier.owner !== side) continue;
      if (soldier.coverId && !shovel) continue;
      const fromTrench = soldier.loc === ownTrench(side);
      if (!fromTrench && !isBattlefield(soldier.loc)) continue;
      for (const dir of ["forward", "back"]) {
        const dest = stepZone(side, soldier.loc, dir);
        if (!dest || !isBattlefield(dest)) continue;
        if (fromTrench && (dir !== "forward" || dest !== ownZone1(side))) continue;
        return true;
      }
    }
  }
  const player = state.players[side];
  for (const unit of state.equipment) {
    if (unit.owner !== side || unit.type === "tank" || !isBattlefield(unit.loc) || unit.damage >= 1) continue;
    if ((player.firedEquip || []).includes(unit.id)) continue;
    for (const dir of ["forward", "back"]) {
      const dest = stepZone(side, unit.loc, dir);
      if (dest && isBattlefield(dest)) return true;
    }
  }
  return false;
}

function shovelWork(state, side) {
  for (const soldier of state.soldiers) {
    if (soldier.owner !== side) continue;
    if (soldier.coverId) return true;
    if (!isBattlefield(soldier.loc)) continue;
    for (const cover of coversIn(state, soldier.loc)) {
      const occ = soldiersIn(state, soldier.loc, { matchCover: true, coverId: cover.id });
      if (occ.length < 3 && !occ.some((s) => s.owner !== side)) return true;
    }
  }
  if (state.coverSupply?.length) {
    for (const zone of BATTLEFIELD) {
      if (controllerOf(state, zone) === side) return true;
    }
  }
  for (const cover of state.covers || []) {
    if (cover.destroyed) continue;
    if (soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id }).length) continue;
    for (const zone of BATTLEFIELD) {
      if (zoneDistance(cover.loc, zone) !== 1) continue;
      if (controllerOf(state, zone) === side) return true;
    }
  }
  return false;
}

function deployPossible(state, side) {
  const bayonets = remaining(state, side, "bayonet");
  if (bayonets < 1) return false;
  const player = state.players[side];
  const available = state.soldiers.some((s) => s.owner === side && s.loc === "available");
  if (!player.soldierDeployed && available && controlsAny(state, side)) return true;
  if (state.equipment.some((unit) => unit.owner === side && isBattlefield(unit.loc) && unit.damage >= 1)) return true;
  if (bayonets >= 2 && canDeployMortar(state, side)) return true;
  if (bayonets >= 3 && machineGunsInSupply(state, side) > 0 && sideZones(side).some((zone) => controllerOf(state, zone) === side)) {
    return true;
  }
  if (bayonets >= 4 && tanksInSupply(state, side) > 0) return true;
  return false;
}

export function emptyStepReason(state, side) {
  if (!state || !side) return "";
  const step = state.actionStep;
  if (step === "shock") {
    if (!hasShock(state, side)) return "No five matching dice, so there is no Shock.";
    return "";
  }
  if (step === "tank") {
    if (tanksReadyToMove(state, side).length) return "";
    const tanks = state.equipment.filter((unit) => unit.owner === side && unit.type === "tank" && isBattlefield(unit.loc));
    if (!tanks.length) return "No tank is on the field.";
    if (state.effects?.boggedDown && side !== state.effects.boggedDownBy) return "The tank is bogged down.";
    const foe = other(side);
    if (tanks.every((tank) => unitsIn(state, tank.loc, { side: foe, type: "tank" }).length)) return "The tank is engaged.";
    if (tanks.every((tank) => (state.players[side].movedTanks || []).includes(tank.id))) return "The tank already moved.";
    return "No tank can advance.";
  }
  if (step === "event") {
    if (remaining(state, side, "whistle") < 1) return "No Whistle.";
    const cards = (state.players[side].eventHand || []).filter((card) => card.title !== "General's Order");
    if (!cards.length) return "No event can be played.";
    return "";
  }
  if (step === "deploy") {
    if (remaining(state, side, "bayonet") < 1) return "No bayonets left.";
    if (!deployPossible(state, side)) return "No deployment is legal.";
    return "";
  }
  if (step === "move") {
    if (remaining(state, side, "boot") < 1) return "No Boot.";
    if (!movePossible(state, side)) return "No soldier or support weapon can move.";
    return "";
  }
  if (step === "cover") {
    if (remaining(state, side, "shovel") < 1) return "No Shovel.";
    if (!shovelWork(state, side)) return "No shovel use.";
    return "";
  }
  if (step === "attack") {
    if (state.effects?.christmasTruce) return "Christmas Truce: no attacks.";
    const player = state.players[side];
    const fresh = state.soldiers.filter((s) => s.owner === side && isBattlefield(s.loc) && !(player.attackedIds || []).includes(s.id));
    if (fresh.some((soldier) => soldierCanReach(state, side, soldier))) return "";
    if (state.equipment.some((unit) => mortarReady(state, side, unit))) return "";
    if (state.equipment.some((unit) => unit.owner === side && machineGunOperational(state, unit) && machineGunTargets(state, unit).length)) return "";
    const tanks = state.equipment.filter((unit) => unit.owner === side && unit.type === "tank" && isBattlefield(unit.loc) && !(player.attackedIds || []).includes(unit.id));
    if (tanks.some((tank) => tankCanFire(state, side, tank))) return "";
    if (fresh.length) return "No soldier in range.";
    const foe = other(side);
    if (tanks.length && tanks.every((tank) => unitsIn(state, tank.loc, { side: foe, type: "tank" }).length)) return "The tank is engaged.";
    return "";
  }
  return "";
}

export const EMPTY_SKIP = {
  shock: "SKIP_SHOCK",
  tank: "SKIP_TANK",
  event: "SKIP_EVENT",
  deploy: "SKIP_DEPLOY",
  move: "SKIP_MOVE",
  cover: "SKIP_COVER",
  attack: "SKIP_ATTACK",
};
