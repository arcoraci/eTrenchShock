from .core import ZONE_LABELS, controller_of, BATTLEFIELD
from .dice import remaining, has_shock, combo_label, cap
from .loop import human_has_regroup


def enrich(state):
    if not state:
        return None
    out = dict(state)
    out["view"] = {
        "zoneLabels": ZONE_LABELS,
        "remaining": {
            "boot": remaining(state, "uk", "boot"),
            "shovel": remaining(state, "uk", "shovel"),
            "bayonet": remaining(state, "uk", "bayonet"),
            "whistle": remaining(state, "uk", "whistle"),
        },
        "hasShock": has_shock(state, "uk"),
        "comboUk": combo_label(state["players"]["uk"]["dice"]) if state["players"]["uk"]["dice"] else "",
        "comboDe": combo_label(state["players"]["de"]["dice"]) if state["players"]["de"]["dice"] else "",
        "humanHasRegroup": human_has_regroup(state),
        "control": {z: controller_of(state, z) for z in BATTLEFIELD},
        "cap": {f: cap(f) for f in ("boot", "whistle", "wild", "shovel", "bayonet")},
    }
    return out
