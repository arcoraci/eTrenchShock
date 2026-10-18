import {
  log,
  labelSide,
  other,
  ownTrench,
  soldiersIn,
  ZONE_LABELS,
} from "./core.js";

export function eliminateSoldier(state, soldier) {
  soldier.coverId = null;
  soldier.loc = "casualties";
  log(state, `${labelSide(soldier.owner)} Soldier is eliminated.`);
}

export function retreatSoldier(state, soldier) {
  const trench = ownTrench(soldier.owner);
  const there = state.soldiers.filter((s) => s.owner === soldier.owner && s.loc === trench).length;
  soldier.coverId = null;
  if (there >= 5) {
    soldier.loc = "casualties";
    soldier.overflow = true;
    log(state, `${labelSide(soldier.owner)} Soldier cannot enter the Trench and is lost.`);
  } else {
    soldier.loc = trench;
    log(state, `${labelSide(soldier.owner)} Soldier Retreats to the Trench.`);
  }
}

export function takeCoverTrophy(state, side, cover) {
  cover.destroyed = true;
  cover.loc = "trophy";
  cover.trophyOwner = side;
  state.players[side].destroyedCover.push(cover.id);
  log(state, `${labelSide(side)} destroys Cover (Defense ${cover.defense}).`);
}

function pretty(type) {
  return { mg: "Machine Gun", mortar: "Mortar", tank: "Tank" }[type] || type;
}

export function damageEquipment(state, side, unit, hits) {
  const cap = unit.type === "tank" ? 3 : 2;
  unit.damage += hits;
  log(state, `${pretty(unit.type)} takes ${hits} Damage (now ${Math.min(unit.damage, cap)}).`);
  if (unit.damage >= cap) {
    log(state, `${labelSide(unit.owner)} ${pretty(unit.type)} is destroyed.`);
    if (unit.type === "mg" || unit.type === "mortar") state.roundSupportKill[side] = true;
    if (unit.type === "tank") state.roundTankKill[side] = true;
    unit.loc = "supply";
    unit.damage = 0;
  }
}

function noteElim(state, side, n) {
  state.roundElim[side] = (state.roundElim[side] || 0) + n;
  if (n >= 3) state.roundBurst[side] = true;
}

export function revealCover(state, cover) {
  if (!cover || cover.revealed) return;
  cover.revealed = true;
  log(state, `Cover Defense ${cover.defense} revealed.`);
}

export function revealAttackedCover(state, target) {
  if (target?.kind !== "cover" && target?.kind !== "cover-empty") return;
  const cover = state.covers?.find((c) => c.id === target.coverId);
  revealCover(state, cover);
}

function hitsDestroyCover(hitsAgainstCover, defense) {
  return hitsAgainstCover >= defense;
}

function freeSoldiersFromCover(state, cover) {
  for (const s of state.soldiers) {
    if (s.coverId === cover.id) s.coverId = null;
  }
}

function destroyCover(state, side, cover) {
  freeSoldiersFromCover(state, cover);
  takeCoverTrophy(state, side, cover);
}

export function applyHits(state, side, target, hits) {
  const foe = other(side);
  const kind = target?.kind;
  if (kind === "exposed") {
    const list = soldiersIn(state, target.zone, { side: foe, exposed: true });
    const n = Math.min(hits, list.length);
    for (let i = 0; i < n; i += 1) eliminateSoldier(state, list[i]);
    noteElim(state, side, n);
    if (hits > 0 && n === 0) log(state, "No exposed soldiers there.");
    return;
  }
  if (kind === "cover" || kind === "cover-empty") {
    const cover = state.covers.find((c) => c.id === target.coverId);
    if (!cover) return;
    revealCover(state, cover);
    if (kind === "cover-empty") {
      if (hitsDestroyCover(hits, cover.defense)) destroyCover(state, side, cover);
      else log(state, `Cover holds. ${hits} Hit(s) did not meet Defense ${cover.defense}.`);
      return;
    }
    const againstCover = Math.min(Math.max(0, hits), cover.defense);
    const leftover = Math.max(0, hits - cover.defense);
    const occ = soldiersIn(state, cover.loc, { side: foe, matchCover: true, coverId: cover.id });
    const n = Math.min(leftover, occ.length);
    for (let i = 0; i < n; i += 1) eliminateSoldier(state, occ[i]);
    noteElim(state, side, n);
    if (hitsDestroyCover(againstCover, cover.defense)) destroyCover(state, side, cover);
    else if (n === 0) log(state, `Cover absorbs the fire (${hits} Hit(s), Defense ${cover.defense}).`);
    return;
  }
  if (kind === "mg" || kind === "mortar" || kind === "tank") {
    const unit = state.equipment.find((e) => e.id === target.unitId);
    if (!unit) return;
    damageEquipment(state, side, unit, hits);
    return;
  }
  if (kind === "allocate") {
    log(state, `${hits} Hit(s) in ${ZONE_LABELS[target.zone] || target.zone}.`);
    applyHits(state, side, { kind: "exposed", zone: target.zone }, hits);
  }
}

function nation(side) {
  return side === "uk" ? "British" : "German";
}

function soldierRows(soldiers) {
  const rows = soldiers.map((soldier) => {
    const dug = soldier.coverId ? " · in cover" : "";
    return {
      id: soldier.id,
      kind: "soldier",
      soldierId: soldier.id,
      zone: soldier.loc,
      coverId: soldier.coverId || null,
      label: `${nation(soldier.owner)} Soldier · ${ZONE_LABELS[soldier.loc] || soldier.loc}${dug}`,
    };
  });
  const totals = {};
  for (const row of rows) totals[row.label] = (totals[row.label] || 0) + 1;
  const seen = {};
  return rows.map((row) => {
    if (totals[row.label] < 2) return row;
    seen[row.label] = (seen[row.label] || 0) + 1;
    return { ...row, label: row.label.replace(" Soldier · ", ` Soldier ${seen[row.label]} · `) };
  });
}

export function allocationOptions(state, side, target) {
  const foe = other(side);
  const zone = target?.zone;
  const kind = target?.kind;
  if (!zone || !kind) return [];
  if (kind === "exposed") {
    return soldierRows(soldiersIn(state, zone, { side: foe, exposed: true }));
  }
  if (kind === "cover") {
    return soldierRows(soldiersIn(state, zone, { side: foe, matchCover: true, coverId: target.coverId }));
  }
  if (kind === "cover-empty") {
    const cover = state.covers.find((c) => c.id === target.coverId && !c.destroyed);
    if (!cover) return [];
    const defense = cover.revealed ? ` · defense ${cover.defense}` : "";
    return [{
      id: cover.id,
      kind: "cover-empty",
      coverId: cover.id,
      zone,
      label: `Empty cover · ${ZONE_LABELS[zone] || zone}${defense}`,
    }];
  }
  if (kind === "mg" || kind === "mortar" || kind === "tank") {
    const unit = state.equipment.find((e) => e.id === target.unitId && e.loc === zone);
    if (!unit) return [];
    return [{
      id: unit.id,
      kind: unit.type,
      unitId: unit.id,
      zone,
      label: `${nation(unit.owner)} ${pretty(unit.type)} · ${ZONE_LABELS[zone] || zone}`,
    }];
  }
  return [];
}

export function allocationReady(pending, picks) {
  if (!pending || pending.type !== "allocate-hits" || !Array.isArray(picks)) return false;
  const options = pending.options || [];
  const known = new Set(options.map((option) => option.id));
  if (picks.some((id) => !known.has(id))) return false;
  if (picks.length > pending.hits) return false;
  if (picks.length === pending.hits) return true;
  if (pending.target?.kind !== "exposed") return false;
  const counts = {};
  for (const id of picks) counts[id] = (counts[id] || 0) + 1;
  return options.every((option) => (counts[option.id] || 0) >= 1);
}

export function applyAllocatedHits(state, side, target, picks, rolledHits) {
  const allowed = new Set(allocationOptions(state, side, target).map((option) => option.id));
  const hits = (picks || []).filter((id) => allowed.has(id));
  const kind = target?.kind;
  if (kind === "exposed") {
    let n = 0;
    for (const id of hits) {
      const soldier = state.soldiers.find((s) => s.id === id);
      if (!soldier || soldier.loc !== target.zone || soldier.coverId) continue;
      eliminateSoldier(state, soldier);
      n += 1;
    }
    noteElim(state, side, n);
    if ((rolledHits || hits.length) > 0 && n === 0) log(state, "No exposed soldiers there.");
    return;
  }
  if (kind === "cover") {
    const cover = state.covers.find((c) => c.id === target.coverId);
    if (!cover || cover.destroyed) return;
    revealCover(state, cover);
    let shield = cover.defense;
    let againstCover = 0;
    let n = 0;
    for (const id of hits) {
      if (shield > 0) {
        shield -= 1;
        againstCover += 1;
        continue;
      }
      const soldier = state.soldiers.find((s) => s.id === id && s.coverId === cover.id);
      if (!soldier) continue;
      eliminateSoldier(state, soldier);
      n += 1;
    }
    noteElim(state, side, n);
    if (hitsDestroyCover(againstCover, cover.defense)) destroyCover(state, side, cover);
    else if (n === 0) log(state, `Cover absorbs the fire (${rolledHits ?? hits.length} Hit(s), Defense ${cover.defense}).`);
    return;
  }
  if (kind === "cover-empty" || kind === "mg" || kind === "mortar" || kind === "tank") {
    applyHits(state, side, target, hits.length);
  }
}
