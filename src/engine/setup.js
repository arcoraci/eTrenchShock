import { FORMATS, uid, shuffle, resetIds, refreshControl, log, ownTrench, ownZone1, sideZones, ZONE_LABELS } from "./core.js";
import { createMatchId } from "../export/ledger.js";

export function emptyPlayer(side) {
  return {
    side,
    dice: [],
    kept: [true, true, true, true, true],
    rollsUsed: 1,
    committed: false,
    wildAs: null,
    eventHand: [],
    missionHand: [],
    completedMissions: [],
    destroyedCover: [],
    generalsOrderUsed: false,
    attackedIds: [],
    movedIds: [],
    movedEquip: [],
    firedEquip: [],
    spent: { boot: 0, shovel: 0, bayonet: 0, whistle: 0 },
    spentDice: [],
    regroupDraws: 0,
    regroupExchanged: 0,
    regroupDrew: false,
    soldierDeployed: false,
    eventsAtStep: null,
    movedTanks: [],
  };
}

export function emptyEffects() {
  return {
    christmasTruce: false,
    boggedDown: false,
    trenchFoot: false,
    cavalryCharge: null,
    smoke: [],
    suppression: null,
    mobility: [],
    precision: [],
    spotter: [],
    stolenDie: null,
    boggedDownBy: null,
    trenchFootBy: null,
    suppressionBy: null,
  };
}

function buildSoldiers(state) {
  for (const side of ["uk", "de"]) {
    const zone1 = side === "uk" ? "uk1" : "de1";
    const zone2 = side === "uk" ? "uk2" : "de2";
    for (let i = 0; i < 5; i += 1) state.soldiers.push({ id: uid("s"), owner: side, loc: zone1, coverId: null });
    for (let i = 0; i < 5; i += 1) state.soldiers.push({ id: uid("s"), owner: side, loc: zone2, coverId: null });
    for (let i = 0; i < 3; i += 1) {
      state.soldiers.push({ id: uid("s"), owner: side, loc: ownTrench(side), coverId: null });
    }
    for (let i = 0; i < 12; i += 1) {
      state.soldiers.push({ id: uid("s"), owner: side, loc: "available", coverId: null });
    }
  }
}

function buildEquipment(state) {
  for (const side of ["uk", "de"]) {
    for (let n = 0; n < 3; n += 1) {
      state.equipment.push({ id: uid("mg"), owner: side, type: "mg", loc: "supply", damage: 0 });
    }
    for (let n = 0; n < 3; n += 1) {
      state.equipment.push({ id: uid("mor"), owner: side, type: "mortar", loc: "supply", damage: 0 });
    }
    for (let n = 0; n < 3; n += 1) {
      state.equipment.push({ id: uid("tk"), owner: side, type: "tank", loc: "supply", damage: 0 });
    }
  }
}

function buildCover(state) {
  const defs = [1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 4];
  const tokens = defs.map((defense) => ({
    id: uid("cv"),
    defense,
    revealed: false,
    loc: "supply",
    destroyed: false,
    trophyOwner: null,
  }));
  state.coverSupply = shuffle(state, tokens);
}

function resolveCoverZone(side, requested) {
  if (requested == null || requested === "") return ownZone1(side);
  if (!sideZones(side).includes(requested)) {
    throw new Error("Starting cover must be placed in one of your zones.");
  }
  return requested;
}

function placeStartingCover(state, coverZones = {}) {
  for (const side of ["uk", "de"]) {
    const token = state.coverSupply.shift();
    if (!token) break;
    const zone = resolveCoverZone(side, coverZones[side]);
    token.loc = zone;
    state.covers.push(token);
    const who = side === "uk" ? "Britain" : "Germany";
    log(state, `${who} places starting Cover in ${ZONE_LABELS[zone]}.`);
  }
}

function buildEvents(state, catalog) {
  const regular = [];
  const starters = { Reinforce: [], "General's Order": [], Patrol: [], Charge: [], other: [] };
  for (const definition of catalog) {
    for (let n = 0; n < definition.qty; n += 1) {
      const card = { inst: uid("ev"), ...definition };
      if (definition.starter) {
        const key = starters[definition.title] ? definition.title : "other";
        starters[key].push(card);
      } else {
        regular.push(card);
      }
    }
  }
  const shuffledRegular = shuffle(state, regular);
  for (const side of ["uk", "de"]) {
    const hand = [
      starters.Reinforce.pop() || null,
      starters.Reinforce.pop() || null,
      starters["General's Order"].pop() || null,
      starters.Patrol.pop() || null,
      starters.Charge.pop() || null,
      shuffledRegular.pop() || null,
      shuffledRegular.pop() || null,
    ].filter(Boolean);
    state.players[side].eventHand = hand;
  }
  state.eventDeck = shuffle(state, shuffledRegular);
  const display = [];
  for (let i = 0; i < 3; i += 1) {
    if (state.eventDeck.length) display.push(state.eventDeck.pop());
  }
  state.eventDisplay = display;
}

function buildMissions(state, catalog, spec) {
  let deck = [];
  for (const definition of catalog) {
    for (let n = 0; n < definition.qty; n += 1) {
      deck.push({ inst: uid("ms"), ...definition, scored: false });
    }
  }
  deck = shuffle(state, deck).slice(spec.remove);
  state.missionDeck = deck.slice(0, spec.missions);
  for (const side of ["uk", "de"]) {
    const hand = [];
    if (state.missionDeck.length) hand.push(state.missionDeck.shift());
    if (state.missionDeck.length) hand.push(state.missionDeck.shift());
    state.players[side].missionHand = hand;
  }
}

export function beginInitiative(state) {
  state.phase = "initiative";
  state.actionStep = null;
  state.active = null;
  state.player1 = null;
  state.initiative = null;
  state.effects = emptyEffects();
  state.regroupDone = { uk: false, de: false };
  state.roundMissions = { uk: false, de: false };
  for (const side of ["uk", "de"]) {
    const p = state.players[side];
    p.dice = [];
    p.kept = [true, true, true, true, true];
    p.rollsUsed = 1;
    p.committed = false;
    p.wildAs = null;
    p.generalsOrderUsed = false;
    p.attackedIds = [];
    p.movedIds = [];
    p.movedEquip = [];
    p.firedEquip = [];
    p.spent = { boot: 0, shovel: 0, bayonet: 0, whistle: 0 };
    p.spentDice = [];
    p.regroupDraws = 0;
    p.regroupExchanged = 0;
    p.regroupDrew = false;
    p.soldierDeployed = false;
    p.eventsAtStep = null;
    p.movedTanks = [];
  }
  state.pending = { type: "roll1" };
  state.lastRoll = null;
}

const FORMAT_NAMES = {
  short: "Short Battle",
  standard: "Standard Battle",
  extended: "Extended Battle",
};

function headquartersDifficulty(mode, value) {
  if (mode !== "solo") return null;
  if (value === "Easy" || value === "Difficult" || value === "Hard") return value;
  return "Difficult";
}

export function createGame(events, missions, options = {}) {
  const format = options.format || "standard";
  const human = options.human === "de" ? "de" : "uk";
  const mode = options.mode || "solo";
  const difficulty = headquartersDifficulty(mode, options.difficulty);
  resetIds(1);
  const spec = FORMATS[format] || FORMATS.standard;
  const seed = options.seed != null ? options.seed >>> 0 : (Date.now() >>> 0);
  const battlefield = ["uk1", "uk2", "uk3", "obj", "de3", "de2", "de1"];
  const blankMap = () => Object.fromEntries(battlefield.map((z) => [z, null]));
  const state = {
    format,
    mode,
    maxRounds: spec.rounds,
    round: 1,
    seed,
    initialSeed: seed,
    matchId: options.matchId || createMatchId(),
    human,
    ai: human === "uk" ? "de" : "uk",
    difficulty,
    phase: "setup",
    actionStep: null,
    active: null,
    player1: null,
    initiative: null,
    vp: { uk: 0, de: 0 },
    control: blankMap(),
    territoryOwner: blankMap(),
    hadTank: Object.fromEntries(battlefield.map((z) => [z, false])),
    soldiers: [],
    equipment: [],
    covers: [],
    coverSupply: [],
    players: { uk: emptyPlayer("uk"), de: emptyPlayer("de") },
    eventDeck: [],
    eventDisplay: [],
    eventDiscard: [],
    missionDeck: [],
    effects: emptyEffects(),
    combat: null,
    pending: null,
    regroupDone: { uk: false, de: false },
    winner: null,
    tiebreak: null,
    log: [],
    lastRoll: null,
    error: null,
    roundElim: { uk: 0, de: 0 },
    roundBurst: { uk: false, de: false },
    roundSupportKill: { uk: false, de: false },
    roundTankKill: { uk: false, de: false },
    missionExhausted: false,
    missionPulse: [],
    killPulse: [],
    roundBrief: [],
  };
  buildSoldiers(state);
  buildEquipment(state);
  buildCover(state);
  buildEvents(state, events);
  buildMissions(state, missions, spec);
  placeStartingCover(state, options.coverZones || {});
  refreshControl(state);
  const who = human === "uk" ? "Britain" : "Germany";
  if (mode === "hotseat") {
    log(state, `${FORMAT_NAMES[format] || "Battle"} — ${spec.rounds} rounds. Pass-and-play.`);
  } else if (mode === "sim") {
    log(state, `${FORMAT_NAMES[format] || "Battle"} — ${spec.rounds} rounds.`);
  } else {
    log(state, `${FORMAT_NAMES[format] || "Battle"} — ${spec.rounds} rounds. You command ${who}. Headquarters: ${difficulty}.`);
  }
  beginInitiative(state);
  return state;
}
