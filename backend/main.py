import json
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from osm_builder import (
    detect_approximate_india_location,
    fetch_osm_area,
    geocode_place,
    haversine_km,
    reverse_geocode,
)

app = FastAPI(title="SafeRoute Emergency Evacuation Planner")

# Development CORS policy. Restrict allowed origins before public production deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "data" / "graph.json"
DEFAULT_DATA_FILE = ROOT / "data" / "default_graph.json"
FRONTEND_DIR = ROOT / "frontend"
ENGINE_NAME = "route_engine.exe" if os.name == "nt" else "route_engine"
CPP_ENGINE = ROOT / "cpp_engine" / ENGINE_NAME
lock = threading.RLock()

# In-memory live GPS telemetry and area sync throttle for current server session.
live_locations: Dict[str, Dict[str, Any]] = {}
_last_auto_osm_sync_at: float = 0.0


def load_data() -> Dict[str, Any]:
    if not DATA_FILE.exists():
        if DEFAULT_DATA_FILE.exists():
            shutil.copyfile(DEFAULT_DATA_FILE, DATA_FILE)
        else:
            raise HTTPException(500, "graph.json was not found")
    try:
        with DATA_FILE.open("r", encoding="utf-8") as file:
            return json.load(file)
    except json.JSONDecodeError as err:
        raise HTTPException(500, f"graph.json is corrupted: {err}")


def save_data(data: Dict[str, Any]) -> None:
    tmp_file = DATA_FILE.with_suffix(".tmp")
    with tmp_file.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=2)
    tmp_file.replace(DATA_FILE)


def run_cpp_engine(start: str, destination: str, algorithm: str) -> Dict[str, Any]:
    if not CPP_ENGINE.exists():
        raise HTTPException(
            500,
            f"C++ engine not found: {CPP_ENGINE}. Compile route_engine.cpp first.",
        )
    try:
        result = subprocess.run(
            [str(CPP_ENGINE), str(DATA_FILE), start, destination, algorithm],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if not result.stdout.strip():
            raise HTTPException(500, result.stderr.strip() or "C++ engine returned no output")
        output = json.loads(result.stdout)
        if result.returncode != 0 or output.get("status") == "error":
            raise HTTPException(500, output.get("message", "C++ engine failed"))
        return output
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Routing timed out")
    except json.JSONDecodeError:
        raise HTTPException(500, "Invalid JSON returned by C++ engine")
    except OSError as error:
        raise HTTPException(500, str(error))


def enrich_route_output(output: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    """Attach street-following polyline geometry and turn-by-turn street instructions."""
    if output.get("status") != "route_found":
        return output

    roads = data.get("roads", [])
    loc_map = {loc["id"]: loc for loc in data.get("locations", [])}
    path = output.get("path", [])
    road_indices = output.get("road_indices", [])

    polyline: List[List[float]] = []
    steps: List[Dict[str, Any]] = []
    total_distance = 0.0

    for step_idx, r_idx in enumerate(road_indices):
        if r_idx < 0 or r_idx >= len(roads):
            continue
        road = roads[r_idx]
        from_id = path[step_idx] if step_idx < len(path) else road["from"]
        to_id = path[step_idx + 1] if step_idx + 1 < len(path) else road["to"]

        geom = road.get("geometry")
        if not geom:
            u = loc_map.get(from_id)
            v = loc_map.get(to_id)
            geom = [[u["lat"], u["lon"]], [v["lat"], v["lon"]]] if (u and v) else []
        elif road["from"] != from_id:
            geom = list(reversed(geom))

        if geom:
            if not polyline:
                polyline.extend(geom)
            elif polyline[-1] == geom[0]:
                polyline.extend(geom[1:])
            else:
                polyline.extend(geom)

        seg_dist = road.get("distance_km")
        if seg_dist is None and len(geom) >= 2:
            seg_dist = sum(
                haversine_km(a[0], a[1], b[0], b[1]) for a, b in zip(geom, geom[1:])
            )
        seg_dist = float(seg_dist or 0.0)
        seg_time = float(road.get("travel_time", 0.0))
        total_distance += seg_dist

        street_name = road.get("name", "Road Segment")
        highway = road.get("highway", "road")

        if steps and steps[-1]["street"] == street_name:
            steps[-1]["distance_km"] = round(steps[-1]["distance_km"] + seg_dist, 3)
            steps[-1]["travel_time_min"] = round(steps[-1]["travel_time_min"] + seg_time, 2)
            steps[-1]["to_node"] = to_id
            steps[-1]["road_indices"].append(r_idx)
        else:
            steps.append({
                "street": street_name,
                "highway": highway,
                "distance_km": round(seg_dist, 3),
                "travel_time_min": round(seg_time, 2),
                "from_node": from_id,
                "to_node": to_id,
                "road_indices": [r_idx],
            })

    if total_distance == 0.0:
        coords = output.get("coordinates", [])
        for first, second in zip(coords, coords[1:]):
            total_distance += haversine_km(
                first["latitude"], first["longitude"],
                second["latitude"], second["longitude"],
            )

    output["distance_km"] = round(total_distance, 2)
    output["travel_time"] = round(float(output.get("estimated_travel_time", 0)), 2)
    output["route_geometry"] = polyline
    output["steps"] = steps
    return output


def _find_nearest_node(locations: List[Dict[str, Any]], lat: float, lon: float) -> Dict[str, Any]:
    if not locations:
        raise HTTPException(404, "No road nodes are available")
    nearest = min(
        locations,
        key=lambda item: haversine_km(lat, lon, item["lat"], item["lon"]),
    )
    distance = haversine_km(lat, lon, nearest["lat"], nearest["lon"])
    return {
        "id": nearest["id"],
        "name": nearest["name"],
        "lat": nearest["lat"],
        "lon": nearest["lon"],
        "distance_km": round(distance, 3),
    }


class RouteRequest(BaseModel):
    start: str
    destination: str
    algorithm: str = "astar"
    compare: bool = True


class NearestShelterRequest(BaseModel):
    start: str
    algorithm: str = "astar"


class RoadRequest(BaseModel):
    index: int = Field(ge=0)
    action: str


class LocationRequest(BaseModel):
    user_id: str = Field(min_length=1, max_length=100)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy: float = Field(ge=0)
    auto_load_osm: bool = False


class OsmLoadRequest(BaseModel):
    query: Optional[str] = None
    latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    radius_m: int = Field(default=2400, ge=800, le=4500)


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)


@app.get("/api/status")
def status():
    return {"status": "online", "project": "SafeRoute", "region": "India"}


@app.get("/api/health")
def health():
    return {
        "status": "healthy",
        "cpp_engine_ready": CPP_ENGINE.exists(),
        "data_ready": DATA_FILE.exists(),
    }


@app.get("/api/map")
def get_map():
    with lock:
        return load_data()


@app.get("/api/shelters")
def get_shelters():
    with lock:
        return load_data().get("shelters", [])


@app.get("/api/ip-location")
def get_ip_location():
    """Approximate city/coordinates in India when browser GPS permission is blocked."""
    return detect_approximate_india_location()


@app.post("/api/location")
def update_location(request: LocationRequest):
    global _last_auto_osm_sync_at
    location = {
        "user_id": request.user_id,
        "latitude": request.latitude,
        "longitude": request.longitude,
        "accuracy": request.accuracy,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    with lock:
        live_locations[request.user_id] = location
        data = load_data()

    nearest = _find_nearest_node(data.get("locations", []), request.latitude, request.longitude)
    area_switched = False
    area_name = data.get("metadata", {}).get("area", "Active Area")
    auto_sync_error = None

    # If user is > 6 km away from active map (e.g. another Indian city) and auto_load_osm is enabled,
    # automatically load real OpenStreetMap roads & shelters around their live GPS.
    if request.auto_load_osm and nearest["distance_km"] > 6.0:
        now = time.time()
        if now - _last_auto_osm_sync_at > 20.0:
            _last_auto_osm_sync_at = now
            try:
                place_label = reverse_geocode(request.latitude, request.longitude)
                new_graph = fetch_osm_area(
                    request.latitude,
                    request.longitude,
                    radius_m=1800,
                    area_name=place_label,
                )
                if len(new_graph.get("locations", [])) >= 2:
                    with lock:
                        save_data(new_graph)
                        data = new_graph
                    nearest = _find_nearest_node(
                        data.get("locations", []), request.latitude, request.longitude
                    )
                    area_switched = True
                    area_name = place_label
            except Exception as err:
                auto_sync_error = str(err)

    return {
        "status": "success",
        "message": "Location updated",
        "area_switched": area_switched,
        "area_name": area_name,
        "nearest_node": nearest,
        "auto_sync_error": auto_sync_error,
    }


@app.get("/api/locations")
def get_live_locations():
    with lock:
        return list(live_locations.values())


@app.delete("/api/location/{user_id}")
def delete_location(user_id: str):
    with lock:
        existed = live_locations.pop(user_id, None) is not None
    return {"status": "success", "deleted": existed}


@app.get("/api/nearest-location")
def nearest_location(
    latitude: float = Query(..., ge=-90, le=90),
    longitude: float = Query(..., ge=-180, le=180),
):
    with lock:
        locations = load_data().get("locations", [])
    return _find_nearest_node(locations, latitude, longitude)


@app.post("/api/routes")
def calculate_route(request: RouteRequest):
    if request.algorithm not in ["astar", "dijkstra"]:
        raise HTTPException(400, "Choose astar or dijkstra")
    if request.start == request.destination:
        raise HTTPException(400, "Start and destination junctions must be different")

    with lock:
        data = load_data()
        ids = {item["id"] for item in data.get("locations", [])}
        if request.start not in ids or request.destination not in ids:
            raise HTTPException(400, "Unknown location ID")

        output = run_cpp_engine(request.start, request.destination, request.algorithm)
        output = enrich_route_output(output, data)

        if request.compare and output.get("status") == "route_found":
            other_algo = "dijkstra" if request.algorithm == "astar" else "astar"
            other_out = run_cpp_engine(request.start, request.destination, other_algo)
            output["comparison"] = {
                request.algorithm: {
                    "nodes_explored": output.get("nodes_explored"),
                    "compute_time_ms": output.get("compute_time_ms"),
                    "travel_time": output.get("travel_time"),
                },
                other_algo: {
                    "nodes_explored": other_out.get("nodes_explored"),
                    "compute_time_ms": other_out.get("compute_time_ms"),
                    "travel_time": round(float(other_out.get("estimated_travel_time", 0)), 2),
                },
            }
        return output


@app.post("/api/routes/nearest-shelter")
def route_to_nearest_shelter(request: NearestShelterRequest):
    if request.algorithm not in ["astar", "dijkstra"]:
        raise HTTPException(400, "Choose astar or dijkstra")

    with lock:
        data = load_data()
        loc_map = {loc["id"]: loc for loc in data.get("locations", [])}
        if request.start not in loc_map:
            raise HTTPException(400, "Unknown starting location ID")
        shelters = data.get("shelters", [])
        if not shelters:
            raise HTTPException(404, "No shelters available in current map")

        start_loc = loc_map[request.start]

        # If user's snapped junction IS already a shelter access junction, return immediate arrival.
        at_node = [s for s in shelters if s.get("node_id") == request.start]
        if at_node:
            s0 = at_node[0]
            return {
                "status": "route_found",
                "algorithm": request.algorithm,
                "already_at_shelter": True,
                "target_shelter": s0,
                "path": [request.start],
                "road_indices": [],
                "nodes_explored": 1,
                "compute_time_ms": 0.0,
                "distance_km": s0.get("distance_to_road_km", 0.0),
                "travel_time": 0.0,
                "route_geometry": [[start_loc["lat"], start_loc["lon"]], [s0["lat"], s0["lon"]]],
                "steps": [
                    {
                        "street": f"Arrive directly at {s0['name']}",
                        "highway": "shelter",
                        "distance_km": s0.get("distance_to_road_km", 0.0),
                        "travel_time_min": 0.0,
                        "from_node": request.start,
                        "to_node": request.start,
                        "road_indices": [],
                    }
                ],
            }

        ranked = sorted(
            [s for s in shelters if s.get("node_id") in loc_map],
            key=lambda s: haversine_km(start_loc["lat"], start_loc["lon"], s["lat"], s["lon"]),
        )[:8]

        best_route = None
        best_shelter = None
        for shelter in ranked:
            res = run_cpp_engine(request.start, shelter["node_id"], request.algorithm)
            if res.get("status") == "route_found":
                if best_route is None or res["estimated_travel_time"] < best_route["estimated_travel_time"]:
                    best_route = res
                    best_shelter = shelter

        if not best_route or not best_shelter:
            raise HTTPException(404, "No reachable shelter found with currently open roads")

        best_route = enrich_route_output(best_route, data)
        best_route["target_shelter"] = best_shelter
        return best_route


@app.post("/api/roads")
def update_road(request: RoadRequest):
    if request.action not in ["open", "close"]:
        raise HTTPException(400, "Action must be open or close")
    with lock:
        data = load_data()
        roads = data.get("roads", [])
        if request.index >= len(roads):
            raise HTTPException(404, "Road not found")
        roads[request.index]["open"] = request.action == "open"
        save_data(data)
        closed_count = sum(1 for r in roads if not r.get("open", True))
    return {
        "status": "updated",
        "index": request.index,
        "action": request.action,
        "road_name": roads[request.index].get("name", "Road"),
        "closed_count": closed_count,
    }


@app.post("/api/roads/reset")
def reset_all_roads():
    with lock:
        data = load_data()
        for road in data.get("roads", []):
            road["open"] = True
        save_data(data)
    return {"status": "reset", "open_roads": len(data.get("roads", []))}


@app.post("/api/osm/load")
def load_live_osm_area(request: OsmLoadRequest):
    try:
        if request.query:
            place = geocode_place(request.query, country_code="in")
            lat, lon = place["lat"], place["lon"]
            area_name = place["display_name"]
        elif request.latitude is not None and request.longitude is not None:
            lat, lon = request.latitude, request.longitude
            area_name = reverse_geocode(lat, lon)
        else:
            raise HTTPException(400, "Provide either a place query or latitude/longitude")

        new_graph = fetch_osm_area(lat, lon, radius_m=request.radius_m, area_name=area_name)
        if len(new_graph.get("locations", [])) < 2:
            raise HTTPException(404, "Not enough connected roads found in OpenStreetMap for this area")

        with lock:
            save_data(new_graph)
        return {
            "status": "loaded",
            "metadata": new_graph["metadata"],
        }
    except HTTPException:
        raise
    except ValueError as err:
        raise HTTPException(404, str(err))
    except Exception as err:
        raise HTTPException(502, f"OpenStreetMap fetch failed: {err}")


@app.post("/api/osm/reset")
def reset_to_default_osm():
    if not DEFAULT_DATA_FILE.exists():
        raise HTTPException(404, "Default Ludhiana OSM dataset not found")
    with lock:
        shutil.copyfile(DEFAULT_DATA_FILE, DATA_FILE)
        data = load_data()
    return {
        "status": "reset",
        "metadata": data.get("metadata", {}),
    }


@app.get("/")
def serve_index():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"status": "online", "project": "SafeRoute"}


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR)), name="frontend")
