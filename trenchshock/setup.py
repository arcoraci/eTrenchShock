import time

from .core import FORMATS, uid, shuffle, reset_ids, refresh_control, log, own_trench


def create_game(events, missions, format="standard", human="uk", seed=None):
    reset_ids(1)
    spec = FORMATS.get(format) or FORMATS["standard"]
    state = {
        "format": format,
        "maxRounds": spec["rounds"],
        "round": 1,
        "seed": seed if seed is not None else int(time.time() * 1000) & 0xFFFFFFFF,
        "human": human,
        "ai": "de" if human == "uk" else "uk",
        "phase": "setup",
        "actionStep": None,
        "active": None,
        "player1": None,
        "vp": {"uk": 0, "de": 0},
        "control": {z: None for z in ("uk1", "uk2", "uk3", "obj", "de3", "de2", "de1")},
        "territoryOwner": {z: None for z in ("uk1", "uk2", "uk3", "obj", "de3", "de2", "de1")},
        "hadTank": {z: False for z in ("uk1", "uk2", "uk3", "obj", "de3", "de2", "de1")},
        "soldiers": [],
        "equipment": [],
        "covers": [],
        "coverSupply": [],
        "players": {"uk": empty_player("uk"), "de": empty_player("de")},
        "eventDeck": [],
        "eventDisplay": [],
        "eventDiscard": [],
        "missionDeck": [],
        "effects": empty_effects(),
        "combat": None,
        "pending": None,
        "winner": None,
        "tiebreak": None,
        "log": [],
        "lastRoll": None,
        "roundElim": {"uk": 0, "de": 0},
        "roundBurst": {"uk": False, "de": False},
        "roundSupportKill": {"uk": False, "de": False},
        "roundTankKill": {"uk": False, "de": False},
        "missionExhausted": False,
    }
    build_soldiers(state)
    build_equipment(state)
    build_cover(state)
    build_events(state, events)
    build_missions(state, missions, spec)
    place_starting_cover(state)
    refresh_control(state)
    who = "Britain" if human == "uk" else "Germany"
    log(state, f"Standard Battle — {spec['rounds']} rounds. You command {who}.")
    begin_initiative(state)
    return state


def empty_player(side):
    return {
        "side": side,
        "dice": [],
        "kept": [True, True, True, True, True],
        "rollsUsed": 1,
        "committed": False,
        "wildAs": None,
        "eventHand": [],
        "missionHand": [],
        "completedMissions": [],
        "destroyedCover": [],
        "generalsOrderUsed": False,
        "attackedIds": [],
        "movedEquip": [],
        "firedEquip": [],
        "spent": {"boot": 0, "shovel": 0, "bayonet": 0, "whistle": 0},
        "regroupDraws": 0,
    }


def empty_effects():
    return {
        "christmasTruce": False,
        "boggedDown": False,
        "trenchFoot": False,
        "cavalryCharge": None,
        "smoke": [],
        "suppression": None,
        "mobility": [],
        "precision": [],
        "spotter": [],
        "stolenDie": None,
        "boggedDownBy": None,
        "trenchFootBy": None,
        "suppressionBy": None,
    }


def build_soldiers(state):
    for side in ("uk", "de"):
        zone1 = "uk1" if side == "uk" else "de1"
        zone2 = "uk2" if side == "uk" else "de2"
        for _ in range(5):
            state["soldiers"].append({"id": uid("s"), "owner": side, "loc": zone1, "coverId": None})
        for _ in range(5):
            state["soldiers"].append({"id": uid("s"), "owner": side, "loc": zone2, "coverId": None})
        for _ in range(3):
            state["soldiers"].append({"id": uid("s"), "owner": side, "loc": own_trench(side), "coverId": None})


def build_equipment(state):
    for side in ("uk", "de"):
        state["equipment"].append({"id": uid("mg"), "owner": side, "type": "mg", "loc": "supply", "damage": 0})
        state["equipment"].append({"id": uid("mor"), "owner": side, "type": "mortar", "loc": "supply", "damage": 0})
        state["equipment"].append({"id": uid("tk"), "owner": side, "type": "tank", "loc": "supply", "damage": 0})


def build_cover(state):
    defs = [1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 4]
    tokens = [
        {"id": uid("cv"), "defense": defense, "revealed": False, "loc": "supply", "destroyed": False, "trophyOwner": None}
        for defense in defs
    ]
    state["coverSupply"] = shuffle(state, tokens)


def place_starting_cover(state):
    for side in ("uk", "de"):
        token = state["coverSupply"].pop(0)
        zone = "uk1" if side == "uk" else "de1"
        token["loc"] = zone
        state["covers"].append(token)
        who = "Britain" if side == "uk" else "Germany"
        label = "British Zone 1" if zone == "uk1" else "German Zone 1"
        log(state, f"{who} places starting Cover in {label}.")


def build_events(state, catalog):
    regular = []
    starters = {"Reinforce": [], "General's Order": [], "Patrol": [], "Charge": [], "other": []}
    for definition in catalog:
        for _ in range(definition["qty"]):
            card = {"inst": uid("ev"), **definition}
            if definition.get("starter"):
                key = definition["title"] if definition["title"] in starters else "other"
                starters[key].append(card)
            else:
                regular.append(card)
    shuffled_regular = shuffle(state, regular)
    for side in ("uk", "de"):
        hand = [
            starters["Reinforce"].pop() if starters["Reinforce"] else None,
            starters["Reinforce"].pop() if starters["Reinforce"] else None,
            starters["General's Order"].pop() if starters["General's Order"] else None,
            starters["Patrol"].pop() if starters["Patrol"] else None,
            starters["Charge"].pop() if starters["Charge"] else None,
            shuffled_regular.pop() if shuffled_regular else None,
            shuffled_regular.pop() if shuffled_regular else None,
        ]
        state["players"][side]["eventHand"] = [c for c in hand if c]
    state["eventDeck"] = shuffle(state, shuffled_regular)
    display = []
    for _ in range(3):
        if state["eventDeck"]:
            display.append(state["eventDeck"].pop())
    state["eventDisplay"] = display


def build_missions(state, catalog, spec):
    deck = []
    for definition in catalog:
        for _ in range(definition["qty"]):
            deck.append({"inst": uid("ms"), **definition, "scored": False})
    deck = shuffle(state, deck)
    deck = deck[spec["remove"] :]
    state["missionDeck"] = deck[: spec["missions"]]
    for side in ("uk", "de"):
        hand = []
        if state["missionDeck"]:
            hand.append(state["missionDeck"].pop(0))
        if state["missionDeck"]:
            hand.append(state["missionDeck"].pop(0))
        state["players"][side]["missionHand"] = hand


def begin_initiative(state):
    state["phase"] = "initiative"
    state["actionStep"] = None
    state["active"] = None
    state["player1"] = None
    state["effects"] = empty_effects()
    for side in ("uk", "de"):
        p = state["players"][side]
        p["dice"] = []
        p["kept"] = [True, True, True, True, True]
        p["rollsUsed"] = 1
        p["committed"] = False
        p["wildAs"] = None
        p["generalsOrderUsed"] = False
        p["attackedIds"] = []
        p["movedEquip"] = []
        p["firedEquip"] = []
        p["spent"] = {"boot": 0, "shovel": 0, "bayonet": 0, "whistle": 0}
        p["regroupDraws"] = 0
    state["pending"] = {"type": "roll1"}
