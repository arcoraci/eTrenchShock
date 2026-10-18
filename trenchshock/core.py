import copy

SIDES = ["uk", "de"]

ZONES = ["ukTrench", "uk1", "uk2", "uk3", "obj", "de3", "de2", "de1", "deTrench"]
BATTLEFIELD = ["uk1", "uk2", "uk3", "obj", "de3", "de2", "de1"]
UK_SIDE = ["uk1", "uk2", "uk3"]
DE_SIDE = ["de1", "de2", "de3"]

ACTION_FACES = ["boot", "boot", "whistle", "wild", "shovel", "bayonet"]
ATTACK_FACES = ["hit", "hit", "hit", "miss", "miss", "miss"]
MORTAR_FACES = ["de1", "de2", "de3", "obj", "blank", "blank"]

SYMBOL_RANK = {"bayonet": 4, "whistle": 3, "shovel": 2, "boot": 1}
COMBO_RANK = {
    "five": 6,
    "four": 5,
    "fullHouse": 4,
    "three": 3,
    "twoPair": 2,
    "pair": 1,
    "none": 0,
}

FORMATS = {
    "short": {"rounds": 8, "missions": 10, "remove": 6},
    "standard": {"rounds": 10, "missions": 12, "remove": 4},
    "extended": {"rounds": 12, "missions": 16, "remove": 0},
}

ZONE_LABELS = {
    "ukTrench": "British Trench",
    "uk1": "British Zone 1",
    "uk2": "British Zone 2",
    "uk3": "British Zone 3",
    "obj": "Objective Zone",
    "de3": "German Zone 3",
    "de2": "German Zone 2",
    "de1": "German Zone 1",
    "deTrench": "German Trench",
}

_id = 1


def uid(prefix="id"):
    global _id
    value = f"{prefix}-{_id}"
    _id += 1
    return value


def reset_ids(n=1):
    global _id
    _id = n


def rng(state):
    state["seed"] = (int(state["seed"]) * 1664525 + 1013904223) & 0xFFFFFFFF
    return state["seed"] / 0xFFFFFFFF


def shuffle(state, lst):
    arr = list(lst)
    for i in range(len(arr) - 1, 0, -1):
        j = int(rng(state) * (i + 1))
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def roll_face(state, faces):
    return faces[int(rng(state) * len(faces)) % len(faces)]


def other(side):
    return "de" if side == "uk" else "uk"


def side_zones(side):
    return UK_SIDE if side == "uk" else DE_SIDE


def enemy_side_zones(side):
    return DE_SIDE if side == "uk" else UK_SIDE


def own_zone1(side):
    return "uk1" if side == "uk" else "de1"


def own_trench(side):
    return "ukTrench" if side == "uk" else "deTrench"


def enemy_trench(side):
    return "deTrench" if side == "uk" else "ukTrench"


def forward_path(side):
    if side == "uk":
        return ["ukTrench", "uk1", "uk2", "uk3", "obj", "de3", "de2", "de1", "deTrench"]
    return ["deTrench", "de1", "de2", "de3", "obj", "uk3", "uk2", "uk1", "ukTrench"]


def step_zone(side, zone, direction):
    path = forward_path(side)
    try:
        i = path.index(zone)
    except ValueError:
        return None
    j = i + 1 if direction == "forward" else i - 1
    if j < 0 or j >= len(path):
        return None
    return path[j]


def zone_distance(a, b):
    try:
        return abs(BATTLEFIELD.index(a) - BATTLEFIELD.index(b))
    except ValueError:
        return 99


def is_battlefield(zone):
    return zone in BATTLEFIELD


def clone(state):
    return copy.deepcopy(state)


def log(state, text):
    state["log"].insert(0, {"round": state["round"], "text": text})
    if len(state["log"]) > 80:
        del state["log"][80:]


def soldiers_in(state, zone, side=None, exposed=None, cover_id=None, match_cover=False):
    out = []
    for s in state["soldiers"]:
        if s["loc"] != zone:
            continue
        if side and s["owner"] != side:
            continue
        if exposed is True and s["coverId"]:
            continue
        if exposed is False and not s["coverId"]:
            continue
        if match_cover and s["coverId"] != cover_id:
            continue
        out.append(s)
    return out


def units_in(state, zone, side=None, typ=None):
    out = []
    for u in state["equipment"]:
        if u["loc"] != zone:
            continue
        if side and u["owner"] != side:
            continue
        if typ and u["type"] != typ:
            continue
        out.append(u)
    return out


def covers_in(state, zone):
    return [c for c in state["covers"] if c["loc"] == zone and not c["destroyed"]]


def control_value(state, zone, side):
    if not is_battlefield(zone):
        return 0
    n = 0
    for s in soldiers_in(state, zone, side):
        n += 2 if s["coverId"] else 1
    for u in units_in(state, zone, side):
        if u["type"] == "tank":
            continue
        if u["damage"] >= 1:
            continue
        n += 2
    return n


def is_contested(state, zone):
    return any(u["type"] == "tank" for u in units_in(state, zone))


def controller_of(state, zone):
    if not is_battlefield(zone) or is_contested(state, zone):
        return None
    uk = control_value(state, zone, "uk")
    de = control_value(state, zone, "de")
    if uk > de:
        return "uk"
    if de > uk:
        return "de"
    return None


def label_side(side):
    return "Britain" if side == "uk" else "Germany"


def refresh_control(state, opts=None):
    opts = opts or {}
    before = {z: controller_of(state, z) for z in BATTLEFIELD}
    contested = {z: is_contested(state, z) for z in BATTLEFIELD}
    for zone in BATTLEFIELD:
        now = None if contested[zone] else before[zone]
        prev_stored = state["control"][zone]
        if now and now != prev_stored:
            gained_only_because_tank_left = opts.get("tankLeft") and state["hadTank"].get(zone)
            if not gained_only_because_tank_left:
                last = state["territoryOwner"][zone]
                if last != now:
                    if zone == "obj":
                        state["vp"][now] += 3
                        log(state, f"{label_side(now)} gains the Objective Zone (+3 VP).")
                    elif zone in enemy_side_zones(now):
                        state["vp"][now] += 1
                        log(state, f"{label_side(now)} takes {ZONE_LABELS[zone]} (+1 VP).")
                    state["territoryOwner"][zone] = now
        state["control"][zone] = now
        state["hadTank"][zone] = contested[zone]


def count_exposed(state, zone, side):
    return len(soldiers_in(state, zone, side, exposed=True))


def player(state, side):
    return state["players"][side]
