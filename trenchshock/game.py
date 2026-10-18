from .core import (
    clone,
    log,
    label_side,
    other,
    own_zone1,
    enemy_trench,
    enemy_side_zones,
    side_zones,
    step_zone,
    zone_distance,
    is_battlefield,
    refresh_control,
    soldiers_in,
    units_in,
    covers_in,
    controller_of,
    ZONE_LABELS,
)
from .setup import begin_initiative
from .dice import (
    roll_all_action,
    reroll_kept,
    initiative_winner,
    combo_label,
    commit_dice,
    remaining,
    spend,
    has_shock,
    roll_hits,
    roll_mortar_die,
)
from .events import play_event
from .missions import check_missions, draw_mission
from .combat import apply_hits, retreat_soldier, take_cover_trophy

STEPS = ["shock", "tank", "event", "deploy", "move", "cover", "attack"]


def apply(state, action):
    nxt = clone(state)
    try:
        handle(nxt, action)
    except Exception as err:
        log(nxt, f"Action failed: {err}")
        nxt["error"] = str(err)
    return nxt


def handle(state, action):
    state["error"] = None
    kind = action.get("type")
    handlers = {
        "ROLL_1": lambda: do_roll1(state),
        "GENERALS_ORDER": lambda: do_generals_order(state, action),
        "SKIP_GENERALS_ORDER": lambda: after_roll1(state),
        "TOGGLE_KEEP": lambda: toggle_keep(state, action),
        "REROLL": lambda: do_reroll(state),
        "COMMIT": lambda: do_commit(state, action),
        "SHOCK": lambda: do_shock(state, action),
        "SKIP_SHOCK": lambda: advance_step(state),
        "MOVE_TANK": lambda: move_tank(state, action),
        "SKIP_TANK": lambda: advance_step(state),
        "PLAY_EVENT": lambda: do_play_event(state, action),
        "SKIP_EVENT": lambda: advance_step(state),
        "DEPLOY": lambda: do_deploy(state, action),
        "REPAIR": lambda: do_repair(state, action),
        "SKIP_DEPLOY": lambda: advance_step(state),
        "MOVE_UNIT": lambda: do_move(state, action),
        "LEAVE_COVER_THEN_MOVE": lambda: leave_then_move(state, action),
        "SKIP_MOVE": lambda: advance_step(state),
        "SHOVEL": lambda: do_shovel(state, action),
        "SKIP_COVER": lambda: advance_step(state),
        "START_ATTACK": lambda: start_attack(state, action),
        "RESOLVE_ATTACK": lambda: resolve_attack(state, action),
        "OVERRUN": lambda: do_overrun(state, action),
        "SKIP_ATTACK": lambda: finish_action_phase(state),
        "REGROUP_DRAW": lambda: regroup_draw(state, action),
        "SKIP_REGROUP": lambda: end_round(state),
    }
    if kind not in handlers:
        raise ValueError(f"Unknown action {kind}")
    handlers[kind]()


def do_roll1(state):
    roll_all_action(state, "uk")
    roll_all_action(state, "de")
    log(
        state,
        f"Initiative roll — Britain: {combo_label(state['players']['uk']['dice'])}. "
        f"Germany: {combo_label(state['players']['de']['dice'])}.",
    )
    human = state["human"]
    has_go = any(c["title"] == "General's Order" for c in state["players"][human]["eventHand"])
    if has_go and not state["players"][human]["generalsOrderUsed"]:
        state["pending"] = {"type": "generals-order", "side": human}
        return
    auto_generals_for_ai(state)
    after_roll1(state)


def auto_generals_for_ai(state):
    side = state["ai"]
    p = state["players"][side]
    card = next((c for c in p["eventHand"] if c["title"] == "General's Order"), None)
    if not card or p["generalsOrderUsed"]:
        return
    wilds = p["dice"].count("wild")
    boots = p["dice"].count("boot")
    if boots + wilds < 2:
        i = next((idx for idx, f in enumerate(p["dice"]) if f not in ("boot", "wild")), -1)
        if i >= 0:
            p["dice"][i] = "boot"
        discard_event(state, side, card["inst"])
        p["generalsOrderUsed"] = True
        log(state, f"{label_side(side)} plays General's Order and changes a die to Boot.")


def do_generals_order(state, action):
    side = action.get("side") or state["human"]
    p = state["players"][side]
    card = next((c for c in p["eventHand"] if c["title"] == "General's Order"), None)
    if not card:
        raise ValueError("No General's Order in hand.")
    if action.get("mode") == "reroll":
        for i in action.get("indexes") or []:
            if 0 <= i < 5:
                p["dice"][i] = roll_face_safe(state)
    elif action.get("mode") == "change":
        i = action.get("index")
        to = action.get("to")
        if to not in p["dice"] or to == "wild":
            raise ValueError("Must match a natural non-Wild face in Roll 1.")
        p["dice"][i] = to
    discard_event(state, side, card["inst"])
    p["generalsOrderUsed"] = True
    log(state, f"{label_side(side)} plays General's Order.")
    auto_generals_for_ai(state)
    after_roll1(state)


def roll_face_safe(state):
    faces = ["boot", "boot", "whistle", "wild", "shovel", "bayonet"]
    state["seed"] = (int(state["seed"]) * 1664525 + 1013904223) & 0xFFFFFFFF
    return faces[state["seed"] % 6]


def after_roll1(state):
    winner = initiative_winner(state)
    guard = 0
    while not winner and guard < 12:
        guard += 1
        log(state, "Initiative tied — both sides reroll all five dice.")
        roll_all_action(state, "uk")
        roll_all_action(state, "de")
        winner = initiative_winner(state)
    if not winner:
        winner = state["human"]
    state["player1"] = winner
    log(state, f"{label_side(winner)} wins Initiative and will act first.")
    state["phase"] = "reroll"
    state["active"] = other(winner)
    state["players"]["uk"]["rollsUsed"] = 1
    state["players"]["de"]["rollsUsed"] = 1
    state["pending"] = {"type": "reroll", "side": state["active"]}


def toggle_keep(state, action):
    side = state["active"]
    if state["phase"] != "reroll" or side != action.get("side"):
        return
    p = state["players"][side]
    i = action["index"]
    p["kept"][i] = not p["kept"][i]


def do_reroll(state):
    side = state["active"]
    p = state["players"][side]
    if p["rollsUsed"] >= 3:
        raise ValueError("No rerolls remaining.")
    reroll_kept(state, side, p["kept"])
    log(state, f"{label_side(side)} rerolls (Roll {p['rollsUsed']}).")


def do_commit(state, action):
    side = state["active"]
    commit_dice(state, side, action.get("wildAs"))
    if side == other(state["player1"]):
        state["active"] = state["player1"]
        state["pending"] = {"type": "reroll", "side": state["player1"]}
    else:
        start_action_phase(state, state["player1"])


def start_action_phase(state, side):
    state["phase"] = "action"
    state["active"] = side
    state["actionStep"] = "shock"
    state["pending"] = {"type": "action", "step": "shock"}
    log(state, f"{label_side(side)} begins the Action Phase.")
    if has_shock(state, side):
        return
    advance_step(state)


def advance_step(state):
    i = STEPS.index(state["actionStep"]) if state["actionStep"] in STEPS else -1
    nxt = STEPS[i + 1] if 0 <= i + 1 < len(STEPS) else None
    if not nxt:
        return finish_action_phase(state)
    state["actionStep"] = nxt
    state["pending"] = {"type": "action", "step": nxt}


def do_shock(state, action):
    if state["actionStep"] != "shock":
        raise ValueError("Not the Shock step.")
    if not has_shock(state, state["active"]):
        raise ValueError("Need five matching Action Dice.")
    p = state["players"][state["active"]]
    p["spent"] = {"boot": 99, "shovel": 99, "bayonet": 99, "whistle": 99}
    if action.get("option") == "gambit":
        mission_gambit(state, state["active"])
    elif action.get("option") == "gas":
        mustard_gas(state, state["active"])
    advance_step(state)


def mission_gambit(state, side):
    log(state, f"{label_side(side)} uses Shock: Mission Gambit.")
    drawn = [m for m in (draw_mission(state, False), draw_mission(state, False)) if m]
    if not drawn:
        return
    keep = drawn[0]
    rest = drawn[1:]
    state["players"][side]["missionHand"].append(keep)
    for m in rest:
        state["missionDeck"].append(m)
    check_missions(state, side, {"timing": "immediate"})
    trim_missions(state, side)


def mustard_gas(state, side):
    log(state, f"{label_side(side)} uses Shock: Mustard Gas.")
    if state["effects"].get("christmasTruce"):
        log(state, "Christmas Truce prevents Mustard Gas.")
        return
    foe = other(side)
    for zone in enemy_side_zones(side):
        result = roll_hits(state, 3)
        exposed = soldiers_in(state, zone, foe, exposed=True)
        n = min(result["hits"], len(exposed))
        for i in range(n):
            retreat_soldier(state, exposed[i], count_mission=False)
        log(state, f"Mustard Gas over {ZONE_LABELS[zone]}: {result['hits']} Hit(s), {n} Retreat.")
    refresh_control(state)


def move_tank(state, action):
    if state["effects"].get("boggedDown"):
        log(state, "Bogged Down — enemy tanks cannot move. Skipping your own check for the mover.")
    tank = next(
        (
            u
            for u in state["equipment"]
            if u["id"] == action.get("unitId") and u["type"] == "tank" and u["owner"] == state["active"]
        ),
        None,
    )
    if not tank or not is_battlefield(tank["loc"]):
        raise ValueError("That Tank is not on the battlefield.")
    if state["effects"].get("boggedDown"):
        played_by = state["effects"].get("boggedDownBy")
        if played_by and tank["owner"] != played_by:
            raise ValueError("Bogged Down: enemy Tanks cannot move.")
    steps = max(0, min(2, action.get("steps") or 0))
    for _ in range(steps):
        nxt = step_zone(tank["owner"], tank["loc"], "forward")
        if not nxt:
            break
        if is_battlefield(nxt) and units_in(state, nxt, other(tank["owner"]), "tank"):
            tank["loc"] = nxt
            log(state, f"{label_side(tank['owner'])} Tank stops in {ZONE_LABELS[nxt]} (enemy Tank).")
            break
        if nxt == enemy_trench(tank["owner"]):
            state["vp"][tank["owner"]] += 1
            log(state, f"{label_side(tank['owner'])} Tank breaks into the enemy Trench (+1 VP).")
            tank["loc"] = "supply"
            tank["damage"] = 0
            refresh_control(state, {"tankLeft": True})
            check_missions(state, tank["owner"], {"timing": "immediate"})
            return advance_step(state)
        left = tank["loc"]
        tank["loc"] = nxt
        state["hadTank"][left] = True
        log(state, f"{label_side(tank['owner'])} Tank advances to {ZONE_LABELS[nxt]}.")
    refresh_control(state)
    check_missions(state, state["active"], {"timing": "immediate"})
    advance_step(state)


def do_play_event(state, action):
    side = state["active"]
    if remaining(state, side, "whistle") < 1 and not action.get("free"):
        raise ValueError("Need a Whistle to play an Event.")
    card = next((c for c in state["players"][side]["eventHand"] if c["inst"] == action.get("cardInst")), None)
    if not card:
        raise ValueError("Card is not in hand.")
    if card["title"] == "General's Order":
        raise ValueError("General's Order is only played after Roll 1.")
    if not action.get("free"):
        spend(state, side, "whistle", 1)
    play_event(state, side, card, action.get("params") or {})
    discard_event(state, side, card["inst"])
    refresh_control(state)
    check_missions(state, side, {"timing": "immediate"})


def do_deploy(state, action):
    side = state["active"]
    kind = action.get("kind")
    zone = action.get("zone")
    if kind == "mortar":
        if remaining(state, side, "bayonet") < 2:
            raise ValueError("Need 2 Bayonets.")
        if zone != own_zone1(side):
            raise ValueError("Mortars deploy into your Zone 1.")
        if controller_of(state, zone) != side:
            raise ValueError("You must control Zone 1.")
        u = next((e for e in state["equipment"] if e["owner"] == side and e["type"] == "mortar" and e["loc"] == "supply"), None)
        if not u:
            raise ValueError("No Mortar in supply.")
        spend(state, side, "bayonet", 2)
        u["loc"] = zone
        u["damage"] = 0
        log(state, f"{label_side(side)} deploys a Mortar in {ZONE_LABELS[zone]}.")
    elif kind == "mg":
        if remaining(state, side, "bayonet") < 3:
            raise ValueError("Need 3 Bayonets.")
        if zone not in side_zones(side):
            raise ValueError("Machine Guns deploy on your own side.")
        if controller_of(state, zone) != side:
            raise ValueError("You must control that zone.")
        u = next((e for e in state["equipment"] if e["owner"] == side and e["type"] == "mg" and e["loc"] == "supply"), None)
        if not u:
            raise ValueError("No Machine Gun in supply.")
        spend(state, side, "bayonet", 3)
        u["loc"] = zone
        u["damage"] = 0
        log(state, f"{label_side(side)} deploys a Machine Gun in {ZONE_LABELS[zone]}.")
    elif kind == "tank":
        if remaining(state, side, "bayonet") < 4:
            raise ValueError("Need 4 Bayonets.")
        u = next((e for e in state["equipment"] if e["owner"] == side and e["type"] == "tank" and e["loc"] == "supply"), None)
        if not u:
            raise ValueError("No Tank in supply.")
        spend(state, side, "bayonet", 4)
        u["loc"] = own_zone1(side)
        u["damage"] = 0
        log(state, f"{label_side(side)} deploys a Tank in {ZONE_LABELS[u['loc']]}.")
    refresh_control(state)
    check_missions(state, side, {"timing": "immediate"})


def do_repair(state, action):
    side = state["active"]
    if remaining(state, side, "bayonet") < 1:
        raise ValueError("Need 1 Bayonet.")
    u = next(
        (
            e
            for e in state["equipment"]
            if e["id"] == action.get("unitId") and e["owner"] == side and is_battlefield(e["loc"])
        ),
        None,
    )
    if not u or u["damage"] < 1:
        raise ValueError("That Unit does not need repair.")
    spend(state, side, "bayonet", 1)
    u["damage"] -= 1
    log(state, f"{label_side(side)} repairs the {cap_type(u['type'])} ({u['damage']} Damage left).")
    refresh_control(state)


def do_move(state, action):
    side = state["active"]
    if action.get("kind") == "soldier":
        s = next((x for x in state["soldiers"] if x["id"] == action.get("unitId") and x["owner"] == side), None)
        if not s:
            raise ValueError("Soldier not found.")
        if state["effects"].get("trenchFoot") and s["owner"] != state["effects"].get("trenchFootBy"):
            raise ValueError("Trench Foot prevents Soldier movement.")
        if s["coverId"]:
            raise ValueError("Soldiers in Cover must Leave Cover first.")
        if remaining(state, side, "boot") < 1:
            raise ValueError("Need a Boot.")
        if not is_battlefield(s["loc"]):
            raise ValueError("That Soldier is not on the battlefield.")
        dest = step_zone(side, s["loc"], action.get("dir"))
        if not dest or not is_battlefield(dest):
            raise ValueError("Illegal destination.")
        spend(state, side, "boot", 1)
        s["loc"] = dest
        s["coverId"] = None
        log(state, f"{label_side(side)} Soldier moves {action.get('dir')} to {ZONE_LABELS[dest]}.")
    else:
        u = next((e for e in state["equipment"] if e["id"] == action.get("unitId") and e["owner"] == side), None)
        if not u or u["type"] == "tank":
            raise ValueError("Illegal Unit.")
        if u["damage"] >= 1:
            raise ValueError("Damaged support weapons cannot move.")
        if u["id"] in state["players"][side]["firedEquip"]:
            raise ValueError("That Unit already attacked.")
        if remaining(state, side, "boot") < 1:
            raise ValueError("Need a Boot.")
        dest = step_zone(side, u["loc"], action.get("dir"))
        if not dest or not is_battlefield(dest):
            raise ValueError("Illegal destination.")
        spend(state, side, "boot", 1)
        u["loc"] = dest
        state["players"][side]["movedEquip"].append(u["id"])
        log(state, f"{label_side(side)} {cap_type(u['type'])} moves to {ZONE_LABELS[dest]}.")
    refresh_control(state)
    check_missions(state, side, {"timing": "immediate"})


def leave_then_move(state, action):
    side = state["active"]
    if remaining(state, side, "shovel") < 1:
        raise ValueError("Need a Shovel to Leave Cover.")
    s = next((x for x in state["soldiers"] if x["id"] == action.get("unitId") and x["owner"] == side), None)
    if not s or not s.get("coverId"):
        raise ValueError("Soldier is not in Cover.")
    spend(state, side, "shovel", 1)
    s["coverId"] = None
    log(state, f"{label_side(side)} Soldier leaves Cover.")
    return do_move(state, {**action, "kind": "soldier"})


def do_shovel(state, action):
    side = state["active"]
    if remaining(state, side, "shovel") < 1:
        raise ValueError("Need a Shovel.")
    mode = action.get("mode")
    if mode == "dig":
        s = next((x for x in state["soldiers"] if x["id"] == action.get("soldierId") and x["owner"] == side), None)
        if not s or s["coverId"] or not is_battlefield(s["loc"]):
            raise ValueError("Illegal Dig In.")
        cover = next(
            (c for c in state["covers"] if c["id"] == action.get("coverId") and c["loc"] == s["loc"] and not c["destroyed"]),
            None,
        )
        if not cover:
            raise ValueError("No such Cover.")
        occ = soldiers_in(state, s["loc"], match_cover=True, cover_id=cover["id"])
        if any(o["owner"] != side for o in occ):
            raise ValueError("Opposing Soldiers may not share Cover.")
        if len(occ) >= 3:
            raise ValueError("Cover capacity is 3.")
        spend(state, side, "shovel", 1)
        s["coverId"] = cover["id"]
        log(state, f"{label_side(side)} Soldier Digs In.")
    elif mode == "leave":
        s = next((x for x in state["soldiers"] if x["id"] == action.get("soldierId") and x["owner"] == side), None)
        if not s or not s.get("coverId"):
            raise ValueError("Not in Cover.")
        spend(state, side, "shovel", 1)
        s["coverId"] = None
        log(state, f"{label_side(side)} Soldier leaves Cover.")
    elif mode == "prepare":
        zone = action.get("zone")
        if controller_of(state, zone) != side:
            raise ValueError("Prepare Position requires Control.")
        if not state["coverSupply"]:
            raise ValueError("No Cover tokens remain.")
        spend(state, side, "shovel", 1)
        token = state["coverSupply"].pop(0)
        token["loc"] = zone
        state["covers"].append(token)
        log(state, f"{label_side(side)} prepares Cover in {ZONE_LABELS[zone]}.")
    elif mode == "relocate":
        cover = next((c for c in state["covers"] if c["id"] == action.get("coverId") and not c["destroyed"]), None)
        if not cover:
            raise ValueError("Cover not found.")
        if soldiers_in(state, cover["loc"], match_cover=True, cover_id=cover["id"]):
            raise ValueError("Occupied Cover cannot move.")
        dest = action.get("zone")
        if zone_distance(cover["loc"], dest) != 1:
            raise ValueError("Relocate one zone only.")
        if controller_of(state, dest) != side:
            raise ValueError("Destination must be a zone you control.")
        spend(state, side, "shovel", 1)
        cover["loc"] = dest
        log(state, f"{label_side(side)} relocates Cover to {ZONE_LABELS[dest]}.")
    refresh_control(state)
    check_missions(state, side, {"timing": "immediate"})


def start_attack(state, action):
    if state["effects"].get("christmasTruce"):
        raise ValueError("Christmas Truce: no attacks.")
    state["combat"] = {
        "side": state["active"],
        "kind": action.get("kind"),
        "attackerIds": action.get("attackerIds") or [],
        "unitId": action.get("unitId"),
        "target": action.get("target"),
    }
    return resolve_attack(state, {**action, "auto": True})


def resolve_attack(state, action):
    side = state["active"]
    tgt = action.get("target") or (state.get("combat") or {}).get("target")
    if not tgt:
        raise ValueError("No target.")
    if state["effects"].get("christmasTruce"):
        raise ValueError("Christmas Truce: no attacks.")
    kind = action.get("kind") or (state.get("combat") or {}).get("kind")
    if kind == "mortar":
        return mortar_attack(state, action.get("unitId") or state["combat"]["unitId"], tgt)
    if kind == "tank":
        return tank_attack(state, action.get("unitId") or state["combat"]["unitId"], tgt)

    attackers = []
    for aid in action.get("attackerIds") or []:
        s = next((x for x in state["soldiers"] if x["id"] == aid), None)
        u = next((x for x in state["equipment"] if x["id"] == aid), None)
        if s or u:
            attackers.append(s or u)
    if not attackers:
        raise ValueError("No attackers.")
    for a in attackers:
        if a["id"] in state["players"][side]["attackedIds"]:
            raise ValueError("A Unit already attacked.")
        if a.get("type") and a["id"] in state["players"][side]["movedEquip"]:
            raise ValueError("That weapon already moved.")
        if (
            a.get("type") == "mg"
            and state["effects"].get("suppression") == "mg"
            and a["owner"] != state["effects"].get("suppressionBy")
        ):
            raise ValueError("Suppressed Machine Guns cannot attack.")

    dice = 0
    for a in attackers:
        if a.get("owner") and a.get("loc") and not a.get("type"):
            if not can_soldier_target(a, tgt):
                raise ValueError("Illegal Soldier target.")
            dice += 1
        elif a.get("type") == "mg":
            if tgt.get("kind") == "tank":
                raise ValueError("Machine Guns cannot target Tanks.")
            if zone_distance(a["loc"], tgt.get("zone")) > 2:
                raise ValueError("Machine Gun out of range.")
            if smoked(state, a["loc"], tgt.get("zone")):
                raise ValueError("Smoke Screen blocks this fire.")
            dice += 4 if tgt.get("zone") == "obj" else 3
    if state["effects"].get("cavalryCharge") == side and any(not a.get("type") for a in attackers):
        dice += 1

    result = roll_hits(state, dice)
    log(state, f"{label_side(side)} attack rolls {dice} dice → {result['hits']} Hit(s) [{', '.join(result['faces'])}].")
    apply_hits(state, side, tgt, result["hits"])
    for a in attackers:
        state["players"][side]["attackedIds"].append(a["id"])
        if a.get("type"):
            state["players"][side]["firedEquip"].append(a["id"])
    refresh_control(state)
    check_missions(state, side, {"timing": "combat", "hits": result["hits"], "target": tgt})
    state["combat"] = None


def mortar_attack(state, unit_id, tgt):
    side = state["active"]
    u = next((e for e in state["equipment"] if e["id"] == unit_id and e["type"] == "mortar" and e["owner"] == side), None)
    if not u or u["damage"] >= 1:
        raise ValueError("Mortar cannot fire.")
    if u["id"] in state["players"][side]["movedEquip"] and u["id"] not in state["effects"].get("mobility", []):
        raise ValueError("Mortar already moved.")
    if state["effects"].get("suppression") == "mortar" and u["owner"] != state["effects"].get("suppressionBy"):
        raise ValueError("Suppressed Mortars cannot attack.")
    if u["id"] in state["effects"].get("precision", []) and tgt.get("zone"):
        zone = tgt["zone"]
    elif u["id"] in state["effects"].get("spotter", []):
        a = roll_mortar_die(state)
        b = roll_mortar_die(state)
        prefer = tgt.get("prefer")
        if prefer and prefer != "blank":
            zone = prefer if prefer in (a, b) else (b if a == "blank" else a)
        else:
            zone = a
        if zone == "blank" and b != "blank":
            zone = b
        log(state, f"Spotter Mortar Die: {a} / {b} → {zone}.")
    else:
        zone = roll_mortar_die(state)
        log(state, f"Mortar Die: {zone}.")
    if zone == "blank":
        log(state, "Mortar misses.")
        state["players"][side]["attackedIds"].append(u["id"])
        state["players"][side]["firedEquip"].append(u["id"])
        return
    mapped = map_mortar_zone(u["owner"], zone)
    apply_hits(state, side, {**tgt, "zone": mapped, "kind": tgt.get("kind") or "allocate"}, 2)
    state["players"][side]["attackedIds"].append(u["id"])
    state["players"][side]["firedEquip"].append(u["id"])
    refresh_control(state)
    check_missions(state, side, {"timing": "combat", "hits": 2, "target": {**tgt, "zone": mapped}})


def map_mortar_zone(owner, face):
    if face in ("obj", "blank"):
        return face
    if owner == "uk":
        return face
    return {"de1": "uk1", "de2": "uk2", "de3": "uk3"}.get(face, face)


def tank_attack(state, unit_id, tgt):
    side = state["active"]
    u = next((e for e in state["equipment"] if e["id"] == unit_id and e["type"] == "tank" and e["owner"] == side), None)
    if not u:
        raise ValueError("Tank not found.")
    if zone_distance(u["loc"], tgt.get("zone")) > 1:
        raise ValueError("Tank out of range.")
    if tgt.get("kind") == "cover-empty":
        raise ValueError("Tanks cannot make a normal attack against Cover. Use Overrun.")
    if smoked(state, u["loc"], tgt.get("zone")):
        raise ValueError("Smoke Screen blocks this fire.")
    result = roll_hits(state, 3)
    log(state, f"{label_side(side)} Tank fires 3 dice → {result['hits']} Hit(s) [{', '.join(result['faces'])}].")
    apply_hits(state, side, tgt, result["hits"])
    state["players"][side]["attackedIds"].append(u["id"])
    refresh_control(state)
    check_missions(state, side, {"timing": "combat", "hits": result["hits"], "target": tgt})


def do_overrun(state, action):
    if state["effects"].get("christmasTruce"):
        raise ValueError("Christmas Truce: no Overrun.")
    side = state["active"]
    tank = next((e for e in state["equipment"] if e["id"] == action.get("unitId") and e["type"] == "tank" and e["owner"] == side), None)
    cover = next((c for c in state["covers"] if c["id"] == action.get("coverId") and not c["destroyed"]), None)
    if not tank or not cover or cover["loc"] != tank["loc"]:
        raise ValueError("Overrun must target Cover in the Tank's zone.")
    for s in soldiers_in(state, cover["loc"], match_cover=True, cover_id=cover["id"]):
        s["coverId"] = None
    take_cover_trophy(state, side, cover)
    state["players"][side]["attackedIds"].append(tank["id"])
    log(state, f"{label_side(side)} Tank Overruns Cover. Occupants become exposed.")
    refresh_control(state)
    check_missions(state, side, {"timing": "combat", "overrun": True})


def can_soldier_target(s, tgt):
    if tgt.get("kind") == "tank":
        return s["loc"] == tgt.get("zone")
    return zone_distance(s["loc"], tgt.get("zone")) <= 1


def smoked(state, frm, to):
    if frm == to:
        return False
    return frm in state["effects"].get("smoke", []) or to in state["effects"].get("smoke", [])


def finish_action_phase(state):
    nxt = other(state["active"])
    if state["active"] == state["player1"]:
        start_action_phase(state, nxt)
    else:
        start_regroup(state)


def start_regroup(state):
    state["phase"] = "regroup"
    state["actionStep"] = None
    state["active"] = state["human"]
    state["pending"] = {"type": "regroup"}
    log(state, "Regroup — spend unused natural Whistles to draw Events.")


def regroup_draw(state, action):
    side = action.get("side") or state["active"]
    p = state["players"][side]
    natural = p["dice"].count("whistle") - (p.get("spent") or {}).get("whistle", 0)
    used = p.get("regroupDraws") or 0
    if used >= max(0, natural):
        raise ValueError("No unused natural Whistles left.")
    if len(p["eventHand"]) >= 7:
        raise ValueError("Event hand is full.")
    draw_event(state, side, action.get("source"))
    p["regroupDraws"] = used + 1


def draw_event(state, side, source):
    card = None
    if source and source != "deck":
        i = next((idx for idx, c in enumerate(state["eventDisplay"]) if c["inst"] == source), -1)
        if i >= 0:
            card = state["eventDisplay"][i]
            state["eventDisplay"][i] = state["eventDeck"].pop() if state["eventDeck"] else None
            state["eventDisplay"] = [c for c in state["eventDisplay"] if c]
            while len(state["eventDisplay"]) < 3 and state["eventDeck"]:
                state["eventDisplay"].append(state["eventDeck"].pop())
    else:
        card = state["eventDeck"].pop() if state["eventDeck"] else None
    if not card:
        log(state, "Event deck is empty.")
        return
    state["players"][side]["eventHand"].append(card)
    log(state, f"{label_side(side)} draws {card['title']}.")


def end_round(state):
    check_missions(state, "uk", {"timing": "end"})
    check_missions(state, "de", {"timing": "end"})
    for s in state["soldiers"]:
        if s["loc"] == "casualties":
            s["loc"] = "available"
            s["overflow"] = False
    state["roundElim"] = {"uk": 0, "de": 0}
    state["roundBurst"] = {"uk": False, "de": False}
    state["roundSupportKill"] = {"uk": False, "de": False}
    state["roundTankKill"] = {"uk": False, "de": False}
    for side in ("uk", "de"):
        state["players"][side]["regroupDraws"] = 0
    if state["missionExhausted"]:
        return end_game(state, "Mission Exhaustion")
    if state["round"] >= state["maxRounds"]:
        return end_game(state, "Final round")
    state["round"] += 1
    log(state, f"Round {state['round']} begins.")
    begin_initiative(state)


def end_game(state, why):
    state["phase"] = "end"
    state["pending"] = {"type": "end"}
    if state["vp"]["uk"] > state["vp"]["de"]:
        state["winner"] = "uk"
    elif state["vp"]["de"] > state["vp"]["uk"]:
        state["winner"] = "de"
    elif controller_of(state, "obj"):
        state["winner"] = controller_of(state, "obj")
    else:
        uk_e = sum(1 for z in enemy_side_zones("uk") if controller_of(state, z) == "uk")
        de_e = sum(1 for z in enemy_side_zones("de") if controller_of(state, z) == "de")
        if uk_e > de_e:
            state["winner"] = "uk"
        elif de_e > uk_e:
            state["winner"] = "de"
        else:
            state["winner"] = None
    state["tiebreak"] = why
    if state["winner"]:
        log(state, f"{label_side(state['winner'])} wins ({why}).")
    else:
        log(state, f"Draw ({why}).")


def discard_event(state, side, inst):
    p = state["players"][side]
    i = next((idx for idx, c in enumerate(p["eventHand"]) if c["inst"] == inst), -1)
    if i >= 0:
        state["eventDiscard"].append(p["eventHand"].pop(i))


def trim_missions(state, side):
    p = state["players"][side]
    while len(p["missionHand"]) > 5:
        state["missionDeck"].append(p["missionHand"].pop())


def cap_type(t):
    return {"mg": "Machine Gun", "mortar": "Mortar", "tank": "Tank"}.get(t, t)
