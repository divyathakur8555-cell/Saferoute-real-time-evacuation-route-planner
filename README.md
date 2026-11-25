# SafeRoute — Real-Data Emergency Evacuation Planner

A real-world road-network evacuation routing system combining a **C++14 A* / Dijkstra graph engine**, a **FastAPI backend**, **real OpenStreetMap road & emergency facility data**, browser **GPS telemetry**, and an interactive **Leaflet** command interface.

## Project Structure

```text
SafeRoute_Attractive_Updated_Project/
├── backend/
│   ├── main.py              # FastAPI server, C++ engine runner, road closures & static UI
│   ├── osm_builder.py       # Real OpenStreetMap Overpass/Nominatim graph builder
│   └── requirements.txt
├── cpp_engine/
│   ├── route_engine.cpp     # C++ A* and Dijkstra shortest-time router
│   ├── route_engine.exe     # Pre-built Windows binary
│   └── json.hpp             # nlohmann::json header
├── data/
│   ├── graph.json           # Active real OpenStreetMap Ludhiana dataset
│   └── default_graph.json   # Backup copy of default Ludhiana OSM dataset
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── script.js
├── build_engine.bat         # Recompile route_engine.exe (g++ -std=c++14 -O2)
├── start_backend.bat        # Start FastAPI server (serves API + Web UI on port 8000)
└── start_frontend.bat       # Optional standalone static server on port 5500
```

## Key Features

- **Real OpenStreetMap Data**: Preloaded with real Ludhiana road segments (`548` junctions, `721` road segments with street names & speed-profile travel times) and `60` real hospitals, fire stations, transit hubs, stadiums, colleges, and parks.
- **Live City / GPS OSM Loader**: Search any city (e.g. Chandigarh, Amritsar, Delhi) or click **Load Near My GPS** to fetch live OpenStreetMap roads and shelters around any location.
- **C++ Routing & Benchmarking**: Computes routes in milliseconds with both **A*** and **Dijkstra**, displaying nodes explored and compute time side-by-side.
- **Interactive Road Blockage Simulator**: Click any street on the map (or **Block Active Route**) to simulate closures and watch routes automatically recalculate around blocked roads.
- **Turn-by-Turn Street Directions & Shelter Directory**: Filter real emergency facilities by category and route to the fastest reachable shelter in one click.

## Quick Start (Windows)

1. Double-click `start_backend.bat` (or run from terminal):
   ```powershell
   cd backend
   python -m pip install -r requirements.txt
   python -m uvicorn main:app --reload
   ```
2. Open **http://localhost:8000** in your browser (`localhost` supports browser GPS permission).
   *(Optionally, you can also run `start_frontend.bat` and open `http://localhost:5500`.)*

To recompile the C++ engine manually:
```powershell
g++ .\cpp_engine\route_engine.cpp -o .\cpp_engine\route_engine.exe -std=c++14 -O2
```
