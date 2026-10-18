from .core import (
    log,
    label_side,
    other,
    own_trench,
    soldiers_in,
    covers_in,
    controller_of,
    is_battlefield,
    step_zone,
    zone_distance,
    enemy_trench,
    ZONE_LABELS,
    refresh_control,
)
from .dice import roll_hits
from .combat import apply_hits, eliminate_soldier
from .missions import draw_mission


def event_needs(title):
    return {
        "Reinforce": [],
        "Patrol": ["zone", "soldiers"],
        "Charge": ["zone", "soldiers"],
        "Bayonet Charge": ["zone", "soldiers"],
        "Bogged Down": [],
        "Bombing Run": ["zone"],
        "Carrier Pigeon": [],
        "Cavalry Charge": [],
        "Christmas Truce": [],
        "Entrench": ["soldiers", "covers"],
        "Espionage": [],
        "Field Hospital": [],
        "Field Repairs": ["friendlyEquip"],
        "Heavy Barrage": ["enemyZone"],
        "Mobility": ["friendlyMortar"],
        "Precision Barrage": ["friendlyMortar"],
        "Raid": ["zone", "soldiers"],
        "Recon Flight": ["zone"],
        "Sabotage": ["enemyDie"],
        "Scout": ["enemyCover"],
        "Smoke Screen": ["zone"],
        "Sniper": ["enemySoldier"],
        "Spotter": ["friendlyMortar"],
        "Suppression": ["supportType"],
        "Trench Fever": ["zone"],
        "Trench Foot": [],
        "Armored Advance": ["friendlyTank"],
        "Tunnel": ["soldiers", "controlledZone"],
    }.get(title, [])


def play_event(state, side, card, params):
    fn = TABLE.get(card["title"])
    if not fn:
        log(state, f"{card['title']} is not implemented yet.")
        return
    log(state, f"{label_side(side)} plays {card['title']}.")
    fn(state, side, params or {}, card)


def _reinforce(state, side, params, card):
    avail = [s for s in state["soldiers"] if s["owner"] == side and s["loc"] == "available"]
    trench = own_trench(side)
    room = 5 - sum(1 for s in state["soldiers"] if s["owner"] == side and s["loc"] == trench)
    n = 0
    for s in avail:
        if room <= 0 or n >= 3:
            break
        s["loc"] = trench
        room -= 1
        n += 1
    log(state, f"{n} Soldier(s) enter the Trench reinforcement area.")


def _patrol(state, side, params, card):
    move_group(state, side, params, 2, True)


def _charge(state, side, params, card):
    move_group(state, side, params, 3, False)


def _bayonet_charge(state, side, params, card):
    ids = (params.get("soldierIds") or [])[:3]
    soldiers = [next((s for s in state["soldiers"] if s["id"] == sid and s["owner"] == side), None) for sid in ids]
    soldiers = [s for s in soldiers if s]
    if not soldiers:
        return
    origin = soldiers[0]["loc"]
    if controller_of(state, origin) != side:
        raise ValueError("Must start in a friendly-controlled zone.")
    dest = step_zone(side, origin, "forward")
    if not dest or controller_of(state, dest) != other(side):
        raise ValueError("Must charge into an adjacent enemy-controlled zone.")
    for s in soldiers:
        s["coverId"] = None
        s["loc"] = dest
    dice = len(soldiers)
    result = roll_hits(state, dice)
    misses = result["faces"].count("miss")
    reroll = roll_hits(state, misses)
    total = result["hits"] + reroll["hits"]
    log(state, f"Bayonet Charge: {dice} dice, reroll misses → {total} Hit(s).")
    apply_hits(state, side, {"kind": "exposed", "zone": dest}, total)
    for s in soldiers:
        state["players"][side]["attackedIds"].append(s["id"])


def _bogged_down(state, side, params, card):
    state["effects"]["boggedDown"] = True
    state["effects"]["boggedDownBy"] = side


def _bombing_run(state, side, params, card):
    zone = params.get("zone")
    foe = other(side)
    targets = soldiers_in(state, zone, foe)
    result = roll_hits(state, len(targets))
    apply_hits(state, side, {"kind": "exposed", "zone": zone}, result["hits"])


def _carrier_pigeon(state, side, params, card):
    m = draw_mission(state, True)
    if m:
        state["players"][side]["missionHand"].append(m)
    while len(state["players"][side]["missionHand"]) > 5:
        state["missionDeck"].append(state["players"][side]["missionHand"].pop())


def _cavalry_charge(state, side, params, card):
    state["effects"]["cavalryCharge"] = side


def _christmas_truce(state, side, params, card):
    state["effects"]["christmasTruce"] = True


def _entrench(state, side, params, card):
    trench = own_trench(side)
    ids = (params.get("soldierIds") or [])[:3]
    for sid in ids:
        s = next((x for x in state["soldiers"] if x["id"] == sid and x["owner"] == side and x["loc"] == trench), None)
        cover = next((c for c in state["covers"] if c["id"] == params.get("coverId") and not c["destroyed"]), None)
        if not s or not cover:
            continue
        if controller_of(state, cover["loc"]) != side:
            continue
        occ = soldiers_in(state, cover["loc"], match_cover=True, cover_id=cover["id"])
        if len(occ) >= 3 or any(o["owner"] != side for o in occ):
            continue
        s["loc"] = cover["loc"]
        s["coverId"] = cover["id"]
    refresh_control(state)


def _espionage(state, side, params, card):
    foe = state["players"][other(side)]["eventHand"]
    if not foe:
        log(state, "Opponent has no Events.")
        return
    state["seed"] = (int(state["seed"]) * 1664525 + 1013904223) & 0xFFFFFFFF
    i = int((state["seed"] / 0xFFFFFFFF) * len(foe)) % len(foe)
    card_taken = foe.pop(i)
    if len(state["players"][side]["eventHand"]) < 7:
        state["players"][side]["eventHand"].append(card_taken)
    else:
        state["eventDiscard"].append(card_taken)
    log(state, f"{label_side(side)} steals {card_taken['title']}.")


def _field_hospital(state, side, params, card):
    trench = own_trench(side)
    room = 5 - sum(1 for s in state["soldiers"] if s["owner"] == side and s["loc"] == trench)
    cas = [s for s in state["soldiers"] if s["owner"] == side and s["loc"] == "casualties" and not s.get("overflow")]
    n = 0
    for s in cas:
        if n >= 3 or room <= 0:
            break
        s["loc"] = trench
        room -= 1
        n += 1
    log(state, f"Field Hospital returns {n} Soldier(s).")


def _field_repairs(state, side, params, card):
    u = next((e for e in state["equipment"] if e["id"] == params.get("unitId") and e["owner"] == side), None)
    if not u or u["damage"] < 1:
        return
    n = min(2, u["damage"]) if u["type"] == "tank" else 1
    u["damage"] -= n
    log(state, f"Field Repairs removes {n} Damage from the {u['type']}.")


def _heavy_barrage(state, side, params, card):
    zone = params.get("zone")
    if controller_of(state, zone) != other(side):
        raise ValueError("Must target an enemy-controlled zone.")
    apply_hits(
        state,
        side,
        {
            "kind": params.get("targetKind") or "exposed",
            "zone": zone,
            "coverId": params.get("coverId"),
            "unitId": params.get("unitId"),
        },
        3,
    )


def _mobility(state, side, params, card):
    u = next(
        (
            e
            for e in state["equipment"]
            if e["id"] == params.get("unitId") and e["type"] == "mortar" and e["owner"] == side and e["damage"] < 1
        ),
        None,
    )
    if u:
        state["effects"]["mobility"].append(u["id"])


def _precision_barrage(state, side, params, card):
    u = next(
        (
            e
            for e in state["equipment"]
            if e["id"] == params.get("unitId") and e["type"] == "mortar" and e["owner"] == side and e["damage"] < 1
        ),
        None,
    )
    if u:
        state["effects"]["precision"].append(u["id"])


def _raid(state, side, params, card):
    ids = (params.get("soldierIds") or [])[:2]
    soldiers = [next((s for s in state["soldiers"] if s["id"] == sid and s["owner"] == side), None) for sid in ids]
    soldiers = [s for s in soldiers if s]
    if not soldiers:
        return
    dest = step_zone(side, soldiers[0]["loc"], "forward")
    if not dest or not is_battlefield(dest):
        return
    for s in soldiers:
        s["loc"] = dest
        s["coverId"] = None
    cover = None
    for c in covers_in(state, dest):
        occ = soldiers_in(state, dest, match_cover=True, cover_id=c["id"])
        if len(occ) < 3 and not any(o["owner"] != side for o in occ):
            cover = c
            break
    if cover:
        for s in soldiers:
            occ = soldiers_in(state, dest, match_cover=True, cover_id=cover["id"])
            if len(occ) < 3:
                s["coverId"] = cover["id"]


def _recon_flight(state, side, params, card):
    for c in covers_in(state, params.get("zone")):
        c["revealed"] = True


def _sabotage(state, side, params, card):
    foe = other(side)
    i = params.get("dieIndex", 0)
    dice = state["players"][foe]["dice"]
    if i is None or i < 0 or i >= len(dice):
        return
    face = dice[i]
    if face is None:
        return
    dice[i] = None
    state["effects"]["stolenDie"] = {"owner": side, "face": face, "from": foe}
    log(state, f"{label_side(side)} steals a {face} die.")


def _scout(state, side, params, card):
    cover = next((c for c in state["covers"] if c["id"] == params.get("coverId") and not c["destroyed"]), None)
    if not cover:
        return
    near = any(
        s["owner"] == side and is_battlefield(s["loc"]) and zone_distance(s["loc"], cover["loc"]) <= 1
        for s in state["soldiers"]
    )
    if not near:
        raise ValueError("Need a Soldier in or adjacent to that zone.")
    cover["revealed"] = True
    occ = soldiers_in(state, cover["loc"], other(side), match_cover=True, cover_id=cover["id"])
    if occ:
        occ[0]["coverId"] = None


def _smoke_screen(state, side, params, card):
    state["effects"]["smoke"].append(params.get("zone"))


def _sniper(state, side, params, card):
    s = next(
        (
            x
            for x in state["soldiers"]
            if x["id"] == params.get("soldierId") and x["owner"] == other(side) and is_battlefield(x["loc"])
        ),
        None,
    )
    if not s:
        return
    result = roll_hits(state, 2)
    if result["hits"] >= 1:
        eliminate_soldier(state, s)
        state["roundElim"][side] = (state["roundElim"].get(side) or 0) + 1
    else:
        log(state, "Sniper misses.")


def _spotter(state, side, params, card):
    u = next(
        (
            e
            for e in state["equipment"]
            if e["id"] == params.get("unitId") and e["type"] == "mortar" and e["owner"] == side and e["damage"] < 1
        ),
        None,
    )
    if u:
        state["effects"]["spotter"].append(u["id"])


def _suppression(state, side, params, card):
    state["effects"]["suppression"] = "mortar" if params.get("supportType") == "mortar" else "mg"
    state["effects"]["suppressionBy"] = side


def _trench_fever(state, side, params, card):
    lst = soldiers_in(state, params.get("zone"), other(side), exposed=True)[:2]
    for s in lst:
        eliminate_soldier(state, s)
        state["roundElim"][side] = (state["roundElim"].get(side) or 0) + 1


def _trench_foot(state, side, params, card):
    state["effects"]["trenchFoot"] = True
    state["effects"]["trenchFootBy"] = side


def _armored_advance(state, side, params, card):
    tank = next(
        (
            e
            for e in state["equipment"]
            if e["id"] == params.get("unitId")
            and e["type"] == "tank"
            and e["owner"] == side
            and is_battlefield(e["loc"])
        ),
        None,
    )
    if not tank:
        return
    dest = step_zone(side, tank["loc"], "forward")
    if not dest:
        return
    if dest == enemy_trench(side):
        state["vp"][side] += 1
        tank["loc"] = "supply"
        tank["damage"] = 0
        log(state, "Armored Advance — Tank enters the enemy Trench (+1 VP).")
        refresh_control(state, {"tankLeft": True})
        return
    tank["loc"] = dest
    log(state, f"Tank advances to {ZONE_LABELS[dest]}.")


def _tunnel(state, side, params, card):
    trench = own_trench(side)
    dest = params.get("zone")
    if controller_of(state, dest) != side:
        raise ValueError("Tunnel into a zone you control.")
    ids = (params.get("soldierIds") or [])[:2]
    for sid in ids:
        s = next((x for x in state["soldiers"] if x["id"] == sid and x["owner"] == side and x["loc"] == trench), None)
        if not s:
            continue
        s["loc"] = dest
        s["coverId"] = None
        state["players"][side]["attackedIds"].append(s["id"])


TABLE = {
    "Reinforce": _reinforce,
    "Patrol": _patrol,
    "Charge": _charge,
    "Bayonet Charge": _bayonet_charge,
    "Bogged Down": _bogged_down,
    "Bombing Run": _bombing_run,
    "Carrier Pigeon": _carrier_pigeon,
    "Cavalry Charge": _cavalry_charge,
    "Christmas Truce": _christmas_truce,
    "Entrench": _entrench,
    "Espionage": _espionage,
    "Field Hospital": _field_hospital,
    "Field Repairs": _field_repairs,
    "Heavy Barrage": _heavy_barrage,
    "Mobility": _mobility,
    "Precision Barrage": _precision_barrage,
    "Raid": _raid,
    "Recon Flight": _recon_flight,
    "Sabotage": _sabotage,
    "Scout": _scout,
    "Smoke Screen": _smoke_screen,
    "Sniper": _sniper,
    "Spotter": _spotter,
    "Suppression": _suppression,
    "Trench Fever": _trench_fever,
    "Trench Foot": _trench_foot,
    "Armored Advance": _armored_advance,
    "Tunnel": _tunnel,
}


def move_group(state, side, params, maximum, allow_back):
    ids = (params.get("soldierIds") or [])[:maximum]
    direction = params.get("dir") or "forward"
    if not allow_back and direction != "forward":
        raise ValueError("Charge is forward only.")
    soldiers = [next((s for s in state["soldiers"] if s["id"] == sid and s["owner"] == side), None) for sid in ids]
    soldiers = [s for s in soldiers if s]
    if not soldiers:
        return
    origin = soldiers[0]["loc"]
    if not is_battlefield(origin):
        raise ValueError("Cannot move from the Trench with this Event.")
    dest = step_zone(side, origin, direction)
    if not dest or not is_battlefield(dest):
        raise ValueError("Illegal destination.")
    for s in soldiers:
        if s["loc"] != origin:
            continue
        s["coverId"] = None
        s["loc"] = dest
    log(state, f"{len(soldiers)} Soldier(s) move to {ZONE_LABELS[dest]}.")
