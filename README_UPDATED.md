# SafeRoute – Updated project

## Project structure
- `backend/main.py`: FastAPI APIs, live location receive/list/delete, nearest graph node, route execution, road open/close.
- `frontend/`: Leaflet interface, browser GPS tracking and route display.
- `cpp_engine/route_engine.cpp`: Existing C++ Dijkstra/A* routing engine.
- `data/graph.json`: Existing sample graph. It is NOT a verified real road/shelter dataset.

## Requirements
- Python 3.10+
- FastAPI and Uvicorn (`pip install -r backend/requirements.txt`)
- A C++17 compiler such as MinGW-w64 g++ on Windows
- Internet connection for Leaflet and OpenStreetMap tiles

## Run on Windows (PowerShell)
Open terminal in the project root:

```powershell
cd cpp_engine
g++ route_engine.cpp -o route_engine.exe -std=c++17
cd ..\backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload
```

Open a second terminal in the project root:

```powershell
cd frontend
py -m http.server 5500
```

Open `http://localhost:5500` in your browser. `localhost` is a secure context for browser geolocation. Allow location permission.

## Run on Linux/macOS
Compile `route_engine.cpp` to `cpp_engine/route_engine` (no `.exe` suffix), install requirements, then run Uvicorn from the `backend` directory. Serve `frontend` over localhost or HTTPS.

## Test flow
1. Open `http://127.0.0.1:8000/api/health` – should return healthy.
2. Open frontend at `http://localhost:5500`.
3. Press **Get My Live Location** and allow browser permission.
4. The frontend sends latitude/longitude to `POST /api/location` and asks `/api/nearest-location` to choose the nearest node from `graph.json`.
5. Enter a destination node ID such as `L5` and select A* or Dijkstra.

## Important limitations and safety
- The current `graph.json` contains sample locations/roads around Ludhiana and sample shelters. They are not verified real infrastructure and must not be relied on during an emergency.
- GPS is collected only after the user grants browser permission. Tracking ends when the user presses Stop Tracking or closes the page.
- Current live locations are stored in Python memory. They disappear on backend restart and are not shared across multiple backend worker processes. This is a development demo, not a production multi-user database.
- The displayed other-user locations are visible to anyone who can access this unauthenticated demo API. Do not deploy publicly until authentication, authorization, HTTPS, rate limits, retention controls and a persistent shared database are added.
- Browser GPS needs HTTPS or localhost. A phone cannot use `127.0.0.1` to reach the computer's backend; configure a reachable HTTPS backend URL for mobile testing.
- This implementation does not provide live traffic, confirmed road closures, dispatch, or certified safe routes. Verify shelters and routes with local emergency authorities.
- OpenStreetMap map tiles are a basemap only; they do not automatically update this project's road graph or calculate its evacuation route.
