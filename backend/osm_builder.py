import math
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx

OVERPASS_URLS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse"

SPEED_KMH = {
    "motorway": 65.0,
    "motorway_link": 42.0,
    "trunk": 48.0,
    "trunk_link": 34.0,
    "primary": 36.0,
    "primary_link": 26.0,
    "secondary": 28.0,
    "secondary_link": 22.0,
    "tertiary": 22.0,
    "tertiary_link": 18.0,
    "unclassified": 20.0,
    "residential": 18.0,
}

CATEGORY_MAP = {
    "hospital": ("Hospital", 1),
    "fire_station": ("Fire & Rescue", 2),
    "clinic": ("Medical Clinic", 3),
    "station": ("Transit Hub", 4),
    "bus_station": ("Transit Hub", 4),
    "stadium": ("Stadium / Assembly", 5),
    "sports_centre": ("Sports Complex", 6),
    "university": ("University Campus", 7),
    "college": ("College Campus", 7),
    "community_centre": ("Community Shelter", 8),
    "shelter": ("Emergency Shelter", 1),
    "police": ("Police Station", 9),
    "park": ("Open Ground / Park", 10),
}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(min(1.0, a)))


def polyline_km(coords: List[List[float]]) -> float:
    total = 0.0
    for (lat1, lon1), (lat2, lon2) in zip(coords, coords[1:]):
        total += haversine_km(lat1, lon1, lat2, lon2)
    return total


def _clean_name(value: Optional[str]) -> str:
    if not value:
        return ""
    return " ".join(value.strip().split())


def _normalize_poi_name(name: str) -> str:
    cleaned = name.lower().replace("&", " and ")
    return "".join(ch for ch in cleaned if ch.isalnum() or ch.isspace()).strip()


def _is_oneway(tags: Dict[str, Any]) -> Tuple[bool, bool]:
    """Return (is_oneway, is_reverse)."""
    oneway = str(tags.get("oneway", "")).lower()
    if oneway in {"yes", "true", "1"}:
        return True, False
    if oneway == "-1":
        return True, True
    if tags.get("junction") == "roundabout":
        return True, False
    return False, False


def _largest_scc(node_ids: List[str], edges: List[Dict[str, Any]]) -> set:
    """Find largest strongly connected component using iterative Kosaraju."""
    adj = defaultdict(list)
    rev = defaultdict(list)
    for edge in edges:
        u, v = edge["from"], edge["to"]
        adj[u].append(v)
        rev[v].append(u)
        if not edge.get("oneway", False):
            adj[v].append(u)
            rev[u].append(v)

    visited = set()
    order = []
    for start in node_ids:
        if start in visited:
            continue
        stack = [(start, 0)]
        visited.add(start)
        while stack:
            node, idx = stack[-1]
            neighbors = adj[node]
            if idx < len(neighbors):
                stack[-1] = (node, idx + 1)
                nxt = neighbors[idx]
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append((nxt, 0))
            else:
                order.append(node)
                stack.pop()

    visited.clear()
    best_comp: set = set()
    for start in reversed(order):
        if start in visited:
            continue
        comp = set()
        queue = deque([start])
        visited.add(start)
        while queue:
            cur = queue.popleft()
            comp.add(cur)
            for nxt in rev[cur]:
                if nxt not in visited:
                    visited.add(nxt)
                    queue.append(nxt)
        if len(comp) > len(best_comp):
            best_comp = comp
    return best_comp


def _largest_wcc(node_ids: List[str], edges: List[Dict[str, Any]]) -> set:
    """Fallback undirected connected component for sparse regions."""
    adj = defaultdict(list)
    for edge in edges:
        u, v = edge["from"], edge["to"]
        adj[u].append(v)
        adj[v].append(u)

    visited = set()
    best_comp: set = set()
    for start in node_ids:
        if start in visited:
            continue
        comp = set()
        queue = deque([start])
        visited.add(start)
        while queue:
            cur = queue.popleft()
            comp.add(cur)
            for nxt in adj[cur]:
                if nxt not in visited:
                    visited.add(nxt)
                    queue.append(nxt)
        if len(comp) > len(best_comp):
            best_comp = comp
    return best_comp


def build_graph_from_osm(
    roads_elements: List[Dict[str, Any]],
    pois_elements: List[Dict[str, Any]],
    area_name: str = "Ludhiana, Punjab, India",
    center: Tuple[float, float] = (30.9010, 75.8573),
    max_shelters: int = 60,
) -> Dict[str, Any]:
    osm_nodes: Dict[int, Tuple[float, float]] = {}
    ways: List[Dict[str, Any]] = []

    for el in roads_elements:
        if el.get("type") == "node" and "lat" in el and "lon" in el:
            osm_nodes[el["id"]] = (float(el["lat"]), float(el["lon"]))
        elif el.get("type") == "way" and "highway" in el.get("tags", {}):
            nds = el.get("nodes", [])
            if len(nds) >= 2:
                ways.append(el)

    node_way_count: Dict[int, int] = defaultdict(int)
    for way in ways:
        nds = way["nodes"]
        for nid in set(nds):
            node_way_count[nid] += 1
        node_way_count[nds[0]] += 1
        node_way_count[nds[-1]] += 1

    raw_edges: List[Dict[str, Any]] = []
    used_node_streets: Dict[int, List[str]] = defaultdict(list)

    for way in ways:
        tags = way.get("tags", {})
        highway = tags.get("highway", "tertiary")
        speed_kmh = SPEED_KMH.get(highway, 22.0)
        street_name = _clean_name(tags.get("name") or tags.get("ref")) or f"{highway.replace('_', ' ').title()} Road"
        oneway, reverse = _is_oneway(tags)
        nds = list(reversed(way["nodes"])) if reverse else way["nodes"]

        seg_start_idx = 0
        for i in range(1, len(nds)):
            is_anchor = (i == len(nds) - 1) or (node_way_count[nds[i]] > 1)
            if not is_anchor:
                continue

            seg_nids = nds[seg_start_idx : i + 1]
            seg_start_idx = i
            if len(seg_nids) < 2 or seg_nids[0] == seg_nids[-1]:
                continue
            if any(nid not in osm_nodes for nid in seg_nids):
                continue

            geom = [[round(osm_nodes[nid][0], 6), round(osm_nodes[nid][1], 6)] for nid in seg_nids]
            dist_km = polyline_km(geom)
            if dist_km < 0.005:
                continue

            travel_min = max(0.1, round((dist_km / speed_kmh) * 60.0, 2))
            u_osm, v_osm = seg_nids[0], seg_nids[-1]

            if street_name not in used_node_streets[u_osm]:
                used_node_streets[u_osm].append(street_name)
            if street_name not in used_node_streets[v_osm]:
                used_node_streets[v_osm].append(street_name)

            raw_edges.append({
                "u_osm": u_osm,
                "v_osm": v_osm,
                "name": street_name,
                "highway": highway,
                "distance_km": round(dist_km, 3),
                "travel_time": travel_min,
                "oneway": oneway,
                "open": True,
                "geometry": geom,
            })

    active_osm_ids = sorted({e["u_osm"] for e in raw_edges} | {e["v_osm"] for e in raw_edges})
    osm_to_id = {osm_id: f"N{idx + 1}" for idx, osm_id in enumerate(active_osm_ids)}

    temp_edges = [
        {
            "from": osm_to_id[e["u_osm"]],
            "to": osm_to_id[e["v_osm"]],
            "name": e["name"],
            "highway": e["highway"],
            "distance_km": e["distance_km"],
            "travel_time": e["travel_time"],
            "oneway": e["oneway"],
            "open": True,
            "geometry": e["geometry"],
        }
        for e in raw_edges
    ]

    scc = _largest_scc(list(osm_to_id.values()), temp_edges)
    use_wcc = len(scc) < 15
    comp = _largest_wcc(list(osm_to_id.values()), temp_edges) if use_wcc else scc

    filtered_edges = []
    for e in temp_edges:
        if e["from"] in comp and e["to"] in comp:
            if use_wcc:
                # Allow emergency bidirectional traversal in sparse town graphs.
                e = {**e, "oneway": False}
            filtered_edges.append(e)

    comp_osm_ids = sorted(
        [osm_id for osm_id, nid in osm_to_id.items() if nid in comp],
        key=lambda oid: int(osm_to_id[oid][1:]),
    )
    old_to_new = {osm_to_id[oid]: f"L{idx + 1}" for idx, oid in enumerate(comp_osm_ids)}

    locations: List[Dict[str, Any]] = []
    for idx, oid in enumerate(comp_osm_ids):
        lat, lon = osm_nodes[oid]
        unique_streets = []
        for s in used_node_streets[oid]:
            if s not in unique_streets:
                unique_streets.append(s)
        if len(unique_streets) >= 2:
            label = f"{unique_streets[0]} & {unique_streets[1]}"
        elif len(unique_streets) == 1:
            label = f"{unique_streets[0]} (Jct {idx + 1})"
        else:
            label = f"Road Junction {idx + 1}"

        locations.append({
            "id": f"L{idx + 1}",
            "name": label,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "streets": unique_streets[:3],
            "osm_id": oid,
        })

    roads: List[Dict[str, Any]] = [
        {
            "from": old_to_new[e["from"]],
            "to": old_to_new[e["to"]],
            "name": e["name"],
            "highway": e["highway"],
            "distance_km": e["distance_km"],
            "travel_time": e["travel_time"],
            "oneway": e["oneway"],
            "open": True,
            "geometry": e["geometry"],
        }
        for e in filtered_edges
    ]

    shelters: List[Dict[str, Any]] = []
    seen_pois: List[Tuple[str, float, float]] = []
    candidates = []

    for el in pois_elements:
        tags = el.get("tags", {})
        name = _clean_name(tags.get("name"))
        if not name or name.lower() in {"playground", "park", "block"}:
            continue
        if "hair transplant" in name.lower() or "ivf" in name.lower():
            continue

        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None or lon is None:
            continue
        lat, lon = float(lat), float(lon)

        raw_type = tags.get("amenity") or tags.get("leisure") or tags.get("railway") or "shelter"
        category, priority = CATEGORY_MAP.get(raw_type, ("Assembly Point", 12))

        norm = _normalize_poi_name(name)
        is_dup = any(
            haversine_km(lat, lon, prev_lat, prev_lon) < 0.25
            and (norm == prev_norm or norm in prev_norm or prev_norm in norm)
            for prev_norm, prev_lat, prev_lon in seen_pois
        )
        if is_dup:
            continue
        seen_pois.append((norm, lat, lon))

        candidates.append((priority, name, category, raw_type, lat, lon, tags))

    by_cat: Dict[str, List[Any]] = defaultdict(list)
    for item in sorted(candidates, key=lambda x: (x[0], x[1])):
        by_cat[item[2]].append(item)

    selected = []
    for cat in [
        "Fire & Rescue",
        "Emergency Shelter",
        "Transit Hub",
        "Stadium / Assembly",
        "Sports Complex",
        "Hospital",
        "University Campus",
        "College Campus",
        "Community Shelter",
        "Open Ground / Park",
        "Police Station",
        "Medical Clinic",
    ]:
        cap = 18 if cat == "Hospital" else 8
        selected.extend(by_cat.get(cat, [])[:cap])

    selected = sorted(selected[:max_shelters], key=lambda item: (item[0], item[1]))

    for idx, (_, name, category, raw_type, lat, lon, tags) in enumerate(selected):
        if not locations:
            break
        nearest_loc = min(
            locations,
            key=lambda loc: haversine_km(lat, lon, loc["lat"], loc["lon"]),
        )
        snap_km = round(haversine_km(lat, lon, nearest_loc["lat"], nearest_loc["lon"]), 3)

        beds = tags.get("beds") or tags.get("capacity")
        address_parts = [
            tags.get("addr:street"),
            tags.get("addr:suburb") or tags.get("addr:neighbourhood"),
            tags.get("addr:city"),
        ]
        address = ", ".join(p for p in address_parts if p) or nearest_loc["name"]

        shelters.append({
            "id": idx + 1,
            "name": name,
            "category": category,
            "osm_type": raw_type,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "node_id": nearest_loc["id"],
            "nearest_road": nearest_loc["name"],
            "distance_to_road_km": snap_km,
            "capacity": int(beds) if beds and str(beds).isdigit() else None,
            "address": address,
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "source": "OpenStreetMap",
        })

    node_lookup = {loc["id"]: loc for loc in locations}
    for shelter in shelters:
        if shelter["distance_to_road_km"] <= 0.16:
            node = node_lookup[shelter["node_id"]]
            if "(Jct" in node["name"] or "Road Junction" in node["name"]:
                street_hint = node["streets"][0] if node.get("streets") else ""
                node["name"] = (
                    f"{shelter['name']} ({street_hint})" if street_hint else shelter["name"]
                )

    return {
        "metadata": {
            "area": area_name,
            "country": "India" if "india" in area_name.lower() else "OpenStreetMap",
            "center": {"lat": round(center[0], 6), "lon": round(center[1], 6)},
            "source": "OpenStreetMap Overpass API",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "node_count": len(locations),
            "road_count": len(roads),
            "shelter_count": len(shelters),
        },
        "locations": locations,
        "roads": roads,
        "shelters": shelters,
    }


def _query_overpass(query: str) -> Dict[str, Any]:
    headers = {
        "User-Agent": "SafeRouteEvacuationPlanner/1.0",
        "Accept": "application/json",
    }
    last_error = None
    for url in OVERPASS_URLS:
        try:
            resp = httpx.post(url, data={"data": query}, headers=headers, timeout=18.0)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"All Overpass servers failed: {last_error}")


def reverse_geocode(lat: float, lon: float) -> str:
    """Resolve coordinates into a friendly City, State, Country label (India-ready)."""
    headers = {"User-Agent": "SafeRouteEvacuationPlanner/1.0"}
    try:
        resp = httpx.get(
            NOMINATIM_REVERSE_URL,
            params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 12},
            headers=headers,
            timeout=8.0,
        )
        resp.raise_for_status()
        data = resp.json()
        addr = data.get("address", {})
        parts = [
            addr.get("suburb") or addr.get("city_district") or addr.get("town") or addr.get("village"),
            addr.get("city") or addr.get("state_district"),
            addr.get("state"),
            addr.get("country"),
        ]
        cleaned = []
        for p in parts:
            if p and p not in cleaned:
                cleaned.append(p)
        if cleaned:
            return ", ".join(cleaned[:3])
        if data.get("display_name"):
            return ", ".join(data["display_name"].split(",")[:3]).strip()
    except Exception:
        pass
    return f"Live GPS Area ({lat:.4f}, {lon:.4f})"


def fetch_osm_area(
    lat: float,
    lon: float,
    radius_m: int = 2400,
    area_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Fetch live OpenStreetMap roads and emergency shelters around (lat, lon)."""
    resolved_name = area_name or reverse_geocode(lat, lon)

    def _run_fetch(r_m: int, include_minor: bool) -> Dict[str, Any]:
        dlat = r_m / 111320.0
        dlon = r_m / (111320.0 * max(0.2, math.cos(math.radians(lat))))
        bbox = f"{lat - dlat:.5f},{lon - dlon:.5f},{lat + dlat:.5f},{lon + dlon:.5f}"

        highway_regex = (
            "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"
            if include_minor
            else "^(motorway|trunk|primary|secondary|tertiary|trunk_link|primary_link|secondary_link)$"
        )
        roads_query = f"""
        [out:json][timeout:25];
        way["highway"~"{highway_regex}"]({bbox});
        out body;
        >;
        out skel qt;
        """
        pois_query = f"""
        [out:json][timeout:25];
        (
          node["amenity"~"^(hospital|clinic|fire_station|police|community_centre|shelter|bus_station|university|college)$"]({bbox});
          way["amenity"~"^(hospital|clinic|fire_station|police|community_centre|shelter|bus_station|university|college)$"]({bbox});
          node["leisure"~"^(stadium|sports_centre|park)$"]({bbox});
          way["leisure"~"^(stadium|sports_centre|park)$"]({bbox});
          node["railway"="station"]({bbox});
        );
        out center tags;
        """
        roads_data = _query_overpass(roads_query)
        pois_data = _query_overpass(pois_query)
        return build_graph_from_osm(
            roads_data.get("elements", []),
            pois_data.get("elements", []),
            area_name=resolved_name,
            center=(lat, lon),
        )

    graph = _run_fetch(radius_m, include_minor=False)
    if len(graph["locations"]) < 15:
        graph = _run_fetch(max(radius_m, 3200), include_minor=True)
    return graph


def geocode_place(query: str, country_code: Optional[str] = "in") -> Dict[str, Any]:
    """Geocode a real city or address using OpenStreetMap Nominatim (India-prioritized)."""
    headers = {"User-Agent": "SafeRouteEvacuationPlanner/1.0"}
    params: Dict[str, Any] = {"q": query, "format": "json", "limit": 5}
    if country_code:
        params["countrycodes"] = country_code

    resp = httpx.get(NOMINATIM_SEARCH_URL, params=params, headers=headers, timeout=15.0)
    resp.raise_for_status()
    results = resp.json()

    if not results and country_code:
        # Global fallback if the user explicitly typed an international city
        resp = httpx.get(
            NOMINATIM_SEARCH_URL,
            params={"q": query, "format": "json", "limit": 5},
            headers=headers,
            timeout=15.0,
        )
        resp.raise_for_status()
        results = resp.json()

    if not results:
        raise ValueError(f"Location '{query}' not found on OpenStreetMap")

    top = results[0]
    short_name = ", ".join(p.strip() for p in top.get("display_name", query).split(",")[:3])
    return {
        "display_name": short_name,
        "lat": float(top["lat"]),
        "lon": float(top["lon"]),
    }


def detect_approximate_india_location() -> Dict[str, Any]:
    """Best-effort IP location fallback (used only if browser GPS is blocked on desktop)."""
    try:
        resp = httpx.get("http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,lat,lon", timeout=6.0)
        if resp.status_code == 200:
            d = resp.json()
            if d.get("status") == "success":
                return {
                    "city": d.get("city", "Ludhiana"),
                    "region": d.get("regionName", "Punjab"),
                    "country": d.get("country", "India"),
                    "latitude": float(d["lat"]),
                    "longitude": float(d["lon"]),
                }
    except Exception:
        pass
    # Safe default: Ludhiana, Punjab, India
    return {
        "city": "Ludhiana",
        "region": "Punjab",
        "country": "India",
        "latitude": 30.9010,
        "longitude": 75.8573,
    }
