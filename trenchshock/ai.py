from .core import (
    soldiers_in,
    covers_in,
    controller_of,
    is_battlefield,
    step_zone,
    enemy_side_zones,
    own_zone1,
    side_zones,
    other,
    BATTLEFIELD,
)
from .dice import remaining, has_shock, natural_faces
from .events import event_needs


def choose_ai_action(state):
    pending = state.get("pending") or {}
    if state["phase"] == "initiative" and pending.get("type") == "roll1":
        return {"type": "ROLL_1"}
    if pending.get("type") == "generals-order" and pending.get("side") == state["ai"]:
        return {"type": "SKIP_GENERALS_ORDER"}
    if state["phase"] == "reroll" and state["active"] == state["ai"]:
        return ai_reroll(state)
    if state["phase"] == "action" and state["active"] == state["ai"]:
        return ai_action(state)
    if state["phase"] == "regroup":
        return ai_regroup(state)
    return None


def ai_reroll(state):
    p = state["players"][state["ai"]]
    if not p["committed"] and p["rollsUsed"] < 3:
        keep = [f in ("boot", "wild", "whistle", "bayonet") for f in p["dice"]]
        p["kept"] = keep
        if p["rollsUsed"] == 1 and any(not k for k in keep):
            return {"type": "REROLL", "side": state["ai"]}
        if p["rollsUsed"] == 2 and p["dice"].count("shovel") and p["dice"].count("boot") < 2:
            p["kept"] = [f != "shovel" for f in p["dice"]]
            return {"type": "REROLL"}
    nat = natural_faces(p["dice"])
    prefer = next((s for s in ("boot", "whistle", "bayonet", "shovel") if s in nat), None)
    return {"type": "COMMIT", "wildAs": prefer}


def ai_action(state):
    side = state["ai"]
    step = state["actionStep"]
    if step == "shock":
        if has_shock(state, side):
            exposed = sum(len(soldiers_in(state, z, other(side), exposed=True)) for z in enemy_side_zones(side))
            return {"type": "SHOCK", "option": "gas" if exposed >= 4 else "gambit"}
        return {"type": "SKIP_SHOCK"}
    if step == "tank":
        tank = next(
            (u for u in state["equipment"] if u["owner"] == side and u["type"] == "tank" and is_battlefield(u["loc"])),
            None,
        )
        if tank and not state["effects"].get("boggedDown"):
            return {"type": "MOVE_TANK", "unitId": tank["id"], "steps": 2}
        return {"type": "SKIP_TANK"}
    if step == "event":
        play = pick_event(state, side)
        return play or {"type": "SKIP_EVENT"}
    if step == "deploy":
        if remaining(state, side, "bayonet") >= 4:
            tank = next((u for u in state["equipment"] if u["owner"] == side and u["type"] == "tank" and u["loc"] == "supply"), None)
            if tank:
                return {"type": "DEPLOY", "kind": "tank"}
        if remaining(state, side, "bayonet") >= 3 and controller_of(state, side_zones(side)[0]) == side:
            mg = next((u for u in state["equipment"] if u["owner"] == side and u["type"] == "mg" and u["loc"] == "supply"), None)
            if mg:
                return {"type": "DEPLOY", "kind": "mg", "zone": own_zone1(side)}
        damaged = next(
            (u for u in state["equipment"] if u["owner"] == side and is_battlefield(u["loc"]) and u["damage"] >= 1),
            None,
        )
        if damaged and remaining(state, side, "bayonet") >= 1:
            return {"type": "REPAIR", "unitId": damaged["id"]}
        return {"type": "SKIP_DEPLOY"}
    if step == "move":
        if remaining(state, side, "boot") >= 1 and not state["effects"].get("trenchFoot"):
            dest_priority = ["obj", *enemy_side_zones(side), *side_zones(side)]
            soldiers = [s for s in state["soldiers"] if s["owner"] == side and is_battlefield(s["loc"]) and not s["coverId"]]
            soldiers.sort(key=lambda s: dest_priority.index(s["loc"]) if s["loc"] in dest_priority else 99)
            for s in soldiers:
                dest = step_zone(side, s["loc"], "forward")
                if dest and is_battlefield(dest):
                    return {"type": "MOVE_UNIT", "kind": "soldier", "unitId": s["id"], "dir": "forward"}
        return {"type": "SKIP_MOVE"}
    if step == "cover":
        if remaining(state, side, "shovel") >= 1:
            obj_cover = (covers_in(state, "obj") or [None])[0]
            exposed = (soldiers_in(state, "obj", side, exposed=True) or [None])[0]
            if obj_cover and exposed:
                return {"type": "SHOVEL", "mode": "dig", "soldierId": exposed["id"], "coverId": obj_cover["id"]}
            for z in [*side_zones(side), "obj"]:
                s = (soldiers_in(state, z, side, exposed=True) or [None])[0]
                c = (covers_in(state, z) or [None])[0]
                if s and c:
                    return {"type": "SHOVEL", "mode": "dig", "soldierId": s["id"], "coverId": c["id"]}
        return {"type": "SKIP_COVER"}
    if step == "attack":
        if state["effects"].get("christmasTruce"):
            return {"type": "SKIP_ATTACK"}
        attack = pick_attack(state, side)
        return attack or {"type": "SKIP_ATTACK"}
    return {"type": "SKIP_ATTACK"}


def pick_event(state, side):
    if remaining(state, side, "whistle") < 1:
        return None
    hand = [c for c in state["players"][side]["eventHand"] if c["title"] != "General's Order"]
    order = ["Charge", "Patrol", "Trench Fever", "Sniper", "Reinforce", "Christmas Truce", "Trench Foot", "Bogged Down"]
    for title in order:
        card = next((c for c in hand if c["title"] == title), None)
        if not card:
            continue
        params = fill_params(state, side, card)
        if params is None:
            continue
        return {"type": "PLAY_EVENT", "cardInst": card["inst"], "params": params}
    return None


def fill_params(state, side, card):
    needs = event_needs(card["title"])
    params = {}
    if "zone" in needs or "controlledZone" in needs:
        z = next((zone for zone in BATTLEFIELD if soldiers_in(state, zone, side) and (card["title"] != "Tunnel" or controller_of(state, zone) == side)), None)
        if card["title"] == "Tunnel":
            controlled = next((zone for zone in BATTLEFIELD if controller_of(state, zone) == side), None)
            if not controlled:
                return None
            params["zone"] = controlled
        elif card["title"] == "Trench Fever":
            z2 = next((zone for zone in BATTLEFIELD if soldiers_in(state, zone, other(side), exposed=True)), None)
            if not z2:
                return None
            params["zone"] = z2
        else:
            if not z:
                return None
            params["zone"] = z
    if "soldiers" in needs:
        zone = params.get("zone") or next((z for z in BATTLEFIELD if soldiers_in(state, z, side, exposed=True)), None)
        trench = f"{side}Trench"
        from_trench = [s for s in state["soldiers"] if s["owner"] == side and s["loc"] == trench]
        if card["title"] in ("Tunnel", "Entrench"):
            params["soldierIds"] = [s["id"] for s in from_trench[:2]]
            if not params["soldierIds"]:
                return None
        else:
            if card["title"] == "Reinforce":
                pool = [s for s in state["soldiers"] if s["owner"] == side and s["loc"] == "available"]
            else:
                pool = soldiers_in(state, zone, side)
            params["soldierIds"] = [s["id"] for s in pool[:3]]
            if not params["soldierIds"]:
                return None
        params["dir"] = "forward"
    if card["title"] == "Sniper":
        s = next((x for x in state["soldiers"] if x["owner"] == other(side) and is_battlefield(x["loc"])), None)
        if not s:
            return None
        params["soldierId"] = s["id"]
    if card["title"] == "Christmas Truce" and state["active"] == state["player1"]:
        return None
    return params


def pick_attack(state, side):
    foe = other(side)
    for zone in BATTLEFIELD:
        mine = [s for s in soldiers_in(state, zone, side) if s["id"] not in state["players"][side]["attackedIds"]]
        zi = BATTLEFIELD.index(zone)
        near = [z for z in BATTLEFIELD if abs(BATTLEFIELD.index(z) - zi) <= 1]
        for tz in near:
            exposed = soldiers_in(state, tz, foe, exposed=True)
            if mine and exposed:
                return {
                    "type": "START_ATTACK",
                    "kind": "infantry",
                    "attackerIds": [s["id"] for s in mine[: min(len(mine), 6)]],
                    "target": {"kind": "exposed", "zone": tz},
                }
    tank = next(
        (
            u
            for u in state["equipment"]
            if u["owner"] == side
            and u["type"] == "tank"
            and is_battlefield(u["loc"])
            and u["id"] not in state["players"][side]["attackedIds"]
        ),
        None,
    )
    if tank:
        covers = covers_in(state, tank["loc"])
        if covers:
            return {"type": "OVERRUN", "unitId": tank["id"], "coverId": covers[0]["id"]}
    mg = next(
        (
            u
            for u in state["equipment"]
            if u["owner"] == side
            and u["type"] == "mg"
            and is_battlefield(u["loc"])
            and u["damage"] < 1
            and u["id"] not in state["players"][side]["movedEquip"]
        ),
        None,
    )
    if mg:
        mi = BATTLEFIELD.index(mg["loc"])
        tz = next(
            (
                z
                for z in BATTLEFIELD
                if abs(BATTLEFIELD.index(z) - mi) <= 2 and soldiers_in(state, z, foe, exposed=True)
            ),
            None,
        )
        if tz:
            return {
                "type": "START_ATTACK",
                "kind": "infantry",
                "attackerIds": [mg["id"]],
                "target": {"kind": "exposed", "zone": tz},
            }
    return None


def ai_regroup(state):
    p = state["players"][state["ai"]]
    natural = p["dice"].count("whistle") - (p.get("spent") or {}).get("whistle", 0)
    used = p.get("regroupDraws") or 0
    if used < natural and len(p["eventHand"]) < 7:
        face = state["eventDisplay"][0] if state["eventDisplay"] else None
        return {"type": "REGROUP_DRAW", "side": state["ai"], "source": face["inst"] if face else "deck"}
    return {"type": "SKIP_REGROUP"}
