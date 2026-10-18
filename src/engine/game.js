import {
  clone,
  log,
  labelSide,
  other,
  ownZone1,
  ownTrench,
  enemyTrench,
  enemySideZones,
  sideZones,
  stepZone,
  zoneDistance,
  isBattlefield,
  refreshControl,
  soldiersIn,
  unitsIn,
  controllerOf,
  ZONE_LABELS,
  smoked,
  canSoldierTarget,
} from "./core.js";
import { beginInitiative } from "./setup.js";
import {
  rollAllAction,
  rerollKept,
  lockInitiative,
  comboLabel,
  commitDice,
  remaining,
  spend,
  spendSelected,
  hasShock,
  rollHits,
  rollMortarDie,
  rollActionDie,
  canRegroup,
} from "./dice.js";
import { playEvent, discardEvent } from "./events.js";
import { checkMissions, drawMission, trimMissions } from "./missions.js";
import { applyHits, allocationOptions, allocationReady, applyAllocatedHits, eliminateSoldier, revealAttackedCover, takeCoverTrophy } from "./combat.js";

const STEPS = ["shock", "tank", "event", "deploy", "move", "cover", "attack"];

export function isInteractive(state, side) {
  if (state.mode === "sim") return false;
  if (state.mode === "hotseat") return true;
  return side === state.human;
}

export function apply(state, action) {
  const next = clone(state);
  try {
    handle(next, action || {});
    next.error = null;
    return next;
  } catch (err) {
    const failed = clone(state);
    const message = err?.message || String(err);
    log(failed, `Action failed: ${message}`);
    failed.error = message;
    return failed;
  }
}

function handle(state, action) {
  state.error = null;
  if (state.pending?.type === "spotter" && action.type !== "PICK_SPOTTER") {
    throw new Error("Choose a mortar result first.");
  }
  if (state.pending?.type === "mortar-target" && action.type !== "ALLOCATE_MORTAR") {
    throw new Error("Choose where the mortar hit lands.");
  }
  if (state.pending?.type === "gambit" && action.type !== "PICK_GAMBIT" && action.type !== "FINISH_GAMBIT") {
    throw new Error("Finish the Mission Gambit first.");
  }
  if (state.pending?.type === "allocate-hits" && action.type !== "ALLOCATE_HITS") {
    throw new Error("Assign the hits first.");
  }
  const handlers = {
    ROLL_1: () => doRoll1(state),
    GENERALS_ORDER: () => doGeneralsOrder(state, action),
    SKIP_GENERALS_ORDER: () => finishGeneralsOrder(state),
    TOGGLE_KEEP: () => toggleKeep(state, action),
    REROLL: () => doReroll(state, action),
    COMMIT: () => doCommit(state, action),
    SHOCK: () => doShock(state, action),
    SKIP_SHOCK: () => advanceStep(state),
    MOVE_TANK: () => moveTank(state, action),
    SKIP_TANK: () => advanceStep(state),
    PLAY_EVENT: () => doPlayEvent(state, action),
    SKIP_EVENT: () => advanceStep(state),
    DEPLOY: () => doDeploy(state, action),
    REPAIR: () => doRepair(state, action),
    SKIP_DEPLOY: () => advanceStep(state),
    MOVE_UNIT: () => doMove(state, action),
    LEAVE_COVER_THEN_MOVE: () => leaveThenMove(state, action),
    SKIP_MOVE: () => advanceStep(state),
    SHOVEL: () => doShovel(state, action),
    SKIP_COVER: () => advanceStep(state),
    START_ATTACK: () => startAttack(state, action),
    RESOLVE_ATTACK: () => resolveAttack(state, action),
    PICK_SPOTTER: () => pickSpotter(state, action),
    ALLOCATE_MORTAR: () => allocateMortar(state, action),
    ALLOCATE_HITS: () => allocateHits(state, action),
    PICK_GAMBIT: () => pickGambit(state, action),
    FINISH_GAMBIT: () => finishGambit(state, action),
    OVERRUN: () => doOverrun(state, action),
    SKIP_ATTACK: () => finishActionPhase(state),
    REGROUP_DRAW: () => regroupDraw(state, action),
    REGROUP_EXCHANGE: () => regroupExchange(state),
    SKIP_REGROUP: () => skipRegroup(state),
  };
  const fn = handlers[action.type];
  if (!fn) throw new Error(`Unknown action ${action.type}`);
  fn();
  if (state.missionExhausted && state.phase !== "end") endGame(state, "Mission Exhaustion");
}

function hasGeneralOrder(state, side) {
  const p = state.players[side];
  return !p.generalsOrderUsed && p.eventHand.some((c) => c.title === "General's Order");
}

function doRoll1(state) {
  rollAllAction(state, "uk");
  rollAllAction(state, "de");
  log(
    state,
    `Roll 1 — Britain: ${comboLabel(state.players.uk.dice)}. Germany: ${comboLabel(state.players.de.dice)}. Wilds ignored.`,
  );
  const queue = ["uk", "de"].filter((side) => hasGeneralOrder(state, side) && isInteractive(state, side));
  for (const side of ["uk", "de"]) {
    if (hasGeneralOrder(state, side) && !isInteractive(state, side)) autoGenerals(state, side);
  }
  if (queue.length) {
    state.pending = { type: "generals-order", side: queue[0], queue };
    return;
  }
  afterRoll1(state);
}

function autoGenerals(state, side) {
  const p = state.players[side];
  const card = p.eventHand.find((c) => c.title === "General's Order");
  if (!card || p.generalsOrderUsed) return;
  const boots = p.dice.filter((f) => f === "boot").length;
  const wilds = p.dice.filter((f) => f === "wild").length;
  if (boots + wilds >= 2) return;
  const i = p.dice.findIndex((f) => f !== "boot" && f !== "wild");
  if (i < 0) return;
  p.dice[i] = "boot";
  discardEvent(state, side, card.inst);
  p.generalsOrderUsed = true;
  log(state, `${labelSide(side)} plays General's Order and changes a die to Boot.`);
}

function doGeneralsOrder(state, action) {
  const side = action.side || state.pending?.side || state.human;
  if (state.pending?.type !== "generals-order" || state.pending.side !== side) {
    throw new Error("General's Order is not available.");
  }
  const p = state.players[side];
  const card = p.eventHand.find((c) => c.title === "General's Order");
  if (!card) throw new Error("No General's Order in hand.");
  if (action.mode === "reroll") {
    const indexes = (action.indexes || []).filter((i) => i >= 0 && i < 5).slice(0, 2);
    if (!indexes.length) throw new Error("Choose up to two dice to reroll.");
    for (const i of indexes) p.dice[i] = rollActionDie(state);
  } else if (action.mode === "change") {
    const i = action.index;
    const to = action.to;
    if (i == null || i < 0 || i >= 5) throw new Error("Choose a die to change.");
    if (!["boot", "whistle", "shovel", "bayonet"].includes(to)) {
      throw new Error("Choose a Boot, Whistle, Shovel, or Bayonet.");
    }
    if (!p.dice.some((f) => f === to)) throw new Error("Must match a natural face from Roll 1.");
    p.dice[i] = to;
  } else {
    throw new Error("Choose how to use General's Order.");
  }
  discardEvent(state, side, card.inst);
  p.generalsOrderUsed = true;
  log(state, `${labelSide(side)} plays General's Order.`);
  finishGeneralsOrder(state);
}

function finishGeneralsOrder(state) {
  const queue = (state.pending?.queue || []).slice(1);
  if (queue.length) {
    state.pending = { type: "generals-order", side: queue[0], queue };
    return;
  }
  afterRoll1(state);
}

function afterRoll1(state) {
  let tieRolls = 0;
  let locked = lockInitiative(state, tieRolls);
  while (!locked) {
    tieRolls += 1;
    log(state, "Initiative tied — both sides reroll all five dice. The tied roll is discarded.");
    rollAllAction(state, "uk");
    rollAllAction(state, "de");
    locked = lockInitiative(state, tieRolls);
  }
  const winner = locked.winner;
  state.player1 = winner;
  const from = tieRolls ? "the deciding roll" : "Roll 1";
  log(
    state,
    `${labelSide(winner)} wins Initiative from ${from} — Britain: ${locked.uk.label}. Germany: ${locked.de.label}. ${labelSide(winner)} will act first.`,
  );
  state.phase = "reroll";
  state.active = other(winner);
  state.players.uk.rollsUsed = 1;
  state.players.de.rollsUsed = 1;
  state.pending = { type: "reroll", side: state.active };
}

function toggleKeep(state, action) {
  const side = state.active;
  if (state.phase !== "reroll" || side !== action.side) return;
  const p = state.players[side];
  const i = action.index;
  if (i < 0 || i >= p.dice.length) return;
  p.kept[i] = !p.kept[i];
}

function doReroll(state, action) {
  if (state.phase !== "reroll") throw new Error("Rerolls are not open.");
  const side = state.active;
  if (action.side && action.side !== side) throw new Error("You can only reroll your own dice.");
  const p = state.players[side];
  if (!p || p.committed) throw new Error("Those dice are already committed.");
  if (p.rollsUsed >= 3) throw new Error("No rerolls remaining.");
  const keep = action.keep || p.kept;
  if (!Array.isArray(keep) || keep.length !== 5) throw new Error("Keep five dice.");
  if (keep.every(Boolean)) throw new Error("Set aside at least one die to reroll.");
  rerollKept(state, side, keep);
  log(state, `${labelSide(side)} rerolls (Roll ${p.rollsUsed}).`);
}

function doCommit(state, action) {
  const side = state.active;
  commitDice(state, side, action.wildAs);
  if (side === other(state.player1)) {
    state.active = state.player1;
    state.pending = { type: "reroll", side: state.player1 };
  } else {
    startActionPhase(state, state.player1);
  }
}

function controlsAZone(state, side) {
  return ["obj", ...sideZones(side), ...enemySideZones(side)].some((zone) => controllerOf(state, zone) === side);
}

function tankMayAdvance(state, unit) {
  if (!unit || unit.type !== "tank" || !isBattlefield(unit.loc)) return false;
  if (state.effects.boggedDown && unit.owner !== state.effects.boggedDownBy) return false;
  if ((state.players[unit.owner].movedTanks || []).includes(unit.id)) return false;
  if (unitsIn(state, unit.loc, { side: other(unit.owner), type: "tank" }).length) return false;
  return true;
}

export function tanksReadyToMove(state, side) {
  return state.equipment.filter((unit) => unit.owner === side && tankMayAdvance(state, unit));
}

function movableTank(state, side) {
  return tanksReadyToMove(state, side)[0] || null;
}

function finishTankMove(state, tank) {
  const moved = state.players[tank.owner].movedTanks || (state.players[tank.owner].movedTanks = []);
  if (!moved.includes(tank.id)) moved.push(tank.id);
  if (movableTank(state, state.active)) return;
  advanceStep(state);
}

function shouldSkipStep(state, side, step) {
  if (step === "shock") return !hasShock(state, side);
  if (step === "tank") return !movableTank(state, side);
  if (step === "event") {
    if (remaining(state, side, "whistle") < 1) return true;
    return !state.players[side].eventHand.some((c) => c.title !== "General's Order");
  }
  if (step === "deploy") {
    const bayonets = remaining(state, side, "bayonet");
    const supply = state.equipment.some((u) => u.owner === side && u.loc === "supply");
    const damaged = state.equipment.some((u) => u.owner === side && isBattlefield(u.loc) && u.damage >= 1);
    const available = state.soldiers.some((s) => s.owner === side && s.loc === "available");
    const held = controlsAZone(state, side);
    if (bayonets >= 1 && !state.players[side].soldierDeployed && available && held) return false;
    if (bayonets >= 2 && supply) return false;
    if (bayonets >= 1 && damaged) return false;
    return true;
  }
  if (step === "move") return remaining(state, side, "boot") < 1;
  if (step === "cover") return remaining(state, side, "shovel") < 1;
  if (step === "attack") {
    if (state.effects.christmasTruce) return true;
    const p = state.players[side];
    const troops = state.soldiers.some(
      (s) => s.owner === side && isBattlefield(s.loc) && !p.attackedIds.includes(s.id),
    );
    const guns = state.equipment.some(
      (u) => u.owner === side && isBattlefield(u.loc) && !p.attackedIds.includes(u.id) && (u.type === "tank" || u.damage < 1),
    );
    return !troops && !guns;
  }
  return false;
}

function startActionPhase(state, side) {
  state.phase = "action";
  state.active = side;
  state.actionStep = "shock";
  state.pending = { type: "action", step: "shock" };
  log(state, `${labelSide(side)} begins the Action Phase.`);
  if (shouldSkipStep(state, side, "shock")) advanceStep(state);
}

function advanceStep(state) {
  let i = STEPS.indexOf(state.actionStep);
  while (true) {
    i += 1;
    if (i >= STEPS.length) return finishActionPhase(state);
    const nxt = STEPS[i];
    if (shouldSkipStep(state, state.active, nxt)) continue;
    state.actionStep = nxt;
    state.pending = { type: "action", step: nxt };
    if (nxt === "event") state.players[state.active].eventsAtStep = state.players[state.active].eventHand.map((c) => c.inst);
    return;
  }
}

function doShock(state, action) {
  if (state.actionStep !== "shock") throw new Error("Not the Shock step.");
  if (!hasShock(state, state.active)) throw new Error("Need five matching Action Dice.");
  if (action.option === "gambit") missionGambit(state, state.active);
  else if (action.option === "gas") {
    const p = state.players[state.active];
    p.spent = { boot: 99, shovel: 99, bayonet: 99, whistle: 99 };
    mustardGas(state, state.active);
  } else throw new Error("Choose a Shock option.");
  if (state.phase === "end" || state.pending?.type === "gambit") return;
  advanceStep(state);
}

function missionGambit(state, side) {
  log(state, `${labelSide(side)} uses Shock: Mission Gambit. The five dice stay available.`);
  const first = drawMission(state, true);
  const second = first ? drawMission(state, true) : null;
  if (state.missionExhausted) {
    if (first) state.players[side].missionHand.push(first);
    endGame(state, "Mission Exhaustion");
    return;
  }
  const drawn = [first, second].filter(Boolean);
  if (!drawn.length) return;
  if (isInteractive(state, side) && drawn.length === 2) {
    state.pending = { type: "gambit", side, stage: "keep", cards: drawn };
    return;
  }
  const keep = drawn.slice().sort((a, b) => b.vp - a.vp)[0];
  state.players[side].missionHand.push(keep);
  for (const card of drawn) if (card !== keep) state.missionDeck.push(card);
  checkMissions(state, side, { timing: "immediate" });
  trimMissions(state, side);
  if (state.missionExhausted) endGame(state, "Mission Exhaustion");
}

function pickGambit(state, action) {
  const pending = state.pending;
  if (pending?.type !== "gambit" || pending.stage !== "keep") throw new Error("No Mission Gambit choice is waiting.");
  const keep = pending.cards.find((c) => c.inst === action.inst) || pending.cards[0];
  state.players[pending.side].missionHand.push(keep);
  for (const card of pending.cards) if (card !== keep) state.missionDeck.push(card);
  log(state, `${labelSide(pending.side)} keeps ${keep.title}.`);
  checkMissions(state, pending.side, { timing: "immediate" });
  state.pending = { type: "gambit", side: pending.side, stage: "swap" };
  if (state.missionExhausted) endGame(state, "Mission Exhaustion");
}

function finishGambit(state, action) {
  const pending = state.pending;
  if (pending?.type !== "gambit" || pending.stage !== "swap") throw new Error("No Mission Gambit swap is waiting.");
  const side = pending.side;
  const hand = state.players[side].missionHand;
  if (action.discard) {
    const i = hand.findIndex((c) => c.inst === action.discard);
    if (i >= 0) {
      const [dropped] = hand.splice(i, 1);
      state.missionDeck.push(dropped);
      const replacement = drawMission(state, true);
      if (replacement) hand.push(replacement);
      log(state, `${labelSide(side)} swaps ${dropped.title}.`);
    }
  }
  trimMissions(state, side);
  state.pending = { type: "action", step: "shock" };
  if (state.missionExhausted) {
    endGame(state, "Mission Exhaustion");
    return;
  }
  checkMissions(state, side, { timing: "immediate" });
  if (state.missionExhausted) {
    endGame(state, "Mission Exhaustion");
    return;
  }
  advanceStep(state);
}

function mustardGas(state, side) {
  log(state, `${labelSide(side)} uses Shock: Mustard Gas.`);
  if (state.effects.christmasTruce) {
    log(state, "Christmas Truce prevents Mustard Gas.");
    clearAttackReadout(state);
    return;
  }
  const foe = other(side);
  const zones = [];
  let eliminated = 0;
  for (const zone of enemySideZones(side)) {
    const result = rollHits(state, 3);
    const exposed = soldiersIn(state, zone, { side: foe, exposed: true });
    const n = Math.min(result.hits, exposed.length);
    for (let i = 0; i < n; i += 1) eliminateSoldier(state, exposed[i]);
    eliminated += n;
    log(state, `Mustard Gas over ${ZONE_LABELS[zone]}: ${result.hits} Hit(s), ${n} eliminated.`);
    zones.push({ zone, faces: result.faces.slice(), hits: result.hits });
  }
  if (eliminated) state.roundElim[side] = (state.roundElim[side] || 0) + eliminated;
  state.lastRoll = { kind: "mustard", zones };
  refreshControl(state);
  if (eliminated) checkMissions(state, side, { timing: "immediate" });
  clearAttackReadout(state);
}

function moveTank(state, action) {
  const tank = state.equipment.find(
    (u) => u.id === action.unitId && u.type === "tank" && u.owner === state.active,
  );
  if (!tank || !isBattlefield(tank.loc)) throw new Error("That Tank is not on the battlefield.");
  if (state.effects.boggedDown && tank.owner !== state.effects.boggedDownBy) {
    throw new Error("Bogged Down: enemy Tanks cannot move.");
  }
  if (unitsIn(state, tank.loc, { side: other(tank.owner), type: "tank" }).length) {
    throw new Error("Engaged Tanks cannot leave while an enemy Tank remains.");
  }
  if ((state.players[tank.owner].movedTanks || []).includes(tank.id)) {
    throw new Error("That Tank already moved.");
  }
  const steps = Math.max(0, Math.min(2, action.steps || 0));
  if (!steps) throw new Error("Choose how far the Tank advances.");
  for (let n = 0; n < steps; n += 1) {
    const nxt = stepZone(tank.owner, tank.loc, "forward");
    if (!nxt) break;
    if (isBattlefield(nxt) && unitsIn(state, nxt, { side: other(tank.owner), type: "tank" }).length) {
      tank.loc = nxt;
      log(state, `${labelSide(tank.owner)} Tank stops in ${ZONE_LABELS[nxt]} (enemy Tank).`);
      break;
    }
    if (nxt === enemyTrench(tank.owner)) {
      state.vp[tank.owner] += 3;
      log(state, `${labelSide(tank.owner)} Tank breaks into the enemy Trench (+3 VP).`);
      tank.loc = "supply";
      tank.damage = 0;
      refreshControl(state, { tankLeft: true });
      checkMissions(state, tank.owner, { timing: "immediate" });
      return finishTankMove(state, tank);
    }
    const left = tank.loc;
    tank.loc = nxt;
    state.hadTank[left] = true;
    log(state, `${labelSide(tank.owner)} Tank advances to ${ZONE_LABELS[nxt]}.`);
  }
  refreshControl(state);
  checkMissions(state, state.active, { timing: "immediate" });
  finishTankMove(state, tank);
}

function doPlayEvent(state, action) {
  const side = state.active;
  if (state.actionStep !== "event") throw new Error("Not the Event step.");
  const card = state.players[side].eventHand.find((c) => c.inst === action.cardInst);
  if (!card) throw new Error("Card is not in hand.");
  if (card.title === "General's Order") throw new Error("General's Order is only played after Roll 1.");
  const opened = state.players[side].eventsAtStep;
  if (opened && !opened.includes(card.inst)) throw new Error("That Event was not in hand when the Event Step began.");
  if (card.whistle !== false && !action.free) {
    if (remaining(state, side, "whistle") < 1) throw new Error("Need a Whistle to play an Event.");
    spend(state, side, "whistle", 1);
  }
  playEvent(state, side, card, action.params || {});
  discardEvent(state, side, card.inst);
  refreshControl(state);
  checkMissions(state, side, { timing: "immediate" });
}

function payBayonets(state, side, cost, indexes) {
  const word = cost === 1 ? "Bayonet" : "Bayonets";
  if (Array.isArray(indexes)) {
    if (indexes.length !== cost) throw new Error(`Select ${cost} ${word}.`);
    spendSelected(state, side, "bayonet", indexes);
    return;
  }
  if (isInteractive(state, side)) throw new Error("Select the bayonet dice to spend.");
  if (remaining(state, side, "bayonet") < cost) throw new Error(`Need ${cost} ${word}.`);
  spend(state, side, "bayonet", cost);
}

function equipmentInSupply(state, side, type) {
  return state.equipment.filter((unit) => unit.owner === side && unit.type === type && unit.loc === "supply").length;
}

export function mortarsInSupply(state, side) {
  return equipmentInSupply(state, side, "mortar");
}

export function machineGunsInSupply(state, side) {
  return equipmentInSupply(state, side, "mg");
}

export function tanksInSupply(state, side) {
  return equipmentInSupply(state, side, "tank");
}

export function canDeployMortar(state, side) {
  return mortarsInSupply(state, side) > 0 && controllerOf(state, ownZone1(side)) === side;
}

function doDeploy(state, action) {
  const side = state.active;
  if (state.actionStep !== "deploy") throw new Error("Not the Deploy step.");
  const kind = action.kind;
  const zone = action.zone;
  if (kind === "mortar") {
    if (remaining(state, side, "bayonet") < 2) throw new Error("Need 2 Bayonets.");
    if (zone !== ownZone1(side)) throw new Error("Mortars deploy into your Zone 1.");
    if (controllerOf(state, zone) !== side) throw new Error("You must control Zone 1.");
    const unit = state.equipment.find((e) => e.owner === side && e.type === "mortar" && e.loc === "supply");
    if (!unit) throw new Error("All Mortars are already deployed.");
    payBayonets(state, side, 2, action.indexes);
    unit.loc = zone;
    unit.damage = 0;
    log(state, `${labelSide(side)} deploys a Mortar in ${ZONE_LABELS[zone]}.`);
  } else if (kind === "mg") {
    if (remaining(state, side, "bayonet") < 3) throw new Error("Need 3 Bayonets.");
    if (!sideZones(side).includes(zone)) throw new Error("Machine Guns deploy on your own side.");
    if (controllerOf(state, zone) !== side) throw new Error("You must control that zone.");
    const unit = state.equipment.find((e) => e.owner === side && e.type === "mg" && e.loc === "supply");
    if (!unit) throw new Error("All Machine Guns are already deployed.");
    payBayonets(state, side, 3, action.indexes);
    unit.loc = zone;
    unit.damage = 0;
    log(state, `${labelSide(side)} deploys a Machine Gun in ${ZONE_LABELS[zone]}.`);
  } else if (kind === "tank") {
    if (remaining(state, side, "bayonet") < 4) throw new Error("Need 4 Bayonets.");
    const unit = state.equipment.find((e) => e.owner === side && e.type === "tank" && e.loc === "supply");
    if (!unit) throw new Error("All Tanks are already deployed.");
    payBayonets(state, side, 4, action.indexes);
    unit.loc = ownZone1(side);
    unit.damage = 0;
    log(state, `${labelSide(side)} deploys a Tank in ${ZONE_LABELS[unit.loc]}.`);
  } else if (kind === "soldier") {
    const p = state.players[side];
    if (p.soldierDeployed) throw new Error("You may deploy only one Soldier this round.");
    if (remaining(state, side, "bayonet") < 1) throw new Error("Need 1 Bayonet.");
    if (!isBattlefield(zone) || controllerOf(state, zone) !== side) throw new Error("Deploy the Soldier into a battlefield zone you control.");
    const soldier = state.soldiers.find((s) => s.owner === side && s.loc === "available");
    if (!soldier) throw new Error("No Soldier in supply.");
    payBayonets(state, side, 1, action.indexes);
    soldier.loc = zone;
    soldier.coverId = null;
    p.soldierDeployed = true;
    log(state, `${labelSide(side)} deploys a Soldier into ${ZONE_LABELS[zone]}.`);
  } else {
    throw new Error("Unknown deployment.");
  }
  refreshControl(state);
  checkMissions(state, side, { timing: "immediate" });
}

function doRepair(state, action) {
  const side = state.active;
  if (state.actionStep !== "deploy") throw new Error("Not the Deploy step.");
  if (remaining(state, side, "bayonet") < 1) throw new Error("Need 1 Bayonet.");
  const unit = state.equipment.find((e) => e.id === action.unitId && e.owner === side && isBattlefield(e.loc));
  if (!unit || unit.damage < 1) throw new Error("That Unit does not need repair.");
  payBayonets(state, side, 1, action.indexes);
  unit.damage -= 1;
  log(state, `${labelSide(side)} repairs the ${capType(unit.type)} (${unit.damage} Damage left).`);
  refreshControl(state);
}

function capType(type) {
  return { mg: "Machine Gun", mortar: "Mortar", tank: "Tank" }[type] || type;
}

function doMove(state, action) {
  const side = state.active;
  if (state.actionStep !== "move") throw new Error("Not the Move step.");
  if (action.kind === "soldier") {
    const soldier = state.soldiers.find((x) => x.id === action.unitId && x.owner === side);
    if (!soldier) throw new Error("Soldier not found.");
    if (state.effects.trenchFoot && soldier.owner !== state.effects.trenchFootBy) {
      throw new Error("Trench Foot prevents Soldier movement.");
    }
    if (soldier.coverId) throw new Error("Soldiers in Cover must Leave Cover first.");
    if (remaining(state, side, "boot") < 1) throw new Error("Need a Boot.");
    const fromTrench = soldier.loc === ownTrench(side);
    if (!fromTrench && !isBattlefield(soldier.loc)) throw new Error("That Soldier is not on the battlefield.");
    const dest = stepZone(side, soldier.loc, action.dir);
    if (!dest || !isBattlefield(dest)) throw new Error("Illegal destination.");
    if (fromTrench && (action.dir !== "forward" || dest !== ownZone1(side))) {
      throw new Error("A Soldier leaves the Trench only by advancing into Zone 1.");
    }
    spend(state, side, "boot", 1);
    soldier.loc = dest;
    soldier.coverId = null;
    log(state, `${labelSide(side)} Soldier moves ${action.dir} to ${ZONE_LABELS[dest]}.`);
  } else {
    const unit = state.equipment.find((e) => e.id === action.unitId && e.owner === side);
    if (!unit || unit.type === "tank") throw new Error("Illegal Unit.");
    if (unit.damage >= 1) throw new Error("Damaged support weapons cannot move.");
    if (state.players[side].firedEquip.includes(unit.id)) throw new Error("That Unit already attacked.");
    if (remaining(state, side, "boot") < 1) throw new Error("Need a Boot.");
    const dest = stepZone(side, unit.loc, action.dir);
    if (!dest || !isBattlefield(dest)) throw new Error("Illegal destination.");
    spend(state, side, "boot", 1);
    unit.loc = dest;
    state.players[side].movedEquip.push(unit.id);
    log(state, `${labelSide(side)} ${capType(unit.type)} moves to ${ZONE_LABELS[dest]}.`);
  }
  refreshControl(state);
  checkMissions(state, side, { timing: "immediate" });
}

function leaveThenMove(state, action) {
  const side = state.active;
  if (remaining(state, side, "shovel") < 1) throw new Error("Need a Shovel to Leave Cover.");
  const soldier = state.soldiers.find((x) => x.id === action.unitId && x.owner === side);
  if (!soldier?.coverId) throw new Error("Soldier is not in Cover.");
  spend(state, side, "shovel", 1);
  soldier.coverId = null;
  log(state, `${labelSide(side)} Soldier leaves Cover.`);
  doMove(state, { ...action, kind: "soldier" });
}

function doShovel(state, action) {
  const side = state.active;
  if (state.actionStep !== "cover") throw new Error("Not the Cover step.");
  if (remaining(state, side, "shovel") < 1) throw new Error("Need a Shovel.");
  const mode = action.mode;
  if (mode === "dig") {
    const soldier = state.soldiers.find((x) => x.id === action.soldierId && x.owner === side);
    if (!soldier || soldier.coverId || !isBattlefield(soldier.loc)) throw new Error("Illegal Dig In.");
    const cover = state.covers.find((c) => c.id === action.coverId && c.loc === soldier.loc && !c.destroyed);
    if (!cover) throw new Error("No such Cover.");
    const occ = soldiersIn(state, soldier.loc, { matchCover: true, coverId: cover.id });
    if (occ.some((o) => o.owner !== side)) throw new Error("Opposing Soldiers may not share Cover.");
    if (occ.length >= 3) throw new Error("Cover capacity is 3.");
    spend(state, side, "shovel", 1);
    soldier.coverId = cover.id;
    log(state, `${labelSide(side)} Soldier Digs In.`);
  } else if (mode === "leave") {
    const soldier = state.soldiers.find((x) => x.id === action.soldierId && x.owner === side);
    if (!soldier?.coverId) throw new Error("Not in Cover.");
    spend(state, side, "shovel", 1);
    soldier.coverId = null;
    log(state, `${labelSide(side)} Soldier leaves Cover.`);
  } else if (mode === "prepare") {
    const zone = action.zone;
    if (controllerOf(state, zone) !== side) throw new Error("Prepare Position requires Control.");
    if (!state.coverSupply.length) throw new Error("No Cover tokens remain.");
    spend(state, side, "shovel", 1);
    const token = state.coverSupply.shift();
    token.loc = zone;
    state.covers.push(token);
    log(state, `${labelSide(side)} prepares Cover in ${ZONE_LABELS[zone]}.`);
  } else if (mode === "relocate") {
    const cover = state.covers.find((c) => c.id === action.coverId && !c.destroyed);
    if (!cover) throw new Error("Cover not found.");
    if (soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id }).length) {
      throw new Error("Occupied Cover cannot move.");
    }
    const dest = action.zone;
    if (zoneDistance(cover.loc, dest) !== 1) throw new Error("Relocate one zone only.");
    if (controllerOf(state, dest) !== side) throw new Error("Destination must be a zone you control.");
    spend(state, side, "shovel", 1);
    cover.loc = dest;
    log(state, `${labelSide(side)} relocates Cover to ${ZONE_LABELS[dest]}.`);
  } else {
    throw new Error("Unknown Cover action.");
  }
  refreshControl(state);
  checkMissions(state, side, { timing: "immediate" });
}

function startAttack(state, action) {
  if (state.effects.christmasTruce) throw new Error("Christmas Truce: no attacks.");
  if (state.actionStep !== "attack") throw new Error("Not the Attack step.");
  state.combat = {
    side: state.active,
    kind: action.kind,
    attackerIds: action.attackerIds || [],
    unitId: action.unitId,
    target: action.target,
  };
  resolveAttack(state, { ...action, auto: true });
}

function resolveAttack(state, action) {
  const side = state.active;
  const tgt = action.target || state.combat?.target;
  if (!tgt) throw new Error("No target.");
  if (state.effects.christmasTruce) throw new Error("Christmas Truce: no attacks.");
  const kind = action.kind || state.combat?.kind;
  if (kind === "mortar") return mortarAttack(state, action.unitId || state.combat.unitId, tgt);
  if (kind === "tank") return tankAttack(state, action.unitId || state.combat.unitId, tgt);

  const attackers = [];
  for (const id of action.attackerIds || []) {
    const soldier = state.soldiers.find((x) => x.id === id);
    const unit = state.equipment.find((x) => x.id === id);
    if (soldier || unit) attackers.push(soldier || unit);
  }
  if (!attackers.length) throw new Error("No attackers.");
  for (const a of attackers) {
    if (a.type === "mg" && a.damage >= 1) throw new Error("A damaged Machine Gun is disabled.");
    if (state.players[side].attackedIds.includes(a.id)) throw new Error("A Unit already attacked.");
    if (a.type && state.players[side].movedEquip.includes(a.id)) throw new Error("That weapon already moved.");
    if (
      a.type === "mg" &&
      state.effects.suppression === "mg" &&
      a.owner !== state.effects.suppressionBy
    ) {
      throw new Error("Suppressed Machine Guns cannot attack.");
    }
  }

  let dice = 0;
  for (const a of attackers) {
    if (!a.type) {
      if (a.owner !== side) throw new Error("Those are not your soldiers.");
      if (!canSoldierTarget(a, tgt)) throw new Error("Illegal Soldier target.");
      dice += 1;
    } else if (a.type === "mg") {
      if (tgt.kind === "tank") throw new Error("Machine Guns cannot target Tanks.");
      if (zoneDistance(a.loc, tgt.zone) > 2) throw new Error("Machine Gun out of range.");
      if (smoked(state, a.loc, tgt.zone)) throw new Error("Smoke Screen blocks this fire.");
      dice += tgt.zone === "obj" ? 4 : 3;
    } else {
      throw new Error("That Unit cannot join this attack.");
    }
  }
  if (state.effects.cavalryCharge === side && attackers.some((a) => !a.type)) dice += 1;

  const result = rollHits(state, dice);
  const soldierN = attackers.filter((a) => !a.type).length;
  const gunN = attackers.filter((a) => a.type === "mg").length;
  const lead = soldierN && gunN
    ? `${labelSide(side)} combined fire (${soldierN} ${soldierN === 1 ? "soldier" : "soldiers"} and the machine gun)`
    : `${labelSide(side)} attack`;
  log(state, `${lead} rolls ${dice} dice → ${result.hits} Hit(s) [${result.faces.join(", ")}].`);
  settleDirectHits(state, side, tgt, result, attackers);
}

function spendAttackers(state, side, attackers) {
  const player = state.players[side];
  for (const attacker of attackers) {
    if (!player.attackedIds.includes(attacker.id)) player.attackedIds.push(attacker.id);
    if (attacker.type && attacker.type !== "tank" && !player.firedEquip.includes(attacker.id)) {
      player.firedEquip.push(attacker.id);
    }
  }
}

function clearAttackReadout(state) {
  state.lastRoll = null;
}

function closeDirectFire(state, side, target, hits) {
  refreshControl(state);
  checkMissions(state, side, { timing: "combat", hits, target });
  state.combat = null;
  state.pending = { type: "action", step: "attack" };
  clearAttackReadout(state);
  if (state.missionExhausted) endGame(state, "Mission Exhaustion");
}

function settleDirectHits(state, side, target, result, attackers) {
  revealAttackedCover(state, target);
  if (result.hits <= 0 || !isInteractive(state, side)) {
    applyHits(state, side, target, result.hits);
    spendAttackers(state, side, attackers);
    closeDirectFire(state, side, target, result.hits);
    return;
  }
  const options = allocationOptions(state, side, target);
  if (!options.length) {
    applyHits(state, side, target, result.hits);
    spendAttackers(state, side, attackers);
    closeDirectFire(state, side, target, result.hits);
    return;
  }
  spendAttackers(state, side, attackers);
  state.combat = null;
  state.pending = {
    type: "allocate-hits",
    side,
    hits: result.hits,
    zone: target.zone,
    target: {
      kind: target.kind,
      zone: target.zone,
      coverId: target.coverId || null,
      unitId: target.unitId || null,
    },
    options,
  };
}

function allocateHits(state, action) {
  const pending = state.pending;
  if (pending?.type !== "allocate-hits") throw new Error("No hits are waiting.");
  const side = pending.side;
  if (action.auto) {
    if (isInteractive(state, side)) throw new Error("Assign the hits.");
    applyHits(state, side, pending.target, pending.hits);
    closeDirectFire(state, side, pending.target, pending.hits);
    return;
  }
  const picks = Array.isArray(action.picks) ? action.picks.slice() : [];
  if (!allocationReady(pending, picks)) throw new Error("Assign every hit.");
  applyAllocatedHits(state, side, pending.target, picks, pending.hits);
  closeDirectFire(state, side, pending.target, pending.hits);
}

function mapMortarZone(owner, face) {
  const zones = enemySideZones(owner);
  return { z1: zones[0], z2: zones[1], z3: zones[2] }[face] || null;
}

function mortarLabel(owner, face) {
  const zone = mapMortarZone(owner, face);
  return zone ? ZONE_LABELS[zone] : face;
}

function mortarOptions(state, side, zone) {
  const foe = other(side);
  const options = [];
  if (soldiersIn(state, zone, { side: foe, exposed: true }).length) {
    options.push({ id: `exposed:${zone}`, kind: "exposed", zone, label: "exposed soldiers" });
  }
  for (const cover of state.covers.filter((c) => c.loc === zone && !c.destroyed)) {
    const occ = soldiersIn(state, zone, { matchCover: true, coverId: cover.id });
    if (occ.some((s) => s.owner === foe)) {
      options.push({ id: `cover:${cover.id}`, kind: "cover", coverId: cover.id, zone, label: "soldiers in cover" });
    } else if (!occ.length) {
      options.push({ id: `empty:${cover.id}`, kind: "cover-empty", coverId: cover.id, zone, label: "empty cover" });
    }
  }
  for (const unit of unitsIn(state, zone, { side: foe })) {
    if (unit.type === "mg" || unit.type === "mortar") {
      options.push({ id: `unit:${unit.id}`, kind: unit.type, unitId: unit.id, zone, label: unit.type === "mg" ? "machine gun" : "mortar" });
    }
  }
  return options;
}

function mortarAttack(state, unitId, tgt) {
  const side = state.active;
  const unit = state.equipment.find((e) => e.id === unitId && e.type === "mortar" && e.owner === side);
  if (!unit || unit.damage >= 1) throw new Error("Mortar cannot fire.");
  const mobile = state.effects.mobility.includes(unit.id);
  if (state.players[side].movedEquip.includes(unit.id) && !mobile) throw new Error("Mortar already moved.");
  if (state.effects.suppression === "mortar" && unit.owner !== state.effects.suppressionBy) {
    throw new Error("Suppressed Mortars cannot attack.");
  }
  if (state.effects.precision.includes(unit.id)) {
    const zone = tgt.zone;
    if (!isBattlefield(zone)) throw new Error("Choose a battlefield zone.");
    log(state, `Precision Barrage aims at ${ZONE_LABELS[zone]}.`);
    return offerMortarHit(state, unit, zone);
  }
  if (state.effects.spotter.includes(unit.id)) {
    const a = rollMortarDie(state);
    const b = rollMortarDie(state);
    log(state, `Spotter Mortar Die: ${mortarLabel(unit.owner, a)} / ${mortarLabel(unit.owner, b)}.`);
    state.lastRoll = { kind: "mortar", faces: [a, b] };
    if (isInteractive(state, side) && a !== b) {
      state.pending = { type: "spotter", side, options: [a, b], unitId: unit.id };
      return;
    }
    const score = (face) => mortarOptions(state, side, mapMortarZone(unit.owner, face)).length;
    return offerMortarHit(state, unit, mapMortarZone(unit.owner, score(b) > score(a) ? b : a));
  }
  const face = rollMortarDie(state);
  log(state, `Mortar Die: ${mortarLabel(unit.owner, face)}.`);
  state.lastRoll = { kind: "mortar", faces: [face] };
  offerMortarHit(state, unit, mapMortarZone(unit.owner, face));
}

function offerMortarHit(state, unit, zone) {
  const side = unit.owner;
  const options = mortarOptions(state, side, zone);
  if (!options.length) {
    log(state, `Mortar hit on ${ZONE_LABELS[zone]} is lost. No eligible target.`);
    markMortarFired(state, unit, 0);
    return;
  }
  if (!isInteractive(state, side) || options.length === 1) {
    const pick = options.find((o) => o.kind === "exposed") || options[0];
    applyMortarHit(state, unit, pick);
    return;
  }
  state.pending = { type: "mortar-target", side, unitId: unit.id, zone, options };
}

function allocateMortar(state, action) {
  const pending = state.pending;
  if (pending?.type !== "mortar-target") throw new Error("No mortar hit is waiting.");
  const pick = pending.options.find((o) => o.id === action.targetId) || pending.options[0];
  const unit = state.equipment.find((e) => e.id === pending.unitId);
  state.pending = { type: "action", step: "attack" };
  applyMortarHit(state, unit, pick);
}

function rememberMortarTarget(state, target) {
  const cover = target.coverId ? state.covers.find((c) => c.id === target.coverId) : null;
  const unit = target.unitId ? state.equipment.find((e) => e.id === target.unitId) : null;
  return {
    casualties: new Set(state.soldiers.filter((s) => s.loc === "casualties").map((s) => s.id)),
    coverRevealed: Boolean(cover?.revealed),
    coverDestroyed: Boolean(cover?.destroyed),
    unitDamage: unit ? unit.damage : null,
    unitLoc: unit ? unit.loc : null,
  };
}

function mortarEffectPhrases(state, target, before) {
  const phrases = [];
  const eliminated = state.soldiers.filter((s) => s.loc === "casualties" && !before.casualties.has(s.id)).length;
  if (eliminated === 1) phrases.push("soldier eliminated");
  else if (eliminated > 1) phrases.push(`${eliminated} soldiers eliminated`);
  if (target.coverId) {
    const cover = state.covers.find((c) => c.id === target.coverId);
    if (cover?.destroyed && !before.coverDestroyed) phrases.push("cover destroyed");
    else if (cover?.revealed && !before.coverRevealed) phrases.push("cover revealed");
  }
  if (target.unitId) {
    const unit = state.equipment.find((e) => e.id === target.unitId);
    if (unit && before.unitLoc !== "supply" && unit.loc === "supply") phrases.push("weapon destroyed");
    else if (unit && before.unitDamage != null && unit.damage > before.unitDamage) phrases.push("weapon damaged");
  }
  return phrases;
}

function showBattleNotice(state, side, text) {
  log(state, text);
  if (!state.killPulse) state.killPulse = [];
  state.killPulse.push({ id: state.killPulse.length, side, text });
}

function announceMortarHit(state, side, target, before) {
  const phrases = mortarEffectPhrases(state, target, before);
  if (!phrases.length) return;
  const text = `${labelSide(side)}'s mortar hits ${ZONE_LABELS[target.zone]}: ${phrases.join(", ")}.`;
  showBattleNotice(state, side, text);
}

function applyMortarHit(state, unit, target) {
  const side = unit.owner;
  log(state, `Mortar places 1 Hit on ${target.label} in ${ZONE_LABELS[target.zone]}.`);
  const before = rememberMortarTarget(state, target);
  applyHits(state, side, target, 1);
  announceMortarHit(state, side, target, before);
  markMortarFired(state, unit, 1, target);
}

function markMortarFired(state, unit, hits, target) {
  const side = unit.owner;
  state.players[side].attackedIds.push(unit.id);
  state.players[side].firedEquip.push(unit.id);
  refreshControl(state);
  checkMissions(state, side, { timing: "combat", hits, target });
  state.combat = null;
  state.pending = { type: "action", step: "attack" };
  clearAttackReadout(state);
  if (state.missionExhausted) endGame(state, "Mission Exhaustion");
}

function pickSpotter(state, action) {
  const pending = state.pending;
  if (pending?.type !== "spotter") throw new Error("No spotter choice is waiting.");
  const face = pending.options.includes(action.face) ? action.face : pending.options[0];
  const unit = state.equipment.find((e) => e.id === pending.unitId);
  log(state, `Spotter chooses ${mortarLabel(unit.owner, face)}.`);
  state.pending = { type: "action", step: "attack" };
  offerMortarHit(state, unit, mapMortarZone(unit.owner, face));
}

function tankAttack(state, unitId, tgt) {
  const side = state.active;
  const unit = state.equipment.find((e) => e.id === unitId && e.type === "tank" && e.owner === side);
  if (!unit) throw new Error("Tank not found.");
  if (zoneDistance(unit.loc, tgt.zone) > 1) throw new Error("Tank out of range.");
  if (tgt.kind === "cover-empty") throw new Error("Tanks cannot make a normal attack against Cover. Use Overrun.");
  if (smoked(state, unit.loc, tgt.zone)) throw new Error("Smoke Screen blocks this fire.");
  const result = rollHits(state, 3);
  log(state, `${labelSide(side)} Tank fires 3 dice → ${result.hits} Hit(s) [${result.faces.join(", ")}].`);
  settleDirectHits(state, side, tgt, result, [unit]);
}

function doOverrun(state, action) {
  if (state.effects.christmasTruce) throw new Error("Christmas Truce: no Overrun.");
  if (state.actionStep !== "attack") throw new Error("Not the Attack step.");
  const side = state.active;
  const tank = state.equipment.find((e) => e.id === action.unitId && e.type === "tank" && e.owner === side);
  const cover = state.covers.find((c) => c.id === action.coverId && !c.destroyed);
  if (!tank || !cover || cover.loc !== tank.loc) throw new Error("Overrun must target Cover in the Tank's zone.");
  if (unitsIn(state, tank.loc, { side: other(side), type: "tank" }).length) {
    throw new Error("An engaged Tank cannot Overrun.");
  }
  for (const s of soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id })) s.coverId = null;
  takeCoverTrophy(state, side, cover);
  state.players[side].attackedIds.push(tank.id);
  log(state, `${labelSide(side)} Tank Overruns Cover. Occupants become exposed.`);
  refreshControl(state);
  checkMissions(state, side, { timing: "combat", overrun: true });
  clearAttackReadout(state);
}

function finishActionPhase(state) {
  clearAttackReadout(state);
  const nxt = other(state.active);
  if (state.active === state.player1) startActionPhase(state, nxt);
  else startRegroup(state);
}

function startRegroup(state) {
  state.phase = "regroup";
  state.actionStep = null;
  state.regroupDone = { uk: false, de: false };
  const first = state.mode === "hotseat" || state.mode === "sim" ? state.player1 : state.human;
  state.active = first;
  state.pending = { type: "regroup", side: first };
  log(state, "Regroup. Exchange up to 2 unused dice for Soldiers, then draw 1 Event.");
}

function regroupExchange(state) {
  const side = state.active;
  if (state.phase !== "regroup") throw new Error("Not Regroup.");
  const p = state.players[side];
  if ((p.regroupExchanged || 0) >= 2) throw new Error("Only 2 Soldiers may be taken this way.");
  const trench = side === "uk" ? "ukTrench" : "deTrench";
  const there = state.soldiers.filter((s) => s.owner === side && s.loc === trench).length;
  if (there >= 5) throw new Error("The Trench already holds 5 Soldiers.");
  const soldier = state.soldiers.find((s) => s.owner === side && s.loc === "available");
  if (!soldier) throw new Error("No Soldier in supply.");
  const face = ["shovel", "whistle", "boot", "bayonet"].find((name) => remaining(state, side, name) > 0);
  if (!face) throw new Error("No unused Action Dice.");
  spend(state, side, face, 1);
  soldier.loc = trench;
  soldier.coverId = null;
  p.regroupExchanged = (p.regroupExchanged || 0) + 1;
  log(state, `${labelSide(side)} exchanges 1 ${face} for a Soldier in the Trench (${p.regroupExchanged}/2).`);
}

function regroupDraw(state, action) {
  const side = action.side || state.active;
  if (state.phase !== "regroup") throw new Error("Not Regroup.");
  if (side !== state.active) throw new Error("It is not your Regroup.");
  const p = state.players[side];
  if (p.regroupDrew) throw new Error("You already drew an Event this Regroup.");
  if (p.eventHand.length >= 7) throw new Error("Event hand is full.");
  drawEvent(state, side, action.source);
  p.regroupDrew = true;
}

export function drawEvent(state, side, source) {
  let card = null;
  if (source && source !== "deck") {
    const i = state.eventDisplay.findIndex((c) => c.inst === source);
    if (i >= 0) {
      card = state.eventDisplay[i];
      state.eventDisplay[i] = state.eventDeck.length ? state.eventDeck.pop() : null;
      state.eventDisplay = state.eventDisplay.filter(Boolean);
      while (state.eventDisplay.length < 3 && state.eventDeck.length) state.eventDisplay.push(state.eventDeck.pop());
    }
  } else {
    card = state.eventDeck.length ? state.eventDeck.pop() : null;
  }
  if (!card) {
    log(state, "Event deck is empty.");
    return;
  }
  state.players[side].eventHand.push(card);
  log(state, `${labelSide(side)} draws ${card.title}.`);
}

function skipRegroup(state) {
  if (state.phase !== "regroup") throw new Error("Not Regroup.");
  state.regroupDone[state.active] = true;
  const nxt = other(state.active);
  const both = state.mode === "hotseat" || state.mode === "sim";
  if ((both && !state.regroupDone[nxt]) || (!both && state.active === state.human)) {
    const nextSide = both ? nxt : state.ai;
    if (!state.regroupDone[nextSide]) {
      state.active = nextSide;
      state.pending = { type: "regroup", side: nextSide };
      return;
    }
  }
  scheduledMissions(state);
  if (state.phase === "end") return;
  endRound(state);
}

function scheduledMissions(state) {
  if (![3, 6, 9].includes(state.round)) return;
  const order = [state.player1, other(state.player1)];
  for (const side of order) {
    const card = drawMission(state, true);
    if (!card) {
      endGame(state, "Mission Exhaustion");
      return;
    }
    state.players[side].missionHand.push(card);
    log(state, `${labelSide(side)} draws a scheduled Mission (${card.title}).`);
    checkMissions(state, side, { timing: "immediate" });
    trimMissions(state, side);
    if (state.missionExhausted) {
      endGame(state, "Mission Exhaustion");
      return;
    }
  }
}

function awardCasualtySuperiority(state, side, britainKills, germanyKills) {
  state.vp[side] += 1;
  const text = `${labelSide(side)} gains 1 victory point for the most kills this round (Britain ${britainKills}, Germany ${germanyKills}).`;
  showBattleNotice(state, side, text);
}

function casualtySuperiority(state) {
  const count = (side) => state.soldiers.filter((s) => s.owner === side && s.loc === "casualties" && !s.overflow).length;
  const uk = count("uk");
  const de = count("de");
  if (uk > de) awardCasualtySuperiority(state, "de", de, uk);
  else if (de > uk) awardCasualtySuperiority(state, "uk", de, uk);
  else log(state, `Casualty totals are tied (${uk}–${de}). Neither side scores.`);
}

function endRound(state) {
  casualtySuperiority(state);
  checkMissions(state, "uk", { timing: "end" });
  checkMissions(state, "de", { timing: "end" });
  for (const s of state.soldiers) {
    if (s.loc === "casualties") {
      s.loc = "available";
      s.overflow = false;
    }
  }
  state.roundElim = { uk: 0, de: 0 };
  state.roundBurst = { uk: false, de: false };
  state.roundSupportKill = { uk: false, de: false };
  state.roundTankKill = { uk: false, de: false };
  for (const side of ["uk", "de"]) state.players[side].regroupDraws = 0;
  if (state.missionExhausted) return endGame(state, "Mission Exhaustion");
  if (state.round >= state.maxRounds) return endGame(state, "Final round");
  state.round += 1;
  log(state, `Round ${state.round} begins.`);
  beginInitiative(state);
}

function endGame(state, why) {
  if (state.phase === "end") return;
  state.phase = "end";
  state.pending = { type: "end" };
  state.actionStep = null;
  if (state.vp.uk > state.vp.de) state.winner = "uk";
  else if (state.vp.de > state.vp.uk) state.winner = "de";
  else if (controllerOf(state, "obj")) state.winner = controllerOf(state, "obj");
  else {
    const ukE = enemySideZones("uk").filter((z) => controllerOf(state, z) === "uk").length;
    const deE = enemySideZones("de").filter((z) => controllerOf(state, z) === "de").length;
    if (ukE > deE) state.winner = "uk";
    else if (deE > ukE) state.winner = "de";
    else {
      const ukC = state.players.uk.destroyedCover.length;
      const deC = state.players.de.destroyedCover.length;
      if (ukC > deC) state.winner = "uk";
      else if (deC > ukC) state.winner = "de";
      else state.winner = null;
    }
  }
  state.tiebreak = why;
  if (state.winner) log(state, `${labelSide(state.winner)} wins (${why}).`);
  else log(state, `Draw (${why}).`);
}

export { hasShock, remaining, canRegroup, STEPS, shouldSkipStep };
