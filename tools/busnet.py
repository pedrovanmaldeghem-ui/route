#!/usr/bin/env python3
"""Busnet: waar de bussen van De Lijn, TEC en MIVB echt rijden, als tegels voor de routetekenaar.

Leest de lijnbestanden van Lijnkijker (public/gtfs/l, public/tec/l, public/mivb/l: per lijn de
richtingen en varianten met hun vormlijn 'pts') en schrijft public/busnet/<tx>_<ty>.json.

Elke vormlijn is gericht (de rijrichting van de bus). We houden enkel bussen (GTFS route_type 3 en
700-799), vereenvoudigen de lijnen (Douglas-Peucker, ~3 m), ontdubbelen gerichte stukken die meerdere
lijnen delen en knippen alles op in tegels van 0,05° (~4-5 km). Per tegel:
  { "l": [ [lat0, lon0, dlat1, dlon1, dlat2, dlon2, ...], ... ] }   (in 1e-5 graden, delta-gecodeerd)

Gebruik:  python3 tools/busnet.py /pad/naar/lijnkijker/public
"""
import json, math, os, sys
from collections import defaultdict

TEGEL = 0.05
Q = 100000  # 1e-5 graden

def lees_lijn(map_, naam):
    pad = os.path.join(map_, naam)
    return json.load(open(pad, encoding="utf-8"))

def lijnbestanden(map_):
    """Gewone <id>.json, en gesplitste <id>.s0.json + <id>.s1.json … aan elkaar geplakt."""
    namen = sorted(os.listdir(map_))
    gesplitst = defaultdict(list)
    for n in namen:
        if not n.endswith(".json"):
            continue
        delen = n[:-5].split(".")
        if len(delen) == 2 and delen[1].startswith("s") and delen[1][1:].isdigit():
            gesplitst[delen[0]].append((int(delen[1][1:]), n))
        else:
            yield json.load(open(os.path.join(map_, n), encoding="utf-8"))
    for id_, stukken in gesplitst.items():
        tekst = "".join(open(os.path.join(map_, n), encoding="utf-8").read() for _, n in sorted(stukken))
        yield json.loads(tekst)

def is_bus(t):
    try:
        t = int(t)
    except (TypeError, ValueError):
        return False
    return t == 3 or 700 <= t <= 799

def meter(a, b):
    la = math.radians((a[0] + b[0]) / 2)
    return math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * math.cos(la))

def afstand_tot_lijn(p, a, b):
    la = math.cos(math.radians(p[0]))
    ax, ay, bx, by, px, py = a[1] * la, a[0], b[1] * la, b[0], p[1] * la, p[0]
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - ax - t * dx, py - ay - t * dy) * 111320

def vereenvoudig(pts, tol=3.0):
    if len(pts) < 3:
        return pts
    houd = [False] * len(pts)
    houd[0] = houd[-1] = True
    stapel = [(0, len(pts) - 1)]
    while stapel:
        i, j = stapel.pop()
        best, bi = 0, -1
        for k in range(i + 1, j):
            d = afstand_tot_lijn(pts[k], pts[i], pts[j])
            if d > best:
                best, bi = d, k
        if best > tol:
            houd[bi] = True
            stapel += [(i, bi), (bi, j)]
    return [p for p, h in zip(pts, houd) if h]

def main(bron, doel):
    vormen = set()
    for sub in ("gtfs", "tec", "mivb"):
        map_ = os.path.join(bron, sub, "l")
        if not os.path.isdir(map_):
            continue
        for lijn in lijnbestanden(map_):
            if not is_bus(lijn.get("type")):
                continue
            for d in lijn.get("directions") or []:
                for v in d.get("variants") or []:
                    pts = v.get("pts") or []
                    if len(pts) >= 2:
                        vormen.add(tuple((round(p[0] * Q), round(p[1] * Q)) for p in pts))
    print(f"{len(vormen)} unieke busvormen")
    gezien = set()               # gerichte stukken die al opgenomen zijn
    tegels = defaultdict(list)   # (tx, ty) -> lijst van polylijnen [(lat, lon) in 1e-5]
    for vorm in vormen:
        pts = vereenvoudig([(a / Q, b / Q) for a, b in vorm])
        q = [(round(a * Q), round(b * Q)) for a, b in pts]
        run, run_tegel = [], None
        def sluit():
            if len(run) >= 2:
                tegels[run_tegel].append(list(run))
        for a, b in zip(q, q[1:]):
            if a == b or (a, b) in gezien:
                sluit(); run, run_tegel = [], None
                continue
            gezien.add((a, b))
            t = (math.floor(a[0] / Q / TEGEL), math.floor(a[1] / Q / TEGEL))
            if run and run_tegel == t and run[-1] == a:
                run.append(b)
            else:
                sluit(); run, run_tegel = [a, b], t
        sluit()
    os.makedirs(doel, exist_ok=True)
    for oud in os.listdir(doel):
        if oud.endswith(".json"):
            os.remove(os.path.join(doel, oud))
    totaal = 0
    for (tx, ty), lijnen in tegels.items():
        uit = []
        for l in lijnen:
            plat = [l[0][0], l[0][1]]
            for (a0, b0), (a1, b1) in zip(l, l[1:]):
                plat += [a1 - a0, b1 - b0]
            uit.append(plat)
        tekst = json.dumps({"l": uit}, separators=(",", ":"))
        totaal += len(tekst)
        open(os.path.join(doel, f"{tx}_{ty}.json"), "w").write(tekst)
    json.dump({"tegel": TEGEL, "q": Q, "tegels": sorted(f"{tx}_{ty}" for tx, ty in tegels)},
              open(os.path.join(doel, "index.json"), "w"), separators=(",", ":"))
    print(f"{len(tegels)} tegels, {totaal / 1e6:.1f} MB")

if __name__ == "__main__":
    bron = sys.argv[1] if len(sys.argv) > 1 else "../lijnkijker/public"
    main(bron, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "busnet"))
