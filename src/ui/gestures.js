import {
  controllerOf,
  isBattlefield,
  ownTrench,
  ownZone1,
  sideZones,
  stepZone,
} from "../engine/core.js";
import { remaining } from "../engine/dice.js";

function bayonetIndexes(state, side, indexes) {
  const player = state?.players?.[side];
  if (!player) return null;
  const used = new Set(player.spentDice || []);
  const picked = [];
  for (const raw of indexes || []) {
    const index = Number(raw);
    if (!Number.isInteger(index) || picked.includes(index) || used.has(index)) return null;
    const face = player.dice?.[index];
    const effective = face === "wild" ? player.wildAs : face;
    if (effective !== "bayonet") return null;
    picked.push(index);
  }
  return picked.sort((a, b) => a - b);
}

function supplyCount(state, side, type) {
  return (state.equipment || []).filter((unit) => unit.owner === side && unit.type === type && unit.loc === "supply").length;
}

export function trenchMoveDrop(state, side, soldierId, zone) {
  if (!state || state.phase !== "action" || state.actionStep !== "move") return { reason: "Not the Move step." };
  if (state.active !== side) return { reason: "Not your turn." };
  const soldier = (state.soldiers || []).find((item) => item.id === soldierId && item.owner === side);
  if (!soldier) return { reason: "Soldier not found." };
  if (state.effects?.trenchFoot && soldier.owner !== state.effects.trenchFootBy) {
    return { reason: "Trench Foot prevents Soldier movement." };
  }
  if (soldier.coverId) return { reason: "Soldiers in Cover must Leave Cover first." };
  if (soldier.loc !== ownTrench(side)) return { reason: "A Soldier leaves the Trench only by advancing into Zone 1." };
  if (remaining(state, side, "boot") < 1) return { reason: "Need a Boot." };
  const dest = stepZone(side, soldier.loc, "forward");
  if (!dest || dest !== ownZone1(side) || zone !== dest) {
    return { reason: "A Soldier leaves the Trench only by advancing into Zone 1." };
  }
  return { action: { type: "MOVE_UNIT", kind: "soldier", unitId: soldier.id, dir: "forward" } };
}

export function deployDrop(state, side, indexes, target) {
  if (!state || state.phase !== "action" || state.actionStep !== "deploy") return { reason: "Not the Deploy step." };
  if (state.active !== side) return { reason: "Not your turn." };
  const kind = target?.kind;
  const cost = { soldier: 1, repair: 1, mortar: 2, mg: 3, tank: 4 }[kind];
  if (!cost) return { reason: "Unknown deployment." };
  const picked = bayonetIndexes(state, side, indexes);
  if (!picked) return { reason: "Select bayonet dice." };
  const word = cost === 1 ? "Bayonet" : "Bayonets";
  if (picked.length !== cost) return { reason: `Select ${cost} ${word}.` };
  if (remaining(state, side, "bayonet") < cost) return { reason: `Need ${cost} ${word}.` };
  if (kind === "repair") {
    const unit = (state.equipment || []).find((item) => item.id === target.unitId && item.owner === side && isBattlefield(item.loc));
    if (!unit || unit.damage < 1) return { reason: "That Unit does not need repair." };
    return { action: { type: "REPAIR", unitId: unit.id, indexes: picked } };
  }
  if (kind === "mortar") {
    const zone = ownZone1(side);
    if (target.zone && target.zone !== zone) return { reason: "Mortars deploy into your Zone 1." };
    if (supplyCount(state, side, "mortar") <= 0) return { reason: "All Mortars are already deployed." };
    if (controllerOf(state, zone) !== side) return { reason: "You must control Zone 1." };
    return { action: { type: "DEPLOY", kind: "mortar", zone, indexes: picked } };
  }
  if (kind === "mg") {
    const zone = target.zone;
    if (!zone || !sideZones(side).includes(zone)) return { reason: "Machine Guns deploy on your own side." };
    if (supplyCount(state, side, "mg") <= 0) return { reason: "All Machine Guns are already deployed." };
    if (controllerOf(state, zone) !== side) return { reason: "You must control that zone." };
    return { action: { type: "DEPLOY", kind: "mg", zone, indexes: picked } };
  }
  if (kind === "tank") {
    if (supplyCount(state, side, "tank") <= 0) return { reason: "All Tanks are already deployed." };
    return { action: { type: "DEPLOY", kind: "tank", indexes: picked } };
  }
  const zone = target.zone;
  if (state.players[side].soldierDeployed) return { reason: "You may deploy only one Soldier this round." };
  if (!(state.soldiers || []).some((soldier) => soldier.owner === side && soldier.loc === "available")) {
    return { reason: "No Soldier in supply." };
  }
  if (!isBattlefield(zone) || controllerOf(state, zone) !== side) {
    return { reason: "Deploy the Soldier into a battlefield zone you control." };
  }
  return { action: { type: "DEPLOY", kind: "soldier", zone, indexes: picked } };
}

export function hitDrop(pending, stack, targetId) {
  if (!pending || pending.type !== "allocate-hits") return { reason: "No hits are waiting." };
  const options = pending.options || [];
  if (!targetId || !options.some((option) => option.id === targetId)) return { reason: "That is not a legal target." };
  const hits = Array.isArray(stack) ? stack.slice() : [];
  if (hits.length >= pending.hits) return { reason: "No hits left to assign." };
  hits.push(targetId);
  return { stack: hits };
}
