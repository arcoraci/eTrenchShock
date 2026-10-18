from .core import log, label_side, soldiers_in, controller_of, enemy_side_zones, BATTLEFIELD


def draw_mission(state, required):
    if not state["missionDeck"]:
        if required:
            state["missionExhausted"] = True
            log(state, "Mission Exhaustion — no Mission remains to draw.")
        return None
    return state["missionDeck"].pop(0)


def complete_mission(state, side, mission):
    state["vp"][side] += mission["vp"]
    p = state["players"][side]
    p["missionHand"] = [m for m in p["missionHand"] if m["inst"] != mission["inst"]]
    p["completedMissions"].append(mission)
    log(state, f"{label_side(side)} completes {mission['title']} (+{mission['vp']} VP).")
    replacement = draw_mission(state, True)
    if replacement:
        p["missionHand"].append(replacement)
        check_missions(state, side, {"timing": "immediate"})


def check_missions(state, side, ctx=None):
    ctx = ctx or {}
    p = state["players"][side]
    for m in list(p["missionHand"]):
        if is_complete(state, side, m, ctx):
            complete_mission(state, side, m)


def is_complete(state, side, m, ctx):
    title = m["title"]
    if title == "Hold in Cover":
        return controller_of(state, "obj") == side and len(soldiers_in(state, "obj", side, exposed=False)) >= 1
    if title == "Over the Top":
        zones = ["obj", *enemy_side_zones(side)]
        return sum(len(soldiers_in(state, z, side)) for z in zones) >= 3
    if title == "Guns Silenced":
        return m["type"] == "EVENT" and ctx.get("timing") == "combat" and state["roundSupportKill"].get(side)
    if title == "Tank Hunter":
        return m["type"] == "EVENT" and ctx.get("timing") == "combat" and state["roundTankKill"].get(side)
    if title == "No Shelter":
        return len(state["players"][side]["destroyedCover"]) >= 3
    if title == "Deep Push":
        return sum(1 for z in enemy_side_zones(side) if controller_of(state, z) == side) >= 2
    if title == "Shock Action":
        return m["type"] == "EVENT" and ctx.get("timing") == "combat" and state["roundBurst"].get(side)
    if title == "In the Wire":
        return any(len(soldiers_in(state, z, side)) >= 4 for z in enemy_side_zones(side))
    if title == "Dug In":
        return (
            m["type"] == "STATE"
            and ctx.get("timing") == "end"
            and sum(len(soldiers_in(state, z, side, exposed=False)) for z in BATTLEFIELD) >= 3
        )
    if title == "Breakthrough":
        return (
            m["type"] == "STATE"
            and ctx.get("timing") == "end"
            and controller_of(state, "obj") == side
            and any(controller_of(state, z) == side for z in enemy_side_zones(side))
        )
    if title == "Attrition":
        return (
            m["type"] == "EVENT"
            and ctx.get("timing") in ("combat", "immediate")
            and (state["roundElim"].get(side) or 0) >= 5
        )
    return False
