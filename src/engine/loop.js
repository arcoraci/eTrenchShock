import { chooseAiAction } from "./ai.js";
import { apply, isInteractive } from "./game.js";
import { canRegroup, hasWildFace } from "./dice.js";
import { createGame } from "./setup.js";
import { soldiersIn } from "./core.js";
import { preferredMissionAction } from "./missions.js";

function pendingSide(state) {
  const pending = state.pending || {};
  if (pending.type === "generals-order" || pending.type === "spotter" || pending.type === "mortar-target" || pending.type === "gambit" || pending.type === "pick-mission") {
    return pending.side;
  }
  if (state.phase === "reroll" || state.phase === "action" || state.phase === "regroup") return state.active;
  return null;
}

export function needsHuman(state) {
  if (!state || state.phase === "end") return false;
  const side = pendingSide(state);
  if (!side || !isInteractive(state, side)) return false;
  if (state.phase === "regroup" && !canRegroup(state, side)) return false;
  return true;
}

function skipFor(state) {
  const mission = preferredMissionAction(state);
  if (mission) return mission;
  if (state.pending?.type === "gambit" && state.pending.stage === "keep") {
    return { type: "PICK_GAMBIT", inst: state.pending.cards[0]?.inst };
  }
  if (state.pending?.type === "gambit") return { type: "FINISH_GAMBIT" };
  if (state.pending?.type === "mortar-target") {
    return { type: "ALLOCATE_MORTAR", targetId: state.pending.options[0]?.id };
  }
  if (state.pending?.type === "generals-order") return { type: "SKIP_GENERALS_ORDER" };
  if (state.pending?.type === "spotter") return { type: "PICK_SPOTTER", face: state.pending.options[0] };
  if (state.pending?.type === "allocate-hits") return { type: "ALLOCATE_HITS", auto: true };
  if (state.phase === "reroll") return { type: "COMMIT" };
  if (state.phase === "regroup") return { type: "SKIP_REGROUP" };
  const map = {
    shock: "SKIP_SHOCK",
    tank: "SKIP_TANK",
    event: "SKIP_EVENT",
    deploy: "SKIP_DEPLOY",
    move: "SKIP_MOVE",
    cover: "SKIP_COVER",
    attack: "SKIP_ATTACK",
  };
  if (map[state.actionStep]) return { type: map[state.actionStep] };
  return null;
}

function applyEmptyWildCommit(state) {
  if (state.phase !== "reroll" || !state.active) return null;
  const player = state.players[state.active];
  if (!player || hasWildFace(player.dice)) return null;
  if ((player.rollsUsed || 0) < 3) return null;
  return apply(state, { type: "COMMIT" });
}

export function runUntilHuman(state) {
  let guard = 0;
  while (state && state.phase !== "end" && guard < 160) {
    guard += 1;
    if (state.pending?.type === "mortar-target") {
      const options = state.pending.options || [];
      const pick = options.find((option) => option.kind === "exposed") || options[0];
      if (!pick) break;
      const landed = apply(state, { type: "ALLOCATE_MORTAR", targetId: pick.id });
      if (landed.error) break;
      state = landed;
      continue;
    }
    if (state.phase === "initiative" && state.pending?.type === "roll1") {
      state = apply(state, { type: "ROLL_1" });
      continue;
    }
    if (state.phase === "regroup" && state.active && !canRegroup(state, state.active)) {
      state = apply(state, { type: "SKIP_REGROUP" });
      continue;
    }
    const passed = applyEmptyWildCommit(state);
    if (passed) {
      if (passed.error) break;
      state = passed;
      continue;
    }
    if (needsHuman(state)) break;
    const act = chooseAiAction(state);
    if (!act) break;
    const before = state;
    state = apply(state, act);
    if (state.error) {
      const skip = skipFor(before);
      if (!skip) break;
      state = apply(before, skip);
      if (state.error) break;
    }
  }
  return state;
}

export function startMatch(events, missions, options) {
  return runUntilHuman(createGame(events, missions, options));
}

export function play(state, action) {
  const next = apply(state, action);
  if (next.error) return next;
  return runUntilHuman(next);
}

function audit(state) {
  for (const side of ["uk", "de"]) {
    const n = state.soldiers.filter((s) => s.owner === side).length;
    if (n !== 25) return `${side} has ${n} soldiers`;
    if (state.phase !== "end" && state.players[side].missionHand.length > 5) return `${side} holds too many missions`;
    const owned = state.equipment.filter((u) => u.owner === side);
    const ofType = (type) => owned.filter((u) => u.type === type).length;
    if (ofType("mg") !== 3 || ofType("mortar") !== 3 || ofType("tank") !== 3) {
      return `${side} equipment ${owned.length}`;
    }
  }
  for (const cover of state.covers) {
    if (cover.destroyed) continue;
    const occ = soldiersIn(state, cover.loc, { matchCover: true, coverId: cover.id });
    if (occ.length > 3) return `cover ${cover.id} over capacity`;
    const owners = new Set(occ.map((s) => s.owner));
    if (owners.size > 1) return `cover ${cover.id} shared`;
  }
  return null;
}

export function simulateGames(events, missions, count = 20) {
  const results = [];
  for (let i = 0; i < count; i += 1) {
    let state = createGame(events, missions, { format: i % 3 === 0 ? "short" : "standard", human: "uk", seed: 1000 + i * 17, mode: "sim" });
    let guard = 0;
    let failed = null;
    while (state.phase !== "end" && guard < 4000) {
      guard += 1;
      const problem = audit(state);
      if (problem) {
        failed = problem;
        break;
      }
      if (state.phase === "initiative" && state.pending?.type === "roll1") {
        state = apply(state, { type: "ROLL_1" });
        if (state.error) {
          failed = state.error;
          break;
        }
        continue;
      }
      if (state.phase === "regroup" && !canRegroup(state, state.active)) {
        state = apply(state, { type: "SKIP_REGROUP" });
        continue;
      }
      const passed = applyEmptyWildCommit(state);
      if (passed) {
        if (passed.error) {
          failed = passed.error;
          break;
        }
        state = passed;
        continue;
      }
      const act = chooseAiAction(state);
      if (!act) {
        failed = `no action in ${state.phase}/${state.actionStep}`;
        break;
      }
      const before = state;
      state = apply(state, act);
      if (state.error) {
        const skip = skipFor(before);
        state = skip ? apply(before, skip) : state;
        if (state.error) {
          failed = state.error;
          break;
        }
      }
    }
    const problem = failed || (state.phase !== "end" ? "did not finish" : audit(state));
    results.push({
      seed: 1000 + i * 17,
      ok: !problem && state.phase === "end",
      error: problem,
      winner: state.winner,
      round: state.round,
      vp: state.vp,
      steps: guard,
    });
  }
  return {
    played: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
  };
}
