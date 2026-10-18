import { buildXlsx } from "./xlsx.js";

export const LEDGER_KEY = "trench-shock-balance";
export const FILENAME = "trench-shock-balance.xlsx";
const LOG_CAP = 80;

const GAME_FIELDS = [
  ["Finished at", "finishedAt", "text"],
  ["Winner", "winner", "text"],
  ["Britain VP", "vpUk", "number"],
  ["Germany VP", "vpDe", "number"],
  ["Margin (Britain - Germany)", "margin", "number"],
  ["Rounds played", "rounds", "number"],
  ["How it ended", "ended", "text"],
  ["Decided by", "decidedBy", "text"],
  ["Britain missions", "missionsUk", "number"],
  ["Germany missions", "missionsDe", "number"],
  ["Britain mission list", "missionListUk", "text"],
  ["Germany mission list", "missionListDe", "text"],
  ["Seed", "seed", "number"],
  ["Britain control", "britain", "text"],
  ["Germany control", "germany", "text"],
  ["Format", "format", "text"],
  ["Note", "note", "text"],
];

export const GAME_COLUMNS = GAME_FIELDS.map(([label]) => label);

export function createMatchId() {
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0");
  return `ts-${time}-${rand}`;
}

function legacyFinishedId(state) {
  const uk = state.vp?.uk ?? "";
  const de = state.vp?.de ?? "";
  return [
    "legacy",
    state.initialSeed ?? state.seed ?? "x",
    state.format || "",
    state.round ?? "",
    uk,
    de,
    state.winner || "draw",
    state.tiebreak || "",
  ].join("-");
}

export function ensureMatchId(state) {
  if (!state) return "";
  if (!state.matchId) state.matchId = state.phase === "end" ? legacyFinishedId(state) : createMatchId();
  return state.matchId;
}

export function formatLocalWhen(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function winnerLabel(state) {
  if (state.winner === "uk") return "Britain";
  if (state.winner === "de") return "Germany";
  return "Draw";
}

function decidedBy(state) {
  const uk = num(state.vp?.uk);
  const de = num(state.vp?.de);
  if (uk !== de) return "VP";
  if (state.winner === "uk" || state.winner === "de") return "Tiebreak";
  return "Draw";
}

function missionsOf(state, side) {
  const list = state.players?.[side]?.completedMissions;
  if (!Array.isArray(list)) return { count: "", titles: "" };
  const titles = list.map((mission) => (mission?.title ? String(mission.title) : "")).filter(Boolean);
  return { count: list.length, titles: titles.join("; ") };
}

function sidePlayer(state, side) {
  if (state.mode === "hotseat") return "Human";
  if (state.mode === "sim") return "AI";
  const human = state.human === "de" ? "de" : "uk";
  return side === human ? "Human" : "AI";
}

function formatLabel(format) {
  if (format === "short") return "Short";
  if (format === "standard") return "Standard";
  if (format === "extended") return "Extended";
  return format ? String(format) : "";
}

function seedOf(state) {
  const value = state.initialSeed != null ? state.initialSeed : state.seed;
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function toRow(state, now) {
  const vpUk = num(state.vp?.uk);
  const vpDe = num(state.vp?.de);
  const britain = missionsOf(state, "uk");
  const germany = missionsOf(state, "de");
  const rounds = Number(state.round);
  return {
    id: state.matchId,
    finishedAt: formatLocalWhen(now),
    winner: winnerLabel(state),
    vpUk,
    vpDe,
    margin: vpUk - vpDe,
    rounds: Number.isFinite(rounds) ? rounds : "",
    ended: state.tiebreak ? String(state.tiebreak) : "",
    decidedBy: decidedBy(state),
    missionsUk: britain.count,
    missionsDe: germany.count,
    missionListUk: britain.titles,
    missionListDe: germany.titles,
    seed: seedOf(state),
    britain: sidePlayer(state, "uk"),
    germany: sidePlayer(state, "de"),
    format: formatLabel(state.format),
    note: "",
  };
}

export function readLedger(storage) {
  if (!storage) return [];
  let raw = null;
  try {
    raw = storage.getItem(LEDGER_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.games)) return [];
    return data.games.filter((row) => row && typeof row === "object");
  } catch {
    return [];
  }
}

function writeLedger(storage, games) {
  storage.setItem(LEDGER_KEY, JSON.stringify({ version: 1, games }));
}

export function recordFinished(storage, state, now = new Date()) {
  const games = readLedger(storage);
  if (!state || state.phase !== "end") return { added: false, games, error: false };
  ensureMatchId(state);
  if (games.some((row) => row.id === state.matchId)) return { added: false, games, error: false };
  const next = games.concat(toRow(state, now));
  try {
    writeLedger(storage, next);
    return { added: true, games: next, error: false };
  } catch {
    return { added: false, games: next, error: true };
  }
}

export function dropIfUnfinished(storage, state) {
  if (!state?.matchId || state.phase === "end") return false;
  const games = readLedger(storage);
  const next = games.filter((row) => row.id !== state.matchId);
  if (next.length === games.length) return false;
  writeLedger(storage, next);
  return true;
}

export function onBattleLoaded(storage, state) {
  if (!state) return { added: false, games: readLedger(storage), error: false };
  ensureMatchId(state);
  if (state.phase !== "end") return { added: false, games: readLedger(storage), error: false };
  return recordFinished(storage, state);
}

export function summarize(games) {
  const list = Array.isArray(games) ? games : [];
  const britain = list.filter((row) => row.winner === "Britain").length;
  const germany = list.filter((row) => row.winner === "Germany").length;
  const draws = list.filter((row) => row.winner === "Draw").length;
  const played = list.length;
  const rate = (count) => (played ? count / played : null);
  return {
    played,
    britain,
    germany,
    draws,
    britainRate: rate(britain),
    germanyRate: rate(germany),
    drawRate: rate(draws),
  };
}

function numberCell(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? n : "";
}

function gameRows(games) {
  const rows = [GAME_COLUMNS.slice()];
  for (const game of games) {
    rows.push(GAME_FIELDS.map(([, key, kind]) => (
      kind === "number" ? numberCell(game?.[key]) : (game?.[key] == null ? "" : String(game[key]))
    )));
  }
  return rows;
}

function logRows(log) {
  if (log == null) return { rows: [["There is no finished game."]], headerRow: -1 };
  const lines = Array.isArray(log) ? log.slice().reverse() : [];
  const rows = [];
  if (lines.length >= LOG_CAP) rows.push(["The battle log keeps the latest 80 lines."]);
  const headerRow = rows.length;
  rows.push(["Round", "Message"]);
  for (const line of lines) {
    const round = Number(line?.round);
    rows.push([
      Number.isFinite(round) ? round : "",
      line?.text == null ? "" : String(line.text),
    ]);
  }
  return { rows, headerRow };
}

function summaryRows(games) {
  const stats = summarize(games);
  const rate = (value) => (value == null ? "" : { percent: value });
  return [
    ["Games played", stats.played],
    ["Britain wins", stats.britain],
    ["Germany wins", stats.germany],
    ["Draws", stats.draws],
    ["Britain win rate", rate(stats.britainRate)],
    ["Germany win rate", rate(stats.germanyRate)],
    ["Draw rate", rate(stats.drawRate)],
  ];
}

const GAME_WIDTHS = [20, 12, 12, 14, 28, 16, 22, 14, 18, 18, 36, 36, 14, 18, 18, 14, 24];

export function buildBalanceWorkbook(games, log) {
  const list = Array.isArray(games) ? games : [];
  const logSheet = logRows(log);
  return buildXlsx([
    {
      name: "Games",
      rows: gameRows(list),
      headerRow: 0,
      widths: GAME_WIDTHS,
      freeze: true,
      filter: true,
    },
    {
      name: "Log",
      rows: logSheet.rows,
      headerRow: logSheet.headerRow,
      widths: [12, 88],
    },
    {
      name: "Summary",
      rows: summaryRows(list),
      headerRow: -1,
      widths: [20, 14],
    },
  ]);
}
