from .core import (
    ACTION_FACES,
    ATTACK_FACES,
    MORTAR_FACES,
    COMBO_RANK,
    SYMBOL_RANK,
    roll_face,
    log,
    label_side,
)


def roll_action_die(state):
    return roll_face(state, ACTION_FACES)


def roll_attack_die(state):
    return roll_face(state, ATTACK_FACES)


def roll_mortar_die(state):
    return roll_face(state, MORTAR_FACES)


def roll_all_action(state, side):
    state["players"][side]["dice"] = [roll_action_die(state) for _ in range(5)]
    state["players"][side]["kept"] = [True, True, True, True, True]


def reroll_kept(state, side, keep):
    p = state["players"][side]
    p["kept"] = list(keep)
    p["dice"] = [face if keep[i] else roll_action_die(state) for i, face in enumerate(p["dice"])]
    p["rollsUsed"] += 1


def natural_faces(dice):
    return [f for f in dice if f != "wild"]


def combo_of(dice):
    nat = natural_faces(dice)
    counts = {}
    for f in nat:
        counts[f] = counts.get(f, 0) + 1
    vals = sorted(counts.values(), reverse=True)
    kinds = sorted(counts.items(), key=lambda kv: (-kv[1], -(SYMBOL_RANK.get(kv[0], 0))))
    combo_type = "none"
    if vals and vals[0] >= 5:
        combo_type = "five"
    elif vals and vals[0] == 4:
        combo_type = "four"
    elif len(vals) >= 2 and vals[0] == 3 and vals[1] == 2:
        combo_type = "fullHouse"
    elif vals and vals[0] == 3:
        combo_type = "three"
    elif len(vals) >= 2 and vals[0] == 2 and vals[1] == 2:
        combo_type = "twoPair"
    elif vals and vals[0] == 2:
        combo_type = "pair"
    symbols = [s for s, _ in kinds]
    return {"type": combo_type, "rank": COMBO_RANK[combo_type], "symbols": symbols, "counts": counts}


def compare_initiative(a_dice, b_dice):
    a = combo_of(a_dice)
    b = combo_of(b_dice)
    if a["rank"] != b["rank"]:
        return a["rank"] - b["rank"]
    n = max(len(a["symbols"]), len(b["symbols"]))
    for i in range(n):
        ar = SYMBOL_RANK.get(a["symbols"][i], 0) if i < len(a["symbols"]) else 0
        br = SYMBOL_RANK.get(b["symbols"][i], 0) if i < len(b["symbols"]) else 0
        if ar != br:
            return ar - br
    a_best = max([SYMBOL_RANK.get(f, 0) for f in natural_faces(a_dice)] or [0])
    b_best = max([SYMBOL_RANK.get(f, 0) for f in natural_faces(b_dice)] or [0])
    return a_best - b_best


def initiative_winner(state):
    cmp = compare_initiative(state["players"]["uk"]["dice"], state["players"]["de"]["dice"])
    if cmp > 0:
        return "uk"
    if cmp < 0:
        return "de"
    return None


def combo_label(dice):
    names = {
        "five": "Five of a Kind",
        "four": "Four of a Kind",
        "fullHouse": "Full House",
        "three": "Three of a Kind",
        "twoPair": "Two Pairs",
        "pair": "One Pair",
        "none": "No combination",
    }
    return names[combo_of(dice)["type"]]


def spendable(state, side):
    p = state["players"][side]
    empty = {"boot": 0, "shovel": 0, "bayonet": 0, "whistle": 0, "wild": 0}
    if not p["committed"]:
        return dict(empty)
    counts = dict(empty)
    for f in p["dice"]:
        if f == "wild":
            if p["wildAs"]:
                counts[p["wildAs"]] += 1
        elif f:
            counts[f] = counts.get(f, 0) + 1
    stolen = state["effects"].get("stolenDie")
    if stolen and stolen.get("owner") == side:
        f = stolen["face"]
        if f == "wild" and p["wildAs"]:
            counts[p["wildAs"]] += 1
        elif f and f != "wild":
            counts[f] = counts.get(f, 0) + 1
    return counts


def spend(state, side, face, n=1):
    p = state["players"][side]
    if not p.get("spent"):
        p["spent"] = {"boot": 0, "shovel": 0, "bayonet": 0, "whistle": 0}
    p["spent"][face] = p["spent"].get(face, 0) + n


def remaining(state, side, face):
    have = spendable(state, side).get(face, 0)
    used = (state["players"][side].get("spent") or {}).get(face, 0)
    return have - used


def assign_wilds(state, side, symbol):
    p = state["players"][side]
    if symbol not in natural_faces(p["dice"]):
        return False
    p["wildAs"] = symbol
    return True


def auto_assign_wilds(state, side):
    p = state["players"][side]
    nat = natural_faces(p["dice"])
    if not nat:
        p["wildAs"] = None
        return
    counts = {}
    for f in nat:
        counts[f] = counts.get(f, 0) + 1
    best = sorted(counts.items(), key=lambda kv: (-kv[1], -(SYMBOL_RANK.get(kv[0], 0))))[0][0]
    p["wildAs"] = best


def has_shock(state, side):
    p = state["players"][side]
    if not p["committed"]:
        return False
    faces = [p["wildAs"] if f == "wild" else f for f in p["dice"]]
    if any(not f for f in faces):
        return False
    first = faces[0]
    if not all(f == first for f in faces):
        return False
    return first in p["dice"]


def commit_dice(state, side, wild_as=None):
    p = state["players"][side]
    if wild_as:
        assign_wilds(state, side, wild_as)
    else:
        auto_assign_wilds(state, side)
    p["committed"] = True
    p["spent"] = {"boot": 0, "shovel": 0, "bayonet": 0, "whistle": 0}
    log(state, f"{label_side(side)} commits {describe_pool(p)}.")


def describe_pool(p):
    faces = []
    for f in p["dice"]:
        if f == "wild" and p["wildAs"]:
            faces.append(f"Wild→{cap(p['wildAs'])}")
        else:
            faces.append(cap(f))
    return ", ".join(faces)


def cap(s):
    return s[:1].upper() + s[1:] if s else s


def roll_hits(state, n):
    faces = []
    hits = 0
    for _ in range(n):
        f = roll_attack_die(state)
        faces.append(f)
        if f == "hit":
            hits += 1
    return {"faces": faces, "hits": hits}
