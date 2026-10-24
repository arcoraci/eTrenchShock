export const TUTORIAL_KEY = "trench-shock-tutorial";

export function tutorialStatus(storage) {
  try {
    const value = storage?.getItem(TUTORIAL_KEY);
    if (value === "done" || value === "skipped" || value === "offered") return value;
  } catch {
    /* Storage can be blocked. The offer still works for this visit. */
  }
  return "";
}

export function rememberTutorial(storage, status) {
  if (!storage || (status !== "done" && status !== "skipped" && status !== "offered")) return;
  storage.setItem(TUTORIAL_KEY, status);
}

export function coverTutorialText() {
  return "Place your starting cover in Zone 1, Zone 2, or Zone 3 on your side. Headquarters places its own cover in Zone 1.";
}

function teachSide(game) {
  if (game?.mode === "hotseat") return game.player1 || game.human;
  return game?.human;
}

export function tutorialCard(game) {
  if (!game) return null;
  const pending = game.pending?.type;
  const human = game.human;
  const teach = teachSide(game);
  if (pending === "generals-order") {
    if (game.mode !== "hotseat" && game.pending.side !== human) return null;
    return {
      id: "order",
      text: "Roll 1 sets initiative, and wilds are ignored. General's Order can reroll up to two of these dice, or change one die to a face already showing, before initiative is fixed.",
    };
  }
  if (pending === "allocate-hits") {
    if (game.pending.side !== (game.mode === "hotseat" ? teach : human)) return null;
    return {
      id: "hits",
      text: "Assign each hit to a soldier or the cover in this target. The cover is destroyed when the hits reach its defense, and further hits eliminate the soldiers inside.",
    };
  }
  if (pending === "spotter") {
    if (game.pending.side !== (game.mode === "hotseat" ? teach : human)) return null;
    return {
      id: "spotter",
      text: "The spotter rolled the mortar die twice. Choose one of those zones. The round then lands there and places one hit.",
    };
  }
  if (game.phase === "reroll") {
    const side = game.active;
    if (game.mode !== "hotseat" && side !== human) return null;
    const used = game.players?.[side]?.rollsUsed || 1;
    if (used <= 1) {
      return {
        id: "roll2",
        text: "Roll 1 set initiative, and wilds were ignored. This is Roll 2: both sides may reroll any number of dice, and initiative will not change.",
      };
    }
    if (used === 2) {
      return {
        id: "roll3",
        text: "This is Roll 3, the last reroll for both sides. Initiative stays with the winner of Roll 1.",
      };
    }
    return {
      id: "commit",
      text: "Roll 2 and Roll 3 are finished. Commit these dice. Initiative will not change.",
    };
  }
  if (game.phase === "action" && game.pending?.type === "action" && game.active === teach) {
    if (game.mode !== "hotseat" && game.active !== human) return null;
    const first = game.player1 === teach;
    if (game.actionStep === "shock") {
      const lead = first
        ? "You won initiative, so you act first."
        : "The winner of initiative has already acted.";
      return {
        id: "shock",
        text: `${lead} Mustard Gas spends all five matching dice and eliminates exposed soldiers in the enemy Zones 1, 2, and 3 without striking cover.`,
      };
    }
    const copy = {
      tank: "Each tank on the field may advance one or two zones, and it stops if it meets an enemy tank.",
      event: "Play an event from your hand for one Whistle. General's Order cannot be played now.",
      deploy: "Select the bayonet dice to spend: one for a soldier or a repair, two for a mortar in Zone 1 if you control it, three for a machine gun on your side, and four for a tank in Zone 1.",
      move: "A Boot moves a soldier or support weapon one zone. From the trench, a soldier only advances into your Zone 1.",
      cover: "A Shovel digs one exposed soldier into cover. Cover is destroyed when the hits at least equal its defense, and the soldiers inside become exposed.",
      attack: "Choose soldiers or a weapon, then a target, and assign the hits yourself. A mortar round lands in an enemy zone and places one hit on its own; cover stops hits until they reach its defense.",
    };
    if (!copy[game.actionStep]) return null;
    return { id: game.actionStep, text: copy[game.actionStep] };
  }
  return null;
}
