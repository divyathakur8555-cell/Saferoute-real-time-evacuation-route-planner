const API_URL =
  window.location.protocol.startsWith("http") && window.location.port === "8000"
    ? window.location.origin
    : "http://127.0.0.1:8000";

let map = null;
let baseTileLayer = null;
let roadLayer = null;
let nodeLayer = null;
let shelterLayer = null;
let routeLayer = null;
let routeEndpointLayer = null;
let otherUsersLayer = null;
let userMarker = null;
let userAccuracyCircle = null;

let watchId = null;
let otherUsersTimer = null;
let currentPosition = null;
let mapPickMode = null; // "start" | "destination" | null
let mapData = null;
let activeRouteParams = null; // { start, destination, type: "point" | "nearest-shelter" }

const userId = sessionStorage.getItem("safeRouteUserId") || crypto.randomUUID();
sessionStorage.setItem("safeRouteUserId", userId);

const BASEMAPS = {
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
  },
  hot: {
    url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors, HOT",
  },
  topo: {
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors, SRTM | OpenTopoMap",
  },
};

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[ch]);
}

function setStatus(id, message, tone = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message;
  el.className = "status-line" + (tone ? ` ${tone}` : "");
}

function initializeMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true }).setView([30.901, 75.8573], 14);
  changeBasemap();

  roadLayer = L.layerGroup().addTo(map);
  nodeLayer = L.layerGroup().addTo(map);
  shelterLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  routeEndpointLayer = L.layerGroup().addTo(map);
  otherUsersLayer = L.layerGroup().addTo(map);

  map.on("click", handleMapClick);
}

function changeBasemap() {
  if (!map) return;
  const key = document.getElementById("basemapSelect")?.value || "osm";
  const cfg = BASEMAPS[key] || BASEMAPS.osm;
  if (baseTileLayer) map.removeLayer(baseTileLayer);
  baseTileLayer = L.tileLayer(cfg.url, {
    attribution: cfg.attribution,
    maxZoom: 19,
  }).addTo(map);
}

function makePinIcon(label, className, size = 28) {
  return L.divIcon({
    className: "",
    html: `<div class="custom-pin ${className}" style="width:${size}px;height:${size}px">${escapeHTML(label)}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

function getShelterPinStyle(category) {
  const c = (category || "").toLowerCase();
  if (c.includes("hospital") || c.includes("clinic")) return { label: "+", cls: "pin-hospital" };
  if (c.includes("fire")) return { label: "F", cls: "pin-fire" };
  if (c.includes("transit")) return { label: "T", cls: "pin-transit" };
  return { label: "S", cls: "pin-shelter" };
}

async function checkHealth() {
  try {
    const res = await fetch(`${API_URL}/api/health`);
    if (!res.ok) throw new Error();
    const health = await res.json();
    const pill = document.getElementById("engineStatusPill");
    if (pill) {
      pill.textContent = health.cpp_engine_ready
        ? "C++ Engine Online"
        : "C++ Engine Missing";
    }
  } catch {
    const pill = document.getElementById("engineStatusPill");
    if (pill) pill.textContent = "Backend Offline";
  }
}

async function loadMapData(fitToNetwork = true) {
  try {
    const response = await fetch(`${API_URL}/api/map`);
    if (!response.ok) throw new Error("Unable to load map data");
    mapData = await response.json();
    initializeMap();

    renderNetworkOnMap(fitToNetwork);
    populateLocationDropdowns();
    populateShelterCategoryFilter();
    renderShelterList();
    renderClosedRoadsList();
    updateHeaderStats();
  } catch (error) {
    console.error(error);
    setStatus("routeStatus", "Failed to load map data. Make sure the FastAPI backend is running on port 8000.", "error");
  }
}

function updateHeaderStats() {
  if (!mapData) return;
  const meta = mapData.metadata || {};
  const locations = mapData.locations || [];
  const roads = mapData.roads || [];
  const shelters = mapData.shelters || [];
  const closedCount = roads.filter((r) => r.open === false).length;

  document.getElementById("activeAreaText").textContent =
    `${meta.area || "OpenStreetMap Area"} • ${locations.length} junctions`;
  document.getElementById("statNodes").textContent = locations.length;
  document.getElementById("statRoads").textContent = roads.length;
  document.getElementById("statClosedRoads").textContent = `${closedCount} blocked`;
  document.getElementById("statShelters").textContent = shelters.length;
  document.getElementById("shelterTabCount").textContent = shelters.length;
}

function renderNetworkOnMap(fitBounds = false) {
  if (!mapData || !map) return;
  roadLayer.clearLayers();
  nodeLayer.clearLayers();
  shelterLayer.clearLayers();

  const locMap = new Map((mapData.locations || []).map((loc) => [loc.id, loc]));
  const boundsPts = [];

  (mapData.roads || []).forEach((road, idx) => {
    const u = locMap.get(road.from);
    const v = locMap.get(road.to);
    const pts = Array.isArray(road.geometry) && road.geometry.length >= 2
      ? road.geometry
      : u && v
      ? [[u.lat, u.lon], [v.lat, v.lon]]
      : [];
    if (pts.length < 2) return;

    const isOpen = road.open !== false;
    const style = isOpen
      ? { color: "#475569", weight: 3.5, opacity: 0.65 }
      : { color: "#dc2626", weight: 5, opacity: 0.9, dashArray: "7 6" };

    const poly = L.polyline(pts, style).addTo(roadLayer);
    const nextAction = isOpen ? "close" : "open";
    const actionLabel = isOpen ? "Block / Close Road" : "Reopen Road";
    const btnColor = isOpen ? "#dc2626" : "#059669";

    poly.bindPopup(`
      <div style="min-width:200px;font-family:Plus Jakarta Sans,sans-serif">
        <strong style="font-size:13px">${escapeHTML(road.name || "Road Segment")}</strong><br>
        <span style="font-size:11px;color:#64748b">
          Type: ${escapeHTML(road.highway || "road")} &bull;
          ${road.distance_km ?? "?"} km &bull;
          ${road.travel_time ?? "?"} min
          ${road.oneway ? " &bull; One-way" : ""}
        </span><br>
        <div style="margin-top:6px;font-size:11px;font-weight:700;color:${isOpen ? "#059669" : "#dc2626"}">
          Status: ${isOpen ? "OPEN" : "BLOCKED"}
        </div>
        <button onclick="toggleRoadState(${idx}, '${nextAction}')"
          style="margin-top:8px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:${btnColor};color:#fff;font-weight:700;cursor:pointer;">
          ${actionLabel}
        </button>
      </div>
    `);
  });

  (mapData.locations || []).forEach((loc) => {
    const lat = Number(loc.lat);
    const lon = Number(loc.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    boundsPts.push([lat, lon]);

    L.circleMarker([lat, lon], {
      radius: 4,
      color: "#1d4ed8",
      weight: 1.5,
      fillColor: "#60a5fa",
      fillOpacity: 0.75,
    })
      .bindPopup(`
        <div style="font-family:Plus Jakarta Sans,sans-serif">
          <strong>${escapeHTML(loc.id)} &mdash; ${escapeHTML(loc.name)}</strong><br>
          <div style="display:flex;gap:6px;margin-top:8px">
            <button onclick="setNodeSelection('start', '${escapeHTML(loc.id)}')"
              style="padding:5px 9px;border:none;border-radius:6px;background:#16a34a;color:#fff;font-size:11px;font-weight:700;cursor:pointer">
              Set Start
            </button>
            <button onclick="setNodeSelection('destination', '${escapeHTML(loc.id)}')"
              style="padding:5px 9px;border:none;border-radius:6px;background:#2563eb;color:#fff;font-size:11px;font-weight:700;cursor:pointer">
              Set Destination
            </button>
          </div>
        </div>
      `)
      .addTo(nodeLayer);
  });

  toggleNodeMarkers();

  (mapData.shelters || []).forEach((shelter) => {
    const lat = Number(shelter.lat);
    const lon = Number(shelter.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const pin = getShelterPinStyle(shelter.category);

    L.marker([lat, lon], { icon: makePinIcon(pin.label, pin.cls, 28) })
      .bindPopup(`
        <div style="min-width:210px;font-family:Plus Jakarta Sans,sans-serif">
          <span style="font-size:10px;font-weight:800;text-transform:uppercase;color:#0f766e">${escapeHTML(shelter.category)}</span><br>
          <strong style="font-size:13px">${escapeHTML(shelter.name)}</strong><br>
          <span style="font-size:11px;color:#64748b">
            Nearest junction: ${escapeHTML(shelter.node_id)} (${escapeHTML(shelter.nearest_road || "")})<br>
            ${shelter.address ? `Address: ${escapeHTML(shelter.address)}<br>` : ""}
            ${shelter.phone ? `Phone: ${escapeHTML(shelter.phone)}<br>` : ""}
            ${shelter.capacity ? `Reported capacity/beds: ${escapeHTML(shelter.capacity)}` : "Source: OpenStreetMap"}
          </span>
          <button onclick="routeToShelter('${escapeHTML(shelter.node_id)}', '${escapeHTML(shelter.name)}')"
            style="margin-top:8px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:#059669;color:#fff;font-weight:700;cursor:pointer;">
            Evacuate to This Hub
          </button>
        </div>
      `)
      .addTo(shelterLayer);
  });

  if (fitBounds && boundsPts.length > 1) {
    map.fitBounds(boundsPts, { padding: [30, 30] });
  }
}

function toggleNodeMarkers() {
  if (!map || !nodeLayer) return;
  const show = document.getElementById("toggleNodes")?.checked ?? true;
  if (show) {
    if (!map.hasLayer(nodeLayer)) map.addLayer(nodeLayer);
  } else {
    if (map.hasLayer(nodeLayer)) map.removeLayer(nodeLayer);
  }
}

function populateLocationDropdowns() {
  const startSel = document.getElementById("startLocation");
  const destSel = document.getElementById("destinationLocation");
  const locations = mapData?.locations || [];
  const shelters = mapData?.shelters || [];

  const prevStart = startSel.value;
  const prevDest = destSel.value;

  const optionsHtml = locations
    .map((loc) => `<option value="${escapeHTML(loc.id)}">${escapeHTML(loc.id)} &mdash; ${escapeHTML(loc.name)}</option>`)
    .join("");

  startSel.innerHTML = optionsHtml;
  destSel.innerHTML = optionsHtml;

  const ids = new Set(locations.map((l) => l.id));
  if (ids.has(prevStart)) {
    startSel.value = prevStart;
  } else if (locations.length > 0) {
    startSel.value = locations[0].id;
  }

  if (ids.has(prevDest) && prevDest !== startSel.value) {
    destSel.value = prevDest;
  } else if (shelters.length > 0 && ids.has(shelters[0].node_id) && shelters[0].node_id !== startSel.value) {
    destSel.value = shelters[0].node_id;
  } else if (locations.length > 1) {
    destSel.value = locations[Math.min(locations.length - 1, 15)].id;
  }
}

function populateShelterCategoryFilter() {
  const sel = document.getElementById("shelterCategoryFilter");
  const cats = Array.from(new Set((mapData?.shelters || []).map((s) => s.category))).sort();
  sel.innerHTML =
    `<option value="ALL">All Categories (${(mapData?.shelters || []).length})</option>` +
    cats.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("");
}

function renderShelterList() {
  const grid = document.getElementById("shelterGrid");
  const search = (document.getElementById("shelterSearch")?.value || "").trim().toLowerCase();
  const cat = document.getElementById("shelterCategoryFilter")?.value || "ALL";
  const shelters = (mapData?.shelters || []).filter((s) => {
    const matchCat = cat === "ALL" || s.category === cat;
    const text = `${s.name} ${s.category} ${s.address || ""} ${s.nearest_road || ""}`.toLowerCase();
    return matchCat && (!search || text.includes(search));
  });

  if (shelters.length === 0) {
    grid.innerHTML = `<p class="empty-state">No matching shelters or hospitals in the current area.</p>`;
    return;
  }

  grid.innerHTML = shelters
    .map(
      (s) => `
      <div class="shelter-card">
        <div>
          <span class="shelter-cat">${escapeHTML(s.category)}</span>
          <h4>${escapeHTML(s.name)}</h4>
          <p class="shelter-meta">
            Node ${escapeHTML(s.node_id)} &bull; ${escapeHTML(s.nearest_road || "Road Access")}<br>
            ${s.capacity ? `Capacity/Beds: ${escapeHTML(s.capacity)}` : `Road snap: ${s.distance_to_road_km} km`}
          </p>
        </div>
        <div class="shelter-actions">
          <button class="btn btn-light" type="button" onclick="focusOnPoint(${s.lat}, ${s.lon})">Locate</button>
          <button class="btn btn-emerald" type="button" onclick="routeToShelter('${escapeHTML(s.node_id)}', '${escapeHTML(s.name)}')">Evacuate Here</button>
        </div>
      </div>`
    )
    .join("");
}

function renderClosedRoadsList() {
  const container = document.getElementById("closedRoadsList");
  const roads = mapData?.roads || [];
  const closed = roads
    .map((road, index) => ({ road, index }))
    .filter((item) => item.road.open === false);

  if (closed.length === 0) {
    container.innerHTML = `<p class="empty-state">All ${roads.length} road segments are currently open. Click any street on the map to block it.</p>`;
    return;
  }

  container.innerHTML = closed
    .map(
      ({ road, index }) => `
      <div class="closed-road-item">
        <span><strong>${escapeHTML(road.name)}</strong> (${escapeHTML(road.from)}&rarr;${escapeHTML(road.to)})</span>
        <button type="button" onclick="toggleRoadState(${index}, 'open')">Reopen</button>
      </div>`
    )
    .join("");
}

function focusOnPoint(lat, lon) {
  initializeMap();
  map.setView([lat, lon], 16, { animate: true });
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
}

function setNodeSelection(target, nodeId) {
  const selectId = target === "start" ? "startLocation" : "destinationLocation";
  const select = document.getElementById(selectId);
  if (select) {
    select.value = nodeId;
    setStatus("routeStatus", `Selected ${nodeId} as ${target}.`, "success");
  }
  map.closePopup();
}

function swapLocations() {
  const startSel = document.getElementById("startLocation");
  const destSel = document.getElementById("destinationLocation");
  const tmp = startSel.value;
  startSel.value = destSel.value;
  destSel.value = tmp;
  if (activeRouteParams?.type === "point") {
    findRoute();
  }
}

function toggleMapPick(mode) {
  if (mapPickMode === mode) mode = null;
  mapPickMode = mode;

  const banner = document.getElementById("mapPickBanner");
  const text = document.getElementById("mapPickText");
  document.getElementById("pickStartBtn").classList.toggle("active", mode === "start");
  document.getElementById("pickDestBtn").classList.toggle("active", mode === "destination");

  if (mode) {
    banner.classList.remove("hidden");
    text.textContent = `Click anywhere on the map to snap the nearest junction as ${mode.toUpperCase()}...`;
  } else {
    banner.classList.add("hidden");
  }
}

async function handleMapClick(event) {
  if (!mapPickMode) return;
  const { lat, lng } = event.latlng;
  const target = mapPickMode;
  toggleMapPick(null);

  try {
    const res = await fetch(
      `${API_URL}/api/nearest-location?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}`
    );
    if (!res.ok) throw new Error("Could not snap to nearest junction");
    const nearest = await res.json();
    const sel = document.getElementById(target === "start" ? "startLocation" : "destinationLocation");
    sel.value = nearest.id;
    setStatus(
      "routeStatus",
      `Snapped ${target} to ${nearest.id} (${nearest.name}, ${nearest.distance_km} km from click).`,
      "success"
    );
  } catch (err) {
    setStatus("routeStatus", err.message, "error");
  }
}

async function toggleRoadState(index, action) {
  try {
    const res = await fetch(`${API_URL}/api/roads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index, action }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Road update failed");

    map.closePopup();
    await loadMapData(false);
    setStatus(
      "routeStatus",
      `${data.road_name} marked ${action === "close" ? "BLOCKED" : "OPEN"}.`,
      action === "close" ? "error" : "success"
    );

    // Automatically recalculate active route so user sees live rerouting!
    if (activeRouteParams) {
      if (activeRouteParams.type === "nearest-shelter") {
        await findNearestShelterRoute();
      } else {
        await findRoute();
      }
    }
  } catch (err) {
    setStatus("routeStatus", err.message, "error");
  }
}

async function resetAllRoads() {
  try {
    const res = await fetch(`${API_URL}/api/roads/reset`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to reset roads");
    await loadMapData(false);
    setStatus("routeStatus", "All roads reopened.", "success");
    if (activeRouteParams) {
      if (activeRouteParams.type === "nearest-shelter") await findNearestShelterRoute();
      else await findRoute();
    }
  } catch (err) {
    setStatus("routeStatus", err.message, "error");
  }
}

async function simulateRouteBlockage() {
  if (!activeRouteParams || !window._lastRoadIndices || window._lastRoadIndices.length === 0) {
    setStatus("routeStatus", "Calculate a route first, then click Block Active Route to test rerouting.", "error");
    return;
  }
  const midIdx = window._lastRoadIndices[Math.floor(window._lastRoadIndices.length / 2)];
  await toggleRoadState(midIdx, "close");
}

function displayRouteOnMap(result) {
  initializeMap();
  routeLayer.clearLayers();
  routeEndpointLayer.clearLayers();

  const pts =
    Array.isArray(result.route_geometry) && result.route_geometry.length >= 2
      ? result.route_geometry
      : (result.coordinates || []).map((c) => [Number(c.latitude), Number(c.longitude)]);

  if (pts.length < 2) throw new Error("Insufficient route coordinates returned.");

  // Glow under-stroke + crisp emerald route line
  L.polyline(pts, { color: "#065f46", weight: 9, opacity: 0.35 }).addTo(routeLayer);
  const mainLine = L.polyline(pts, { color: "#10b981", weight: 5, opacity: 0.96 }).addTo(routeLayer);

  const startPt = pts[0];
  const endPt = pts[pts.length - 1];
  L.marker(startPt, { icon: makePinIcon("START", "pin-start", 38) })
    .bindPopup("Route Start")
    .addTo(routeEndpointLayer);
  L.marker(endPt, { icon: makePinIcon("SAFE", "pin-end", 38) })
    .bindPopup("Evacuation Destination")
    .addTo(routeEndpointLayer);

  map.fitBounds(mainLine.getBounds(), { padding: [50, 50] });
}

function renderRouteSummary(result, extraTitle = "") {
  const details = document.getElementById("routeDetails");
  const dist = Number(result.distance_km);
  const eta = Number(result.travel_time);
  const cmp = result.comparison || {};
  const astar = cmp.astar;
  const dijkstra = cmp.dijkstra;

  let compareHtml = "";
  if (astar && dijkstra) {
    const astarBetter = astar.nodes_explored <= dijkstra.nodes_explored;
    compareHtml = `
      <div class="algo-compare">
        <div class="algo-compare-title">C++ Engine Benchmark: A* vs Dijkstra</div>
        <div class="compare-grid">
          <div class="compare-card ${astarBetter ? "winner" : ""}">
            <strong>A* Search</strong><br>
            Explored: <b>${astar.nodes_explored}</b> nodes<br>
            Time: ${astar.compute_time_ms} ms
          </div>
          <div class="compare-card ${!astarBetter ? "winner" : ""}">
            <strong>Dijkstra</strong><br>
            Explored: <b>${dijkstra.nodes_explored}</b> nodes<br>
            Time: ${dijkstra.compute_time_ms} ms
          </div>
        </div>
      </div>`;
  }

  details.innerHTML = `
    ${extraTitle ? `<p style="font-size:12px;font-weight:800;color:#0f766e;margin-bottom:8px">${escapeHTML(extraTitle)}</p>` : ""}
    <div class="route-kpis">
      <div class="kpi-box">
        <span>Total Distance</span>
        <strong>${Number.isFinite(dist) ? dist.toFixed(2) + " km" : "N/A"}</strong>
      </div>
      <div class="kpi-box">
        <span>Est. Travel Time</span>
        <strong>${Number.isFinite(eta) ? eta.toFixed(1) + " min" : "N/A"}</strong>
      </div>
      <div class="kpi-box">
        <span>Junction Hops</span>
        <strong>${Array.isArray(result.path) ? result.path.length : 0}</strong>
      </div>
      <div class="kpi-box">
        <span>Nodes Scanned</span>
        <strong>${result.nodes_explored ?? "--"}</strong>
      </div>
    </div>
    <p style="font-size:11px;color:#475569">
      Algorithm: <strong>${escapeHTML((result.algorithm || "").toUpperCase())}</strong> &bull;
      Compute: ${result.compute_time_ms ?? 0} ms
    </p>
    ${compareHtml}
  `;

  renderDirectionsSteps(result.steps || []);
}

function renderDirectionsSteps(steps) {
  document.getElementById("stepsTabCount").textContent = steps.length;
  const list = document.getElementById("directionsList");
  if (!steps.length) {
    list.innerHTML = `<p class="empty-state">No turn-by-turn street steps available.</p>`;
    return;
  }
  list.innerHTML = steps
    .map(
      (step, i) => `
      <div class="direction-step">
        <div class="step-left">
          <span class="step-num">${i + 1}</span>
          <div>
            <div class="step-street">${escapeHTML(step.street)}</div>
            <div class="step-highway">${escapeHTML((step.highway || "").replace("_", " "))} &bull; ${escapeHTML(step.from_node)} &rarr; ${escapeHTML(step.to_node)}</div>
          </div>
        </div>
        <div class="step-metrics">
          ${Number(step.distance_km).toFixed(2)} km<br>
          ${Number(step.travel_time_min).toFixed(1)} min
        </div>
      </div>`
    )
    .join("");
}

async function findRoute() {
  const start = document.getElementById("startLocation").value.trim();
  const destination = document.getElementById("destinationLocation").value.trim();
  const algorithm = document.getElementById("algorithm").value;
  const btn = document.getElementById("routeButton");

  if (!start || !destination) {
    return setStatus("routeStatus", "Select both a starting junction and a destination.", "error");
  }
  if (start === destination) {
    return setStatus("routeStatus", "Start and destination junctions must be different.", "error");
  }

  btn.disabled = true;
  setStatus("routeStatus", "Running C++ routing engine...");

  try {
    const res = await fetch(`${API_URL}/api/routes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start, destination, algorithm, compare: true }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || "Route calculation failed");
    if (result.status !== "route_found") {
      routeLayer.clearLayers();
      routeEndpointLayer.clearLayers();
      window._lastRoadIndices = [];
      throw new Error("No open route found! Try reopening blocked roads.");
    }

    activeRouteParams = { start, destination, type: "point" };
    window._lastRoadIndices = result.road_indices || [];
    displayRouteOnMap(result);
    renderRouteSummary(result);
    setStatus("routeStatus", `Route found across ${result.steps?.length || 0} street segments.`, "success");
  } catch (err) {
    setStatus("routeStatus", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function routeToShelter(nodeId, shelterName) {
  document.getElementById("destinationLocation").value = nodeId;
  await findRoute();
  if (shelterName) {
    setStatus("routeStatus", `Evacuation route plotted to ${shelterName} (${nodeId}).`, "success");
  }
  document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function findNearestShelterRoute() {
  const start = document.getElementById("startLocation").value.trim();
  const algorithm = document.getElementById("algorithm").value;
  const btn = document.getElementById("nearestShelterBtn");
  if (!start) return setStatus("routeStatus", "Select a starting junction first.", "error");

  btn.disabled = true;
  setStatus("routeStatus", "Searching fastest reachable emergency shelter...");
  try {
    const res = await fetch(`${API_URL}/api/routes/nearest-shelter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start, algorithm }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || "Could not find reachable shelter");

    const shelter = result.target_shelter;
    if (shelter?.node_id) {
      document.getElementById("destinationLocation").value = shelter.node_id;
    }
    activeRouteParams = { start, destination: shelter?.node_id, type: "nearest-shelter" };
    window._lastRoadIndices = result.road_indices || [];
    displayRouteOnMap(result);
    renderRouteSummary(result, `Nearest Hub: ${shelter.name} (${shelter.category})`);
    setStatus("routeStatus", `Fastest shelter: ${shelter.name} (${result.travel_time} min).`, "success");
    switchTab("directions");
  } catch (err) {
    setStatus("routeStatus", err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/* Live OpenStreetMap City / GPS Loader */
async function loadOsmByQuery() {
  const query = document.getElementById("osmSearchInput").value.trim();
  if (!query) return;
  const btn = document.getElementById("osmSearchBtn");
  btn.disabled = true;
  btn.textContent = "Loading...";
  setStatus("routeStatus", `Fetching real OpenStreetMap roads & shelters for "${query}"...`);

  try {
    const res = await fetch(`${API_URL}/api/osm/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, radius_m: 2200 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to load OSM area");

    activeRouteParams = null;
    routeLayer.clearLayers();
    routeEndpointLayer.clearLayers();
    document.getElementById("routeDetails").innerHTML = "";
    await loadMapData(true);
    setStatus("routeStatus", `Loaded real OpenStreetMap network for ${data.metadata.area}.`, "success");
  } catch (err) {
    setStatus("routeStatus", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Load City";
  }
}

async function loadOsmNearGps() {
  if (!currentPosition) {
    setStatus("locationStatus", "Click 'Get My Live Location' first so we have your GPS coordinates.", "error");
    return;
  }
  const btn = document.getElementById("osmGpsBtn");
  btn.disabled = true;
  btn.textContent = "Fetching OSM...";
  setStatus("routeStatus", "Fetching real OpenStreetMap roads & shelters around your GPS...");

  try {
    const res = await fetch(`${API_URL}/api/osm/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        latitude: currentPosition.latitude,
        longitude: currentPosition.longitude,
        radius_m: 2200,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to load OSM around GPS");

    activeRouteParams = null;
    routeLayer.clearLayers();
    routeEndpointLayer.clearLayers();
    document.getElementById("routeDetails").innerHTML = "";
    await loadMapData(true);

    const nearestRes = await fetch(
      `${API_URL}/api/nearest-location?latitude=${encodeURIComponent(currentPosition.latitude)}&longitude=${encodeURIComponent(currentPosition.longitude)}`
    );
    if (nearestRes.ok) {
      const nearest = await nearestRes.json();
      document.getElementById("startLocation").value = nearest.id;
    }
    setStatus("routeStatus", `Loaded live OpenStreetMap roads around your GPS (${data.metadata.node_count} junctions).`, "success");
  } catch (err) {
    setStatus("routeStatus", err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Load Near My GPS";
  }
}

async function resetDefaultOsm() {
  try {
    const res = await fetch(`${API_URL}/api/osm/reset`, { method: "POST" });
    if (!res.ok) throw new Error("Failed to reset map");
    activeRouteParams = null;
    routeLayer.clearLayers();
    routeEndpointLayer.clearLayers();
    document.getElementById("routeDetails").innerHTML = "";
    await loadMapData(true);
    setStatus("routeStatus", "Restored Ludhiana real OpenStreetMap dataset.", "success");
  } catch (err) {
    setStatus("routeStatus", err.message, "error");
  }
}

/* Browser GPS Telemetry & Automatic India Area Sync */
let _hasSyncedAreaOnce = false;

async function applyLiveCoordinates(lat, lon, acc, sourceLabel = "GPS") {
  currentPosition = { latitude: lat, longitude: lon };

  document.getElementById("coordinates").textContent =
    `${sourceLabel}: Lat ${lat.toFixed(6)}, Lon ${lon.toFixed(6)} (±${Math.round(acc)} m)`;

  initializeMap();
  if (userMarker) userMarker.setLatLng([lat, lon]);
  else {
    userMarker = L.marker([lat, lon], {
      icon: makePinIcon("YOU", "pin-transit", 32),
    })
      .addTo(map)
      .bindPopup("Your live location");
  }

  if (userAccuracyCircle) {
    userAccuracyCircle.setLatLng([lat, lon]).setRadius(acc);
  } else {
    userAccuracyCircle = L.circle([lat, lon], {
      radius: acc,
      color: "#2563eb",
      fillColor: "#3b82f6",
      fillOpacity: 0.14,
      weight: 1,
    }).addTo(map);
  }

  try {
    setStatus("locationStatus", "Syncing live location with SafeRoute backend...");
    const res = await fetch(`${API_URL}/api/location`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        latitude: lat,
        longitude: lon,
        accuracy: acc,
        auto_load_osm: !_hasSyncedAreaOnce,
      }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.detail || "Backend rejected location update");

    if (payload.area_switched) {
      _hasSyncedAreaOnce = true;
      activeRouteParams = null;
      routeLayer.clearLayers();
      routeEndpointLayer.clearLayers();
      document.getElementById("routeDetails").innerHTML = "";
      await loadMapData(false);
    }

    const nearest = payload.nearest_node;
    if (nearest?.id) {
      document.getElementById("startLocation").value = nearest.id;
    }

    if (nearest && nearest.distance_km <= 8) {
      map.setView([lat, lon], 15);
      setStatus(
        "locationStatus",
        `${sourceLabel} active in ${payload.area_name}. Start snapped to ${nearest.id} (${nearest.name}, ${nearest.distance_km} km away).`,
        "success"
      );
    } else if (payload.auto_sync_error) {
      setStatus(
        "locationStatus",
        `${sourceLabel} captured (${nearest?.distance_km ?? "?"} km from current map). Click "Load Near My GPS" to retry live OSM load.`,
        "error"
      );
    } else {
      setStatus(
        "locationStatus",
        `${sourceLabel} active (${nearest?.distance_km ?? "?"} km from current map). Click "Load Near My GPS" to load roads around you.`,
        "success"
      );
    }
  } catch (err) {
    console.error(err);
    setStatus("locationStatus", `${sourceLabel} captured locally, but backend sync failed: ${err.message}`, "error");
  }
}

async function sendLocation(position) {
  await applyLiveCoordinates(
    position.coords.latitude,
    position.coords.longitude,
    position.coords.accuracy || 50,
    "GPS"
  );
}

async function useApproxIndiaLocation() {
  const btn = document.getElementById("ipLocButton");
  if (btn) btn.disabled = true;
  setStatus("locationStatus", "Detecting your approximate city location in India...");
  try {
    const res = await fetch(`${API_URL}/api/ip-location`);
    if (!res.ok) throw new Error("Could not detect city location");
    const loc = await res.json();
    _hasSyncedAreaOnce = false;
    await applyLiveCoordinates(loc.latitude, loc.longitude, 1500, `${loc.city}, ${loc.country}`);
  } catch (err) {
    setStatus("locationStatus", err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function startLiveLocation() {
  if (!navigator.geolocation) {
    return setStatus("locationStatus", "Geolocation is not supported by this browser. Try Auto-Detect City instead.", "error");
  }
  if (watchId !== null) return;

  _hasSyncedAreaOnce = false;
  setStatus("locationStatus", "Requesting browser location permission...");
  watchId = navigator.geolocation.watchPosition(
    sendLocation,
    (error) => {
      setStatus("locationStatus", `GPS unavailable (${error.message}). You can click "Auto-Detect City" instead.`, "error");
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
  document.getElementById("locationButton").disabled = true;
  document.getElementById("stopButton").disabled = false;
  loadOtherUsers();
  otherUsersTimer = setInterval(loadOtherUsers, 5000);
}

async function stopLiveLocation() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (otherUsersTimer !== null) {
    clearInterval(otherUsersTimer);
    otherUsersTimer = null;
  }
  try {
    await fetch(`${API_URL}/api/location/${encodeURIComponent(userId)}`, { method: "DELETE" });
  } catch (err) {
    console.warn(err);
  }
  if (userMarker && map) {
    map.removeLayer(userMarker);
    userMarker = null;
  }
  if (userAccuracyCircle && map) {
    map.removeLayer(userAccuracyCircle);
    userAccuracyCircle = null;
  }
  setStatus("locationStatus", "GPS tracking stopped.");
  document.getElementById("locationButton").disabled = false;
  document.getElementById("stopButton").disabled = true;
}

async function loadOtherUsers() {
  try {
    const res = await fetch(`${API_URL}/api/locations`);
    if (!res.ok) return;
    const users = await res.json();
    otherUsersLayer.clearLayers();
    users.forEach((user) => {
      if (user.user_id === userId) return;
      const lat = Number(user.latitude);
      const lon = Number(user.longitude);
      const updated = Date.parse(user.updated_at);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(updated)) return;
      if (Date.now() - updated > 60000) return;

      L.circleMarker([lat, lon], {
        radius: 8,
        color: "#dc2626",
        fillColor: "#ef4444",
        fillOpacity: 0.85,
      })
        .bindPopup(`Active Device: ${escapeHTML(user.user_id.slice(0, 8))}...`)
        .addTo(otherUsersLayer);
    });
  } catch (err) {
    console.error("Failed to load other users", err);
  }
}

function switchTab(tab) {
  const isShelters = tab === "shelters";
  document.getElementById("tabSheltersBtn").classList.toggle("active", isShelters);
  document.getElementById("tabDirectionsBtn").classList.toggle("active", !isShelters);
  document.getElementById("tabShelters").classList.toggle("active", isShelters);
  document.getElementById("tabDirections").classList.toggle("active", !isShelters);
}

document.addEventListener("DOMContentLoaded", async () => {
  initializeMap();
  checkHealth();
  await loadMapData(true);

  const params = new URLSearchParams(window.location.search);
  const startParam = params.get("start");
  const destParam = params.get("dest");
  if (startParam && destParam) {
    const startSel = document.getElementById("startLocation");
    const destSel = document.getElementById("destinationLocation");
    if (startSel && destSel) {
      startSel.value = startParam;
      destSel.value = destParam;
      await findRoute();
    }
  }

  const searchInput = document.getElementById("osmSearchInput");
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadOsmByQuery();
    });
  }
});
