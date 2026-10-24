import { recordFinished } from "../export/ledger.js";

export const REPLAY_KEY = "trench-shock-replay";

export function replayEmptyMessage() {
  return "No finished battle is recorded yet. Replay starts with the next battle you play to the end. Quitting mid-battle does not record one, and an older balance-sheet row is not turned into a board.";
}

export function boardShot(state) {
  const initiative = state?.initiative;
  return {
    round: state?.round || 1,
    phase: state?.phase || "",
    vp: { uk: state?.vp?.uk || 0, de: state?.vp?.de || 0 },
    winner: state?.winner || null,
    tiebreak: state?.tiebreak || "",
    soldiers: (state?.soldiers || []).map((soldier) => ({
      id: soldier.id,
      owner: soldier.owner,
      loc: soldier.loc,
      coverId: soldier.coverId || null,
    })),
    equipment: (state?.equipment || []).map((unit) => ({
      id: unit.id,
      owner: unit.owner,
      type: unit.type,
      loc: unit.loc,
      damage: unit.damage || 0,
    })),
    covers: (state?.covers || []).map((cover) => ({
      id: cover.id,
      loc: cover.loc,
      defense: cover.defense,
      revealed: Boolean(cover.revealed),
      destroyed: Boolean(cover.destroyed),
      trophyOwner: cover.trophyOwner || null,
    })),
    smoke: Array.isArray(state?.effects?.smoke) ? state.effects.smoke.slice() : [],
    initiative: initiative?.winner ? {
      winner: initiative.winner,
      tieRolls: initiative.tieRolls || 0,
      uk: initiative.uk || null,
      de: initiative.de || null,
    } : null,
  };
}

function freshTexts(before, after) {
  const prev = before?.log || [];
  const next = after?.log || [];
  if (!prev.length) return next.slice(0, 8).map((line) => line.text);
  const anchor = prev[0];
  const idx = next.findIndex((line) => line.text === anchor.text && line.round === anchor.round);
  if (idx < 0) return next.slice(0, 8).map((line) => line.text);
  return next.slice(0, idx).map((line) => line.text);
}

export function framesBetween(before, after) {
  if (!before || !after || after.error) return [];
  const texts = freshTexts(before, after).reverse().filter(Boolean);
  if (!texts.length) return [];
  const board = boardShot(after);
  const logSize = (after.log || []).length;
  const frames = [];
  const take = (kind, pattern) => {
    const hits = texts.filter((text) => pattern.test(text));
    if (!hits.length) return;
    frames.push({ kind, text: hits.join(" "), board, logSize });
  };
  take("initiative", /wins Initiative/);
  take("mortar", /mortar hits/i);
  take("gas", /mustard gas/i);
  take("breakthrough", /tank breakthrough/i);
  take("kills", /most kills/i);
  take("mission", /completes .+\(\+/);
  const covered = texts.some((text) => /mortar hits|mustard gas/i.test(text));
  if (!covered) {
    const elims = texts.filter((text) => /Soldier is eliminated|cannot enter the Trench and is lost/.test(text));
    if (elims.length === 1) frames.push({ kind: "elimination", text: elims[0], board, logSize });
    else if (elims.length > 1) frames.push({ kind: "elimination", text: `${elims.length} soldiers eliminated.`, board, logSize });
  }
  const ground = texts.filter((text) => /gains the Objective Zone|takes .+ \(\+1 VP\)/.test(text));
  if (ground.length) frames.push({ kind: "ground", text: ground.join(" "), board, logSize });
  return frames;
}

export function trimTape(tape, state) {
  const size = state?.log?.length || 0;
  return (tape || []).filter((frame) => frame && (frame.logSize || 0) <= size);
}

export function packReplay(tape, state) {
  if (!state || state.phase !== "end") return null;
  const frames = (tape || []).filter((frame) => frame && frame.board && typeof frame.text === "string");
  if (!frames.length) return null;
  return {
    version: 1,
    matchId: state.matchId || "",
    winner: state.winner || null,
    vp: state.vp || null,
    frames,
  };
}

export function storeFinishedReplay(storage, tape, state) {
  const packed = packReplay(tape, state);
  if (!packed || !storage) return null;
  storage.setItem(REPLAY_KEY, JSON.stringify(packed));
  return packed;
}

export function readReplay(storage) {
  if (!storage) return null;
  let raw = null;
  try {
    raw = storage.getItem(REPLAY_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || !Array.isArray(data.frames) || !data.frames.length) return null;
    if (!data.frames.every((frame) => frame && frame.board && typeof frame.text === "string")) return null;
    return data;
  } catch {
    return null;
  }
}

export function onBattleEnded(storage, tape, state) {
  if (!storage || !state || state.phase !== "end") return { replay: false, ledger: false };
  const replay = storeFinishedReplay(storage, tape, state);
  let ledger = false;
  try {
    const result = recordFinished(storage, state);
    ledger = Boolean(result && !result.error);
  } catch {
    ledger = false;
  }
  return { replay: Boolean(replay), ledger };
}
