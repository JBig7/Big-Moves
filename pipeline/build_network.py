"""BigMoves data pipeline: raw GTFS + GIS + OSM  ->  web/data/network.json + time_model_v0.json

Run from the project root:  python pipeline/build_network.py

Inputs (all read-only):
  recftfc_contactusformjosephghana/gtfs_accra/          TfC GUMAP 2021 GTFS (outer GAMA)
  recftfc_contactusformjosephghana/GIS/GIS/...          onboard survey trips, route legs, districts
  data_external/accra_gtfs_2015/                        World Bank / Accra Mobility 2015 GTFS (core AMA), CC BY 4.0
  data_external/osm/places_raw.json                     OSM named places (Overpass), ODbL

The phone never touches raw files: everything is cleaned, indexed and simplified here once.
"""
import bisect
import csv
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TFC = ROOT / "recftfc_contactusformjosephghana" / "gtfs_accra"
GIS = ROOT / "recftfc_contactusformjosephghana" / "GIS" / "GIS"
AM15 = ROOT / "data_external" / "accra_gtfs_2015"
OSM = ROOT / "data_external" / "osm" / "places_raw.json"
OUT = ROOT / "web" / "data"

DATA_VERSION = "2026.10-proto1"
BANDS = [("am", "Morning (6-10am)"), ("mid", "Midday (10am-3pm)"), ("pm", "Evening (3-7pm)")]
TFC_BAND = {"06:00:00": 0, "10:00:00": 1, "15:00:00": 2}
ONBOARD_BAND = {"06:00 AM": 0, "10:00 AM": 1, "3:00 PM": 2}

WALK_LINK_M = 400        # max walk between stops for a transfer
WALK_SPEED = 1.2         # m/s
WALK_DETOUR = 1.25       # straight line -> street distance
PLACE_ACCESS_M = 1200    # max walk from a place to a stop
STOP_GROUP_M = 600       # same-name stops closer than this become one search entry
MIN_SEG_S = 20
# Range = 10th-90th percentile of measured variation: hold-out coverage ~77% (see docs/time_model_validation.md)
RANGE_Q = (0.1, 0.5, 0.9)

AREA_KINDS = {"city", "town", "suburb", "neighbourhood", "quarter", "village"}
PLACE_KINDS = {
    "place": {"city", "town", "suburb", "neighbourhood", "quarter", "village", "locality", "hamlet"},
    "amenity": {"marketplace", "hospital", "university", "college", "bus_station"},
    "shop": {"mall"},
    "tourism": {"attraction", "museum", "hotel"},
    "aeroway": {"aerodrome"},
    "leisure": {"stadium"},
}


# ---------------------------------------------------------------- helpers
def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def hms(t):
    h, m, s = map(int, t.split(":"))
    return h * 3600 + m * 60 + s


def dist_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(a))


def walk_s(m):
    return round(m * WALK_DETOUR / WALK_SPEED)


def clean_name(s):
    return " ".join((s or "").replace("_", " ").split()).strip()


def am15_stop_name(s):
    # 2015 names carry survey numbers ("Zongo Junction 422", "Filling Station 021"); "37 Station" stays
    return re.sub(r"\s+\d{3}$", "", clean_name(s))


def end_name(s):
    return re.sub(r"^Terminal\s+", "", s)


def quantile(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    i = (len(xs) - 1) * q
    lo, hi = math.floor(i), math.ceil(i)
    return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)


class Grid:
    """Simple spatial hash for radius queries (degrees ~ 111 km)."""

    def __init__(self, cell_m):
        self.cell = cell_m / 111000
        self.cells = defaultdict(list)

    def key(self, lat, lon):
        return int(lat // self.cell), int(lon // self.cell)

    def add(self, item, lat, lon):
        self.cells[self.key(lat, lon)].append((item, lat, lon))

    def near(self, lat, lon, radius_m):
        k = self.key(lat, lon)
        r = math.ceil(radius_m / 111000 / self.cell)
        for di in range(-r, r + 1):
            for dj in range(-r, r + 1):
                for item, la, lo in self.cells.get((k[0] + di, k[1] + dj), ()):
                    d = dist_m(lat, lon, la, lo)
                    if d <= radius_m:
                        yield item, d


def simplify(pts, tol):
    """Douglas-Peucker on (lat, lon) in degrees."""
    if len(pts) < 3:
        return list(range(len(pts)))
    keep = {0, len(pts) - 1}
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (y1, x1), (y2, x2) = pts[a], pts[b]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-12
        best, idx = 0, None
        for i in range(a + 1, b):
            y, x = pts[i]
            d = abs(dy * (x - x1) - dx * (y - y1)) / norm
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol:
            keep.add(idx)
            stack += [(a, idx), (idx, b)]
    return sorted(keep)


def encode_polyline(pts):
    out, plat, plon = [], 0, 0
    for lat, lon in pts:
        ilat, ilon = round(lat * 1e5), round(lon * 1e5)
        for v in (ilat - plat, ilon - plon):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plon = ilat, ilon
    return "".join(out)


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi:
            inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------- districts
def load_districts():
    gj = json.load(open(GIS / "Base" / "subdivision_1.geojson", encoding="utf-8"))
    polys = []
    for f in gj["features"]:
        g = f["geometry"]
        parts = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for part in parts:
            outer = part[0]
            xs, ys = [p[0] for p in outer], [p[1] for p in outer]
            polys.append((f["properties"]["ADM2_EN"], (min(xs), min(ys), max(xs), max(ys)), outer))

    def lookup(lat, lon):
        for name, (x0, y0, x1, y1), ring in polys:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and point_in_ring(lon, lat, ring):
                return name
        return ""

    return lookup


# ---------------------------------------------------------------- feeds
class Net:
    def __init__(self):
        self.stop_index = {}   # global stop id -> idx
        self.stops = []        # dicts
        self.patterns = []

    def stop(self, gid, name, lat, lon):
        if gid not in self.stop_index:
            self.stop_index[gid] = len(self.stops)
            self.stops.append({"id": gid, "name": clean_name(name) or "Unnamed stop", "lat": lat, "lon": lon})
        return self.stop_index[gid]


def shape_points(rows, seq_key="shape_pt_sequence"):
    shapes = defaultdict(list)
    for r in rows:
        shapes[r["shape_id"]].append((int(r[seq_key]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
    return {k: [(la, lo) for _, la, lo in sorted(v)] for k, v in shapes.items()}


def load_tfc(net, audit):
    routes = {r["route_id"]: r for r in read_csv(TFC / "routes.txt")}
    stops = {s["stop_id"]: s for s in read_csv(TFC / "stops.txt")}
    trips = read_csv(TFC / "trips.txt")
    st = defaultdict(list)
    for r in read_csv(TFC / "stop_times.txt"):
        st[r["trip_id"]].append(r)
    freq = {r["trip_id"]: int(r["headway_secs"]) for r in read_csv(TFC / "frequencies.txt") if r["headway_secs"].isdigit()}
    shapes = shape_points(read_csv(TFC / "shapes.txt"))
    legs = {}
    for f in json.load(open(GIS / "Processed" / "route_legs.geojson", encoding="utf-8"))["features"]:
        p = f["properties"]
        legs[p["trip_id"]] = p

    groups = defaultdict(dict)   # base trip -> band -> trip
    for t in trips:
        if routes[t["route_id"]]["agency_id"] != "trotro":
            audit["tfc_taxi_trips_dropped"] += 1
            continue
        base, start = t["trip_id"].rsplit("-", 1)
        if start not in TFC_BAND:
            audit["tfc_unknown_band"] += 1
            continue
        groups[base][TFC_BAND[start]] = t

    for base, bands in groups.items():
        any_trip = next(iter(bands.values()))
        ref = sorted(st[any_trip["trip_id"]], key=lambda r: int(r["stop_sequence"]))
        seq_ids = [r["stop_id"] for r in ref]
        if len(seq_ids) < 2:
            audit["tfc_short_pattern"] += 1
            continue
        seg = []
        hw = []
        for b in range(3):
            t = bands.get(b)
            rows = sorted(st[t["trip_id"]], key=lambda r: int(r["stop_sequence"])) if t else None
            if not rows or [r["stop_id"] for r in rows] != seq_ids:
                rows = ref
                audit["tfc_band_filled"] += 1
            seg.append([max(MIN_SEG_S, hms(rows[i + 1]["arrival_time"]) - hms(rows[i]["departure_time"]))
                        for i in range(len(rows) - 1)])
            hw.append(freq.get(t["trip_id"]) if t else None)
        leg = legs.get(base, {})
        o, d = clean_name(leg.get("origin")), clean_name(leg.get("destination"))
        name = f"{o} - {d}" if o and d else clean_name(any_trip["trip_headsign"])
        idx = [net.stop("tfc:" + s, stops[s]["stop_name"], float(stops[s]["stop_lat"]), float(stops[s]["stop_lon"]))
               for s in seq_ids]
        net.patterns.append({
            "id": "tfc:" + base, "src": "tfc", "code": "", "name": name,
            "stops": idx, "seg": seg, "hw": hw,
            "shape": shapes.get(any_trip["shape_id"]),
            "route": any_trip["route_id"],
        })
    audit["tfc_patterns"] = sum(1 for p in net.patterns if p["src"] == "tfc")


def load_am15(net, audit):
    routes = {r["route_id"]: r for r in read_csv(AM15 / "routes.txt")}
    stops = {s["stop_id"]: s for s in read_csv(AM15 / "stops.txt")}
    st = defaultdict(list)
    for r in read_csv(AM15 / "stop_times.txt"):
        st[r["trip_id"]].append(r)
    shapes = shape_points(read_csv(AM15 / "shapes.txt"))
    for t in read_csv(AM15 / "trips.txt"):
        rows = sorted(st[t["trip_id"]], key=lambda r: int(r["stop_sequence"]))
        # drop immediate repeats of the same stop
        dedup = [r for i, r in enumerate(rows) if i == 0 or r["stop_id"] != rows[i - 1]["stop_id"]]
        if len(dedup) < 2:
            audit["am15_short_pattern"] += 1
            continue
        seg1 = [max(MIN_SEG_S, hms(dedup[i + 1]["arrival_time"]) - hms(dedup[i]["departure_time"]))
                for i in range(len(dedup) - 1)]
        r = routes[t["route_id"]]
        idx = [net.stop("am15:" + x["stop_id"], am15_stop_name(stops[x["stop_id"]]["stop_name"]),
                        float(stops[x["stop_id"]]["stop_lat"]), float(stops[x["stop_id"]]["stop_lon"])) for x in dedup]
        # some 2015 long names use placeholder ends ("A to Achimota", "NULL"): fall back to terminal stop names
        ends = [e.strip() for e in clean_name(r["route_long_name"]).split(" to ")]
        good = [end_name(net.stops[i]["name"]) for i in idx]
        good = [g for g in good if len(g) > 2 and g.upper() != "NULL"] or [r["route_short_name"]]
        first, last = good[0], good[-1]
        if len(ends) != 2:
            ends = [first, last]
        ends = [e if len(e) > 2 and e.upper() != "NULL" else alt for e, alt in zip(ends, (first, last))]
        name = " - ".join(ends)
        audit["am15_names_repaired"] += ends != [e.strip() for e in clean_name(r["route_long_name"]).split(" to ")]
        net.patterns.append({
            "id": "am15:" + t["trip_id"], "src": "am15", "code": r["route_short_name"], "name": name,
            "stops": idx, "seg": [seg1, list(seg1), list(seg1)], "hw": [None, None, None],
            "shape": shapes.get(t["shape_id"]),
            "route": t["route_id"],
        })
    audit["am15_patterns"] = sum(1 for p in net.patterns if p["src"] == "am15")


# ---------------------------------------------------------------- shape snapping + clean-up
OFF_PATH_M = 400


def snap(shape, stop_pts):
    """Monotone nearest-point snap of stops onto a shape. Returns (positions, distances_m)."""
    pos, dists, start = [], [], 0
    for la, lo in stop_pts:
        best, bi = 1e18, start
        for k in range(start, len(shape)):
            d = (shape[k][0] - la) ** 2 + ((shape[k][1] - lo) * 0.996) ** 2
            if d < best:
                best, bi = d, k
        pos.append(bi)
        dists.append(dist_m(la, lo, *shape[bi]))
        start = bi
    return pos, dists


def clean_patterns(net, audit):
    """Orient shapes to match stop order and drop stops that lie far off the route's own path
    (survey mis-tags such as a 'Kasoa' terminal inside a Nima route). Then drop unused stops."""
    for p in net.patterns:
        if not p["shape"]:
            continue
        pts = [(net.stops[i]["lat"], net.stops[i]["lon"]) for i in p["stops"]]
        fwd = snap(p["shape"], pts)
        rev_shape = p["shape"][::-1]
        rev = snap(rev_shape, pts)
        if sum(rev[1]) < sum(fwd[1]):
            p["shape"], fwd = rev_shape, rev
            audit["shapes_reversed"] += 1
        pos, dists = fwd
        k = 0
        while k < len(p["stops"]) and len(p["stops"]) > 2:
            if dists[k] > OFF_PATH_M:
                for seg in p["seg"]:
                    if 0 < k < len(seg):
                        seg[k - 1] += seg[k]
                        del seg[k]
                    elif k == 0:
                        del seg[0]
                    else:
                        del seg[-1]
                del p["stops"][k], pos[k], dists[k]
                audit["off_path_stops_dropped"] += 1
                p["_changed"] = True
            else:
                k += 1
        if p.pop("_changed", False):
            pts = [(net.stops[i]["lat"], net.stops[i]["lon"]) for i in p["stops"]]
            pos, dists = snap(p["shape"], pts)
        p["pos"] = pos
        if max(dists) > OFF_PATH_M:
            audit["patterns_still_off_path"] += 1
    # re-index stops so only served stops remain
    used = sorted({i for p in net.patterns for i in p["stops"]})
    remap = {old: new for new, old in enumerate(used)}
    audit["stops_unserved_dropped"] = len(net.stops) - len(used)
    net.stops = [net.stops[i] for i in used]
    net.stop_index = {s["id"]: i for i, s in enumerate(net.stops)}
    for p in net.patterns:
        p["stops"] = [remap[i] for i in p["stops"]]


# ---------------------------------------------------------------- calibration (time model v0)
def build_calibration(net, audit):
    """Spread of measured onboard ride times vs. the GTFS schedule, per time band.

    NOTE: the TfC schedule is itself derived from these surveys, so these are *spread*
    factors (how much a real ride varies around the schedule), not an independent validation.
    Phase 1 field data / Google comparisons should replace them when available.
    """
    sched = {}
    for p in net.patterns:
        if p["src"] == "tfc":
            sched[p["id"][4:]] = [sum(s) for s in p["seg"]]
    ratios = defaultdict(list)
    term_wait = defaultdict(list)
    fmt = lambda s: datetime.fromisoformat(s.replace("+00", "+00:00"))
    for f in json.load(open(GIS / "Processed" / "cleaned_onboard.geojson", encoding="utf-8"))["features"]:
        p = f["properties"]
        b = ONBOARD_BAND.get(p["interval_start"])
        if b is None or p["trip_id"] not in sched:
            continue
        try:
            ride = (fmt(p["finished_at"]) - fmt(p["departed_at"])).total_seconds()
            wait = (fmt(p["departed_at"]) - fmt(p["arrived_at"])).total_seconds()
        except (TypeError, ValueError):
            continue
        s = sched[p["trip_id"]][b]
        if ride > 60 and s > 60 and 0.3 < ride / s < 3:
            ratios[b].append(ride / s)
        if 0 <= wait < 3 * 3600:
            term_wait[b].append(wait)
    calib = {"rangeQuantiles": RANGE_Q, "rideFactor": [], "terminalWait": [], "samples": []}
    for b in range(3):
        r, w = ratios[b], term_wait[b]
        calib["rideFactor"].append([round(quantile(r, q), 3) for q in RANGE_Q])
        calib["terminalWait"].append([round(quantile(w, q)) for q in RANGE_Q])
        calib["samples"].append(len(r))
    hws = [[h for p in net.patterns for h in [p["hw"][b]] if h] for b in range(3)]
    calib["defaultHeadway"] = [round(statistics.median(h)) for h in hws]
    audit["calibration_samples"] = calib["samples"]
    return calib


# ---------------------------------------------------------------- main
def main():
    audit = Counter()
    net = Net()
    load_tfc(net, audit)
    load_am15(net, audit)
    clean_patterns(net, audit)
    calib = build_calibration(net, audit)
    district_of = load_districts()

    # stops: district, which patterns serve them
    grid = Grid(WALK_LINK_M)
    for i, s in enumerate(net.stops):
        s["district"] = district_of(s["lat"], s["lon"])
        grid.add(i, s["lat"], s["lon"])
    audit["stops"] = len(net.stops)
    audit["stops_no_district"] = sum(1 for s in net.stops if not s["district"])

    # walking transfer links
    walk = [[] for _ in net.stops]
    for i, s in enumerate(net.stops):
        for j, d in grid.near(s["lat"], s["lon"], WALK_LINK_M):
            if j != i:
                walk[i] += [j, walk_s(d)]
    audit["walk_links"] = sum(len(w) // 2 for w in walk)
    audit["stops_without_walk_link"] = sum(1 for w in walk if not w)

    # patterns: shapes -> simplified polyline + stop positions on it
    out_patterns = []
    for p in net.patterns:
        stop_pts = [(net.stops[i]["lat"], net.stops[i]["lon"]) for i in p["stops"]]
        pts = p["shape"] or stop_pts
        if not p["shape"]:
            audit["patterns_without_shape"] += 1
        keep = simplify(pts, 0.00008)
        spts = [pts[k] for k in keep]
        # stop positions on the simplified line: nearest kept vertex to the dense snap position
        dense = p.get("pos") or list(range(len(stop_pts)))
        pos = []
        for d in dense:
            b = bisect.bisect_left(keep, d)
            cand = [c for c in (b - 1, b) if 0 <= c < len(keep)]
            pos.append(min(cand, key=lambda c: abs(keep[c] - d)))
        for a, b in zip(pos, pos[1:]):
            assert a <= b
        same = p["seg"][0] == p["seg"][1] == p["seg"][2]
        out_patterns.append({
            "id": p["id"], "src": p["src"], "code": p["code"], "name": p["name"],
            "s": p["stops"],
            "t": p["seg"][0] if same else p["seg"],
            "hw": p["hw"] if any(p["hw"]) else None,
            "shp": encode_polyline(spts), "sp": pos,
        })

    # search index: stop groups + OSM places; w = number of routes serving the entry (ranking)
    serving = defaultdict(set)
    for p in net.patterns:
        for i in p["stops"]:
            serving[i].add(p["name"])
    weight = lambda idxs: len(set().union(*(serving[i] for i in idxs)))
    search = []
    by_name = defaultdict(list)
    for i, s in enumerate(net.stops):
        by_name[s["name"].lower()].append(i)
    for name, idxs in by_name.items():
        clusters = []
        for i in idxs:
            s = net.stops[i]
            for c in clusters:
                if any(dist_m(s["lat"], s["lon"], net.stops[j]["lat"], net.stops[j]["lon"]) < STOP_GROUP_M for j in c):
                    c.append(i)
                    break
            else:
                clusters.append([i])
        for c in clusters:
            lat = sum(net.stops[i]["lat"] for i in c) / len(c)
            lon = sum(net.stops[i]["lon"] for i in c) / len(c)
            dists = Counter(net.stops[i]["district"] for i in c)
            search.append({"n": net.stops[c[0]]["name"], "d": dists.most_common(1)[0][0], "k": "stop",
                           "la": round(lat, 6), "lo": round(lon, 6),
                           "a": [x for i in c for x in (i, 0)], "w": weight(c)})
    audit["search_stop_entries"] = len(search)

    seen = set()
    area_at = defaultdict(list)
    places = json.load(open(OSM, encoding="utf-8"))["elements"]
    for e in places:
        tags = e.get("tags", {})
        kind = next((v for k, vs in PLACE_KINDS.items() for v in [tags.get(k)] if v in vs), None)
        name = clean_name(tags.get("name:en") or tags.get("name"))
        if not kind or not name:
            continue
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lon = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None:
            continue
        key = (name.lower(), round(lat, 2), round(lon, 2))
        if key in seen:
            continue
        seen.add(key)
        reach = PLACE_ACCESS_M * (2 if kind in AREA_KINDS else 1)
        near = sorted(grid.near(lat, lon, reach), key=lambda x: x[1])[:8]
        if kind in AREA_KINDS:
            area_at[name.lower()].append((lat, lon))
        if not near:
            audit["places_without_stop"] += 1
            continue
        search.append({"n": name, "d": district_of(lat, lon), "k": kind,
                       "la": round(lat, 6), "lo": round(lon, 6),
                       "a": [x for j, d in near for x in (j, walk_s(d))], "w": weight([j for j, _ in near])})
    audit["search_place_entries"] = len(search) - audit["search_stop_entries"]

    # A stop named after a town but far from it is usually a field label for the destination
    # ("Kasoa" bus stop in Ga North). Flag it so search ranks the real place first.
    for e in search:
        if e["k"] == "stop" and e["n"].lower() in area_at:
            if min(dist_m(e["la"], e["lo"], la, lo) for la, lo in area_at[e["n"].lower()]) > 3000:
                e["x"] = 1
                audit["stop_names_far_from_place"] += 1

    districts = sorted({s["district"] for s in net.stops} | {e["d"] for e in search})
    dix = {d: i for i, d in enumerate(districts)}
    for e in search:
        e["d"] = dix[e["d"]]

    built = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    network = {
        "meta": {
            "version": DATA_VERSION, "built": built,
            "sources": [
                {"id": "tfc", "name": "GUMAP Accra trotro GTFS and surveys - Transport for Cairo and Transitec "
                 "Consulting Engineers, for the Ministry of Local Government, Decentralization, and Rural "
                 "Development (Ghana). Financed by the Swiss Confederation",
                 "collected": "Jun-Aug 2021", "licence": "CC BY 4.0"},
                {"id": "am15", "name": "Accra GTFS (Accra Mobility / World Bank Data Catalog)",
                 "collected": "May-Jun 2015", "licence": "CC BY 4.0"},
                {"id": "osm", "name": "OpenStreetMap contributors (places)",
                 "collected": built, "licence": "ODbL 1.0"},
            ],
        },
        "bands": [{"id": b, "label": l} for b, l in BANDS],
        "districts": districts,
        "stops": {
            "id": [s["id"] for s in net.stops],
            "n": [s["name"] for s in net.stops],
            "la": [round(s["lat"], 6) for s in net.stops],
            "lo": [round(s["lon"], 6) for s in net.stops],
            "d": [dix[s["district"]] for s in net.stops],
        },
        "patterns": out_patterns,
        "walk": walk,
        "search": search,
    }
    time_model = {
        "model": "v0", "version": DATA_VERSION,
        "description": "segment time + dwell + boarding wait (+ walking), scaled by spread factors from 2021 onboard surveys",
        "dwellSec": 15, "walkSpeed": WALK_SPEED, "walkDetour": WALK_DETOUR,
        "waitHeadwayFactor": [0.2, 0.5, 1.0],
        **calib,
        "limits": [
            "Schedules come from 2021 (outer GAMA) and 2015 (central Accra) surveys and may be out of date.",
            "Ride-time spread is measured only on 2021 routes; 2015 routes reuse the same factors.",
            "Central-Accra (2015) routes have no frequency data; a typical headway is assumed.",
            "Traffic, events and full vehicles at roadside stops are not modelled.",
        ],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "network.json").write_text(json.dumps(network, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    (OUT / "time_model_v0.json").write_text(json.dumps(time_model, indent=1), encoding="utf-8")
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "data_audit.json").write_text(json.dumps(dict(audit), indent=1, default=str), encoding="utf-8")
    size = (OUT / "network.json").stat().st_size
    print(json.dumps(dict(audit), indent=1, default=str))
    print(f"network.json: {size/1024:.0f} KB  ({len(out_patterns)} patterns, {len(net.stops)} stops, {len(search)} search entries)")
    print("time model:", json.dumps({k: calib[k] for k in calib}))


if __name__ == "__main__":
    sys.exit(main())
