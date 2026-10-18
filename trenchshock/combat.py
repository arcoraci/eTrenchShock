from .core import log, label_side, other, own_trench, soldiers_in, ZONE_LABELS


def eliminate_soldier(state, s):
    s["coverId"] = None
    s["loc"] = "casualties"
    log(state, f"{label_side(s['owner'])} Soldier is eliminated.")


def retreat_soldier(state, s, count_mission=True):
    trench = own_trench(s["owner"])
    there = sum(1 for x in state["soldiers"] if x["owner"] == s["owner"] and x["loc"] == trench)
    s["coverId"] = None
    if there >= 5:
        s["loc"] = "casualties"
        s["overflow"] = True
        log(state, f"{label_side(s['owner'])} Soldier cannot enter the Trench and is lost.")
    else:
        s["loc"] = trench
        log(state, f"{label_side(s['owner'])} Soldier Retreats to the Trench.")


def take_cover_trophy(state, side, cover):
    cover["destroyed"] = True
    cover["loc"] = "trophy"
    cover["trophyOwner"] = side
    state["players"][side]["destroyedCover"].append(cover["id"])
    log(state, f"{label_side(side)} destroys Cover (Defense {cover['defense']}).")


def pretty(t):
    return {"mg": "Machine Gun", "mortar": "Mortar", "tank": "Tank"}.get(t, t)


def damage_equipment(state, side, u, hits):
    cap = 3 if u["type"] == "tank" else 2
    u["damage"] += hits
    log(state, f"{pretty(u['type'])} takes {hits} Damage (now {min(u['damage'], cap)}).")
    if u["damage"] >= cap:
        log(state, f"{label_side(u['owner'])} {pretty(u['type'])} is destroyed.")
        if u["type"] in ("mg", "mortar"):
            state["roundSupportKill"][side] = True
        if u["type"] == "tank":
            state["roundTankKill"][side] = True
        u["loc"] = "supply"
        u["damage"] = 0


def apply_hits(state, side, tgt, hits):
    foe = other(side)
    kind = tgt.get("kind")
    if kind == "exposed":
        lst = soldiers_in(state, tgt["zone"], foe, exposed=True)
        n = min(hits, len(lst))
        for i in range(n):
            eliminate_soldier(state, lst[i])
        state["roundElim"][side] = (state["roundElim"].get(side) or 0) + n
        if n >= 3:
            state["roundBurst"][side] = True
    elif kind == "cover":
        cover = next((c for c in state["covers"] if c["id"] == tgt.get("coverId")), None)
        if not cover:
            return
        if not cover["revealed"]:
            cover["revealed"] = True
            log(state, f"Cover Defense {cover['defense']} revealed.")
        leftover = max(0, hits - cover["defense"])
        occ = soldiers_in(state, cover["loc"], foe, match_cover=True, cover_id=cover["id"])
        n = min(leftover, len(occ))
        for i in range(n):
            eliminate_soldier(state, occ[i])
        state["roundElim"][side] = (state["roundElim"].get(side) or 0) + n
        if n >= 3:
            state["roundBurst"][side] = True
    elif kind == "cover-empty":
        cover = next((c for c in state["covers"] if c["id"] == tgt.get("coverId")), None)
        if not cover:
            return
        if not cover["revealed"]:
            cover["revealed"] = True
            log(state, f"Cover Defense {cover['defense']} revealed.")
        if hits >= cover["defense"]:
            take_cover_trophy(state, side, cover)
    elif kind in ("mg", "mortar", "tank"):
        u = next((e for e in state["equipment"] if e["id"] == tgt.get("unitId")), None)
        if not u:
            return
        damage_equipment(state, side, u, hits)
    elif kind == "allocate":
        log(state, f"{hits} Hit(s) in {ZONE_LABELS.get(tgt.get('zone'), tgt.get('zone'))}.")
        apply_hits(state, side, {"kind": "exposed", "zone": tgt["zone"]}, hits)
