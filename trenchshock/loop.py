from .ai import choose_ai_action
from .game import apply


def human_has_regroup(state):
    p = state["players"]["uk"]
    natural = p["dice"].count("whistle") - (p.get("spent") or {}).get("whistle", 0)
    return (p.get("regroupDraws") or 0) < max(0, natural) and len(p["eventHand"]) < 7


def skip_stuck(state):
    step = state.get("actionStep")
    skips = {
        "shock": {"type": "SKIP_SHOCK"},
        "tank": {"type": "SKIP_TANK"},
        "event": {"type": "SKIP_EVENT"},
        "deploy": {"type": "SKIP_DEPLOY"},
        "move": {"type": "SKIP_MOVE"},
        "cover": {"type": "SKIP_COVER"},
        "attack": {"type": "SKIP_ATTACK"},
    }
    if state["phase"] == "reroll":
        return apply(state, {"type": "COMMIT"})
    if state["phase"] == "regroup":
        return apply(state, {"type": "SKIP_REGROUP"})
    if step in skips:
        return apply(state, skips[step])
    return state


def run_until_human(state):
    guard = 0
    while guard < 24:
        guard += 1
        if not state or state["phase"] == "end":
            break
        pending = state.get("pending") or {}
        if pending.get("type") == "generals-order" and pending.get("side") == state["human"]:
            break
        if state["phase"] == "reroll" and state["active"] == state["human"]:
            break
        if state["phase"] == "action" and state["active"] == state["human"]:
            break
        if state["phase"] == "regroup" and state["active"] == state["human"] and human_has_regroup(state):
            break
        if state["phase"] == "initiative" and pending.get("type") == "roll1":
            state = apply(state, {"type": "ROLL_1"})
            continue
        act = choose_ai_action(state)
        if not act:
            break
        before = state
        state = apply(state, act)
        if state.get("error"):
            nxt = skip_stuck(before)
            if not nxt or nxt is before:
                break
            state = nxt
    return state
