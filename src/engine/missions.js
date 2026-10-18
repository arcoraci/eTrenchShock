import { log, labelSide, pushRoundBrief, soldiersIn, controllerOf, enemySideZones, BATTLEFIELD } from "./core.js";

export function drawMission(state, required) {
  if (!state.missionDeck.length) {
    if (required) {
      state.missionExhausted = true;
      log(state, "Mission Exhaustion — no Mission remains to draw.");
    }
    return null;
  }
  return state.missionDeck.shift();
}

export function trimMissions(state, side) {
  const hand = state.players[side].missionHand;
  while (hand.length > 5) state.missionDeck.push(hand.pop());
}

function missionTaken(state, side) {
  return Boolean(state.roundMissions && state.roundMissions[side]);
}

function sideChooses(state, side) {
  if (!state || state.mode === "sim") return false;
  if (state.mode === "hotseat") return true;
  return side === state.human;
}

function highestMission(ready) {
  let best = ready[0];
  for (const mission of ready) {
    if (mission.vp > best.vp) best = mission;
  }
  return best;
}

export function checkMissions(state, side, ctx = {}) {
  if (state.pending?.type === "pick-mission") return "choose";
  if (missionTaken(state, side)) return "none";
  const hand = state.players[side].missionHand.slice();
  const ready = hand.filter((mission) => isComplete(state, side, mission, ctx));
  if (!ready.length) return "none";
  if (ready.length > 1 && sideChooses(state, side)) {
    state.pending = {
      type: "pick-mission",
      side,
      insts: ready.map((mission) => mission.inst),
      ctx: { timing: ctx.timing || null },
      after: null,
    };
    return "choose";
  }
  completeMission(state, side, ready.length === 1 ? ready[0] : highestMission(ready));
  return "done";
}

export function chooseMission(state, inst) {
  const pending = state.pending;
  if (!pending || pending.type !== "pick-mission") throw new Error("No mission choice is waiting.");
  const side = pending.side;
  if (missionTaken(state, side)) throw new Error("A mission is already complete this round.");
  const mission = state.players[side].missionHand.find((card) => card.inst === inst);
  if (!mission || !(pending.insts || []).includes(mission.inst)) throw new Error("Choose one of those missions.");
  const ctx = pending.ctx || {};
  if (!isComplete(state, side, mission, ctx)) throw new Error("That mission is not complete.");
  const after = pending.after || null;
  state.pending = null;
  completeMission(state, side, mission);
  return after;
}

export function preferredMissionAction(state) {
  const pending = state.pending;
  if (pending?.type !== "pick-mission") return null;
  const hand = state.players[pending.side]?.missionHand || [];
  const options = [];
  for (const inst of pending.insts || []) {
    const mission = hand.find((card) => card.inst === inst);
    if (mission) options.push(mission);
  }
  if (!options.length) return null;
  return { type: "PICK_MISSION", inst: highestMission(options).inst };
}

function completeMission(state, side, mission) {
  if (!state.roundMissions) state.roundMissions = { uk: false, de: false };
  if (state.roundMissions[side]) return;
  state.roundMissions[side] = true;
  state.vp[side] += mission.vp;
  const p = state.players[side];
  p.missionHand = p.missionHand.filter((m) => m.inst !== mission.inst);
  p.completedMissions.push(mission);
  if (!state.missionPulse) state.missionPulse = [];
  state.missionPulse.push({ side, inst: mission.inst, title: mission.title, vp: mission.vp });
  const missionText = `${labelSide(side)} completes ${mission.title} (+${mission.vp} VP).`;
  log(state, missionText);
  pushRoundBrief(state, missionText);
  const replacement = drawMission(state, true);
  if (replacement) {
    p.missionHand.push(replacement);
    checkMissions(state, side, { timing: "immediate" });
  }
}

function isComplete(state, side, mission, ctx) {
  const title = mission.title;
  if (title === "Hold in Cover") {
    return controllerOf(state, "obj") === side && soldiersIn(state, "obj", { side, exposed: false }).length >= 1;
  }
  if (title === "Over the Top") {
    const zones = ["obj", ...enemySideZones(side)];
    return zones.reduce((n, z) => n + soldiersIn(state, z, { side }).length, 0) >= 3;
  }
  if (title === "Guns Silenced") {
    return mission.type === "EVENT" && ctx.timing === "combat" && state.roundSupportKill[side];
  }
  if (title === "Tank Hunter") {
    return mission.type === "EVENT" && ctx.timing === "combat" && state.roundTankKill[side];
  }
  if (title === "No Shelter") return state.players[side].destroyedCover.length >= 3;
  if (title === "Deep Push") {
    return enemySideZones(side).filter((z) => controllerOf(state, z) === side).length >= 2;
  }
  if (title === "Shock Action") {
    return mission.type === "EVENT" && ctx.timing === "combat" && state.roundBurst[side];
  }
  if (title === "In the Wire") {
    return enemySideZones(side).some((z) => soldiersIn(state, z, { side }).length >= 4);
  }
  if (title === "Dug In") {
    return (
      mission.type === "STATE" &&
      ctx.timing === "end" &&
      BATTLEFIELD.reduce((n, z) => n + soldiersIn(state, z, { side, exposed: false }).length, 0) >= 3
    );
  }
  if (title === "Breakthrough") {
    return (
      mission.type === "STATE" &&
      ctx.timing === "end" &&
      controllerOf(state, "obj") === side &&
      enemySideZones(side).some((z) => controllerOf(state, z) === side)
    );
  }
  if (title === "Attrition") {
    return mission.type === "EVENT" && (ctx.timing === "combat" || ctx.timing === "immediate") && (state.roundElim[side] || 0) >= 5;
  }
  return false;
}
