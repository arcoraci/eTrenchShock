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

export function checkMissions(state, side, ctx = {}) {
  const hand = state.players[side].missionHand.slice();
  for (const mission of hand) {
    if (isComplete(state, side, mission, ctx)) completeMission(state, side, mission);
  }
}

function completeMission(state, side, mission) {
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
