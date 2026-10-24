import { other, soldiersIn } from "./core.js";

export function fireSources(attackers) {
  return (attackers || []).map((unit) => {
    let weapon = "rifle";
    if (unit?.type === "mg") weapon = "mg";
    else if (unit?.type === "tank") weapon = "tank";
    return { id: unit?.id || null, loc: unit?.loc || null, weapon };
  }).filter((unit) => unit.id && unit.loc);
}

function originsFor(sources, count, dice) {
  const list = Array.isArray(sources) ? sources : [];
  const rifles = list.filter((unit) => unit.weapon === "rifle");
  const gun = list.find((unit) => unit.weapon === "mg") || null;
  const tank = list.find((unit) => unit.weapon === "tank") || null;
  const rifleDice = Number.isFinite(dice?.rifle) ? dice.rifle : rifles.length;
  const mgDice = Number.isFinite(dice?.mg) ? dice.mg : 0;
  const tankDice = Number.isFinite(dice?.tank) ? dice.tank : 0;
  const out = [];
  let riflesLeft = rifleDice;
  let gunsLeft = mgDice;
  let tanksLeft = tankDice;
  let rifleIndex = 0;
  for (let i = 0; i < count; i += 1) {
    if (riflesLeft > 0 && rifles.length) {
      out.push(rifles[Math.min(rifleIndex, rifles.length - 1)]);
      if (rifleIndex < rifles.length - 1) rifleIndex += 1;
      riflesLeft -= 1;
    } else if (gunsLeft > 0 && gun) {
      out.push(gun);
      gunsLeft -= 1;
    } else if (tanksLeft > 0 && tank) {
      out.push(tank);
      tanksLeft -= 1;
    } else {
      out.push(gun || tank || rifles[0] || list[0]);
    }
  }
  return out;
}

function coverOf(state, coverId) {
  return (state?.covers || []).find((cover) => cover.id === coverId && !cover.destroyed) || null;
}

function hitSlots(state, side, target, hitCount, picks) {
  const slots = [];
  const kind = target?.kind;
  const zone = target?.zone;
  const foe = other(side);
  if (!kind || !zone || hitCount <= 0) return slots;
  if (kind === "exposed") {
    if (Array.isArray(picks)) {
      for (const id of picks) {
        if (slots.length >= hitCount) break;
        const soldier = (state.soldiers || []).find((item) => item.id === id && item.owner === foe && item.loc === zone && !item.coverId);
        slots.push(soldier ? { soldierId: soldier.id } : {});
      }
    } else {
      const list = soldiersIn(state, zone, { side: foe, exposed: true });
      for (let i = 0; i < hitCount && i < list.length; i += 1) slots.push({ soldierId: list[i].id });
    }
  } else if (kind === "cover") {
    const defense = coverOf(state, target.coverId)?.defense || 0;
    if (Array.isArray(picks)) {
      let shield = defense;
      for (const id of picks) {
        if (slots.length >= hitCount) break;
        if (shield > 0) {
          shield -= 1;
          slots.push({ coverId: target.coverId });
          continue;
        }
        const soldier = (state.soldiers || []).find((item) => item.id === id && item.owner === foe && item.coverId === target.coverId);
        slots.push(soldier ? { soldierId: soldier.id, coverId: target.coverId } : { coverId: target.coverId });
      }
    } else {
      const occ = soldiersIn(state, zone, { side: foe, matchCover: true, coverId: target.coverId });
      const against = Math.min(hitCount, defense);
      for (let i = 0; i < against; i += 1) slots.push({ coverId: target.coverId });
      const leftover = Math.max(0, hitCount - defense);
      for (let i = 0; i < leftover && i < occ.length; i += 1) slots.push({ soldierId: occ[i].id, coverId: target.coverId });
    }
  } else if (kind === "cover-empty") {
    for (let i = 0; i < hitCount; i += 1) slots.push({ coverId: target.coverId });
  } else if (kind === "mg" || kind === "mortar" || kind === "tank") {
    for (let i = 0; i < hitCount; i += 1) slots.push({ unitId: target.unitId });
  }
  while (slots.length < hitCount) slots.push({});
  return slots;
}

export function planDirectShots(state, side, sources, faces, target, picks, dice) {
  const list = Array.isArray(faces) ? faces.filter((face) => face === "hit" || face === "miss") : [];
  if (!Array.isArray(sources) || !sources.length || !list.length || !target?.zone) return [];
  const froms = originsFor(sources, list.length, dice);
  const slots = hitSlots(state, side, target, list.filter((face) => face === "hit").length, picks);
  let hitIndex = 0;
  return list.map((face, index) => {
    const origin = froms[index];
    const slot = face === "hit" ? (slots[hitIndex++] || {}) : {};
    return {
      kind: "shot",
      from: origin?.loc || target.zone,
      zone: target.zone,
      weapon: origin?.weapon || "rifle",
      hit: face === "hit",
      soldierId: slot.soldierId || null,
      coverId: slot.coverId || null,
      unitId: slot.unitId || null,
    };
  });
}
