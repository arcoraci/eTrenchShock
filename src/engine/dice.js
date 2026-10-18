import {
  ACTION_FACES,
  ATTACK_FACES,
  MORTAR_FACES,
  COMBO_RANK,
  SYMBOL_RANK,
  rollFace,
  log,
  labelSide,
  ownTrench,
} from "./core.js";

export function rollActionDie(state) {
  return rollFace(state, ACTION_FACES);
}

export function rollAttackDie(state) {
  return rollFace(state, ATTACK_FACES);
}

export function rollMortarDie(state) {
  return rollFace(state, MORTAR_FACES);
}

export function rollAllAction(state, side) {
  state.players[side].dice = Array.from({ length: 5 }, () => rollActionDie(state));
  state.players[side].kept = [true, true, true, true, true];
}

export function rerollKept(state, side, keep) {
  const p = state.players[side];
  p.dice = p.dice.map((face, i) => (keep[i] ? face : rollActionDie(state)));
  p.rollsUsed += 1;
  p.kept = [true, true, true, true, true];
}

export function naturalFaces(dice) {
  return dice.filter((f) => f && f !== "wild");
}

export function hasWildFace(dice) {
  return Array.isArray(dice) && dice.includes("wild");
}

export function comboOf(dice) {
  const nat = naturalFaces(dice);
  const counts = {};
  for (const f of nat) counts[f] = (counts[f] || 0) + 1;
  const vals = Object.values(counts).sort((a, b) => b - a);
  const kinds = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || (SYMBOL_RANK[b[0]] || 0) - (SYMBOL_RANK[a[0]] || 0),
  );
  let type = "none";
  if (vals[0] >= 5) type = "five";
  else if (vals[0] === 4) type = "four";
  else if (vals[0] === 3 && vals[1] === 2) type = "fullHouse";
  else if (vals[0] === 3) type = "three";
  else if (vals[0] === 2 && vals[1] === 2) type = "twoPair";
  else if (vals[0] === 2) type = "pair";
  return { type, rank: COMBO_RANK[type], symbols: kinds.map(([s]) => s), counts };
}

export function compareInitiative(aDice, bDice) {
  const a = comboOf(aDice);
  const b = comboOf(bDice);
  if (a.rank !== b.rank) return a.rank - b.rank;
  const n = Math.max(a.symbols.length, b.symbols.length);
  for (let i = 0; i < n; i += 1) {
    const ar = SYMBOL_RANK[a.symbols[i]] || 0;
    const br = SYMBOL_RANK[b.symbols[i]] || 0;
    if (ar !== br) return ar - br;
  }
  const best = (dice) => Math.max(0, ...naturalFaces(dice).map((f) => SYMBOL_RANK[f] || 0));
  return best(aDice) - best(bDice);
}

export function initiativeWinner(state) {
  if (state.initiative?.winner) return state.initiative.winner;
  const cmp = compareInitiative(state.players.uk.dice, state.players.de.dice);
  if (cmp > 0) return "uk";
  if (cmp < 0) return "de";
  return null;
}

const COMBO_NAMES = {
  five: "Five of a Kind",
  four: "Four of a Kind",
  fullHouse: "Full House",
  three: "Three of a Kind",
  twoPair: "Two Pairs",
  pair: "One Pair",
  none: "No combination",
};

export function comboLabel(dice) {
  if (!dice?.length) return "";
  const combo = comboOf(dice);
  const name = COMBO_NAMES[combo.type];
  const lead = combo.symbols[0];
  if (combo.type === "none") return lead ? `High ${cap(lead)}` : "No combination";
  if (combo.type === "fullHouse" && combo.symbols[1]) return `Full House (${cap(lead)} over ${cap(combo.symbols[1])})`;
  if (combo.type === "twoPair" && combo.symbols[1]) return `Two Pairs (${cap(lead)} and ${cap(combo.symbols[1])})`;
  if (lead) return `${name} (${cap(lead)})`;
  return name;
}

export function lockInitiative(state, tieRolls = 0) {
  const uk = state.players.uk.dice.slice();
  const de = state.players.de.dice.slice();
  const cmp = compareInitiative(uk, de);
  if (!cmp) return null;
  state.initiative = {
    winner: cmp > 0 ? "uk" : "de",
    tieRolls,
    uk: { dice: uk, label: comboLabel(uk) },
    de: { dice: de, label: comboLabel(de) },
  };
  return state.initiative;
}

export function spendable(state, side) {
  const p = state.players[side];
  const counts = { boot: 0, shovel: 0, bayonet: 0, whistle: 0, wild: 0 };
  if (!p.committed) return counts;
  for (const f of p.dice) {
    if (f === "wild") {
      if (p.wildAs) counts[p.wildAs] += 1;
    } else if (f) {
      counts[f] = (counts[f] || 0) + 1;
    }
  }
  const stolen = state.effects?.stolenDie;
  if (stolen && stolen.owner === side) {
    const f = stolen.face;
    if (f === "wild" && p.wildAs) counts[p.wildAs] += 1;
    else if (f && f !== "wild") counts[f] = (counts[f] || 0) + 1;
  }
  return counts;
}

export function spend(state, side, face, n = 1) {
  const p = state.players[side];
  if (!p.spent) p.spent = { boot: 0, shovel: 0, bayonet: 0, whistle: 0 };
  p.spent[face] = (p.spent[face] || 0) + n;
}

export function spendSelected(state, side, face, indexes) {
  const p = state.players[side];
  if (!p.spent) p.spent = { boot: 0, shovel: 0, bayonet: 0, whistle: 0 };
  if (!Array.isArray(p.spentDice)) p.spentDice = [];
  const used = new Set(p.spentDice);
  const picked = [];
  for (const rawIndex of indexes || []) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= p.dice.length) {
      throw new Error("That die cannot be spent.");
    }
    if (picked.includes(index) || used.has(index)) throw new Error("That die is already spent.");
    const raw = p.dice[index];
    const effective = raw === "wild" ? p.wildAs : raw;
    if (effective !== face) throw new Error("Select bayonet dice.");
    picked.push(index);
  }
  if (remaining(state, side, face) < picked.length) {
    const word = picked.length === 1 ? "Bayonet" : "Bayonets";
    throw new Error(`Need ${picked.length} ${word}.`);
  }
  for (const index of picked) p.spentDice.push(index);
  p.spent[face] = (p.spent[face] || 0) + picked.length;
}

export function remaining(state, side, face) {
  const have = spendable(state, side)[face] || 0;
  const used = state.players[side].spent?.[face] || 0;
  return have - used;
}

export function assignWilds(state, side, symbol) {
  const p = state.players[side];
  if (!naturalFaces(p.dice).includes(symbol)) return false;
  p.wildAs = symbol;
  return true;
}

export function autoAssignWilds(state, side) {
  const p = state.players[side];
  const nat = naturalFaces(p.dice);
  if (!nat.length) {
    p.wildAs = null;
    return;
  }
  const counts = {};
  for (const f of nat) counts[f] = (counts[f] || 0) + 1;
  const best = Object.entries(counts).sort(
    (a, b) => b[1] - a[1] || (SYMBOL_RANK[b[0]] || 0) - (SYMBOL_RANK[a[0]] || 0),
  )[0][0];
  p.wildAs = best;
}

export function hasShock(state, side) {
  const p = state.players[side];
  if (!p.committed) return false;
  const faces = p.dice.map((f) => (f === "wild" ? p.wildAs : f));
  if (faces.some((f) => !f)) return false;
  const first = faces[0];
  if (!faces.every((f) => f === first)) return false;
  return p.dice.includes(first);
}

export function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function describePool(p) {
  return p.dice
    .filter((f) => f)
    .map((f) => (f === "wild" && p.wildAs ? cap(p.wildAs) : cap(f)))
    .join(", ");
}

export function commitDice(state, side, wildAs = null) {
  const p = state.players[side];
  if (wildAs) assignWilds(state, side, wildAs);
  else autoAssignWilds(state, side);
  p.committed = true;
  p.spent = { boot: 0, shovel: 0, bayonet: 0, whistle: 0 };
  p.spentDice = [];
  log(state, `${labelSide(side)} commits ${describePool(p)}.`);
}

export function rollHits(state, n) {
  const faces = [];
  let hits = 0;
  for (let i = 0; i < n; i += 1) {
    const f = rollAttackDie(state);
    faces.push(f);
    if (f === "hit") hits += 1;
  }
  state.lastRoll = { kind: "attack", faces, hits };
  return { faces, hits };
}

export function unusedDice(state, side) {
  return ["boot", "shovel", "bayonet", "whistle"].reduce((n, face) => n + Math.max(0, remaining(state, side, face)), 0);
}

export function canRegroup(state, side) {
  const p = state.players[side];
  const trench = state.soldiers.filter((s) => s.owner === side && s.loc === ownTrench(side)).length;
  const available = state.soldiers.some((s) => s.owner === side && s.loc === "available");
  const canExchange = (p.regroupExchanged || 0) < 2 && unusedDice(state, side) > 0 && trench < 5 && available;
  const canDraw = !p.regroupDrew && p.eventHand.length < 7 && (state.eventDisplay.length || state.eventDeck.length);
  return canExchange || canDraw;
}
