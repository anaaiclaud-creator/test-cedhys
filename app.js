// ── Configuration ──────────────────────────────────────────────
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const OSRM      = 'https://router.project-osrm.org/route/v1/driving';
const IRVE_API  = 'https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/bornes-irve/records';

// ── State ───────────────────────────────────────────────────────
let map, routeLayer, startMarker, endMarker;
let stationMarkers = [];
let activeCard = null;
let suggestTimeout = {};

// ── Map init ────────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { zoomControl: true }).setView([46.8, 2.5], 6);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
}

// ── Icons ───────────────────────────────────────────────────────
function cityIcon(color, emoji) {
  return L.divIcon({
    className: '',
    html: `<div style="
      background:${color}; color:white; width:36px; height:36px;
      border-radius:50% 50% 50% 0; transform:rotate(-45deg);
      border:3px solid white; box-shadow:0 2px 8px rgba(0,0,0,.3);
      display:flex; align-items:center; justify-content:center;
    "><span style="transform:rotate(45deg);font-size:15px">${emoji}</span></div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -38],
  });
}

function stationIcon(color = '#22c55e') {
  return L.divIcon({
    className: '',
    html: `<div style="
      background:${color}; color:white; width:28px; height:28px;
      border-radius:50%; border:2.5px solid white;
      box-shadow:0 2px 6px rgba(0,0,0,.25);
      display:flex; align-items:center; justify-content:center;
      font-size:13px;
    ">⚡</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  });
}

// ── Geocoding ───────────────────────────────────────────────────
async function geocode(city) {
  const params = new URLSearchParams({
    q: city,
    format: 'json',
    countrycodes: 'fr',
    limit: 1,
    addressdetails: 1,
  });
  const res = await fetch(`${NOMINATIM}/search?${params}`, {
    headers: { 'Accept-Language': 'fr' },
  });
  if (!res.ok) throw new Error('Erreur de géocodage');
  const data = await res.json();
  if (!data.length) throw new Error(`Ville introuvable : "${city}"`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display: data[0].display_name };
}

async function suggest(query, listEl) {
  if (query.length < 2) { listEl.innerHTML = ''; listEl.classList.add('hidden'); return; }
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    countrycodes: 'fr',
    limit: 6,
    addressdetails: 1,
    featuretype: 'city',
  });
  try {
    const res = await fetch(`${NOMINATIM}/search?${params}`, {
      headers: { 'Accept-Language': 'fr' },
    });
    const data = await res.json();
    if (!data.length) { listEl.innerHTML = ''; listEl.classList.add('hidden'); return; }

    listEl.innerHTML = data.map((d, i) => {
      const name = d.name || d.display_name.split(',')[0];
      const dept = d.address?.county || d.address?.state || '';
      return `<li data-idx="${i}" data-name="${name}" data-lat="${d.lat}" data-lon="${d.lon}">
        <span>🏙️</span>
        <span><span class="sug-name">${name}</span> <span class="sug-dept">${dept}</span></span>
      </li>`;
    }).join('');
    listEl.classList.remove('hidden');
  } catch (_) {
    listEl.classList.add('hidden');
  }
}

// ── Routing via OSRM ────────────────────────────────────────────
async function getRoute(start, end) {
  const url = `${OSRM}/${start.lon},${start.lat};${end.lon},${end.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Erreur de calcul d\'itinéraire');
  const data = await res.json();
  if (data.code !== 'Ok') throw new Error('Itinéraire introuvable');
  return data.routes[0];
}

// ── Bounding box helper ─────────────────────────────────────────
function routeBbox(coords, paddingKm) {
  const pad = paddingKm / 111;
  const lats = coords.map(c => c[1]);
  const lons = coords.map(c => c[0]);
  return {
    minLat: Math.min(...lats) - pad,
    maxLat: Math.max(...lats) + pad,
    minLon: Math.min(...lons) - pad,
    maxLon: Math.max(...lons) + pad,
  };
}

// ── Point-to-segment distance (degrees, approx) ─────────────────
function pointToSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function isNearRoute(lat, lon, routeCoords, maxKm) {
  const maxDeg = maxKm / 111;
  for (let i = 0; i < routeCoords.length - 1; i++) {
    const [ax, ay] = routeCoords[i];
    const [bx, by] = routeCoords[i + 1];
    if (pointToSegDist(lon, lat, ax, ay, bx, by) <= maxDeg) return true;
  }
  return false;
}

// ── Fetch stations from IRVE API ────────────────────────────────
async function fetchStations(bbox, routeCoords, radiusKm) {
  const where = `lat_station >= ${bbox.minLat} AND lat_station <= ${bbox.maxLat} AND lon_station >= ${bbox.minLon} AND lon_station <= ${bbox.maxLon}`;

  let allRecords = [];
  let offset = 0;
  const limit = 100;

  // Fetch up to 500 records (5 pages) to avoid rate limits
  while (allRecords.length < 500) {
    const params = new URLSearchParams({
      where,
      limit,
      offset,
      select: 'n_station,ad_station,nbre_pdc,puiss_max,prise_type_ef,prise_type_2,prise_type_combo_ccs,prise_type_chademo,lat_station,lon_station,date_maj,condition_acces',
    });

    const res = await fetch(`${IRVE_API}?${params}`);
    if (!res.ok) break;
    const data = await res.json();
    if (!data.results || data.results.length === 0) break;
    allRecords = allRecords.concat(data.results);
    if (data.results.length < limit) break;
    offset += limit;
  }

  // Filter by proximity to route
  return allRecords.filter(r => {
    const lat = parseFloat(r.lat_station);
    const lon = parseFloat(r.lon_station);
    if (isNaN(lat) || isNaN(lon)) return false;
    return isNearRoute(lat, lon, routeCoords, radiusKm);
  });
}

// ── Format duration ─────────────────────────────────────────────
function fmtDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${m} min`;
}

function fmtDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(0)} km` : `${meters} m`;
}

// ── Connector labels ────────────────────────────────────────────
function connectors(station) {
  const tags = [];
  if (station.prise_type_ef)         tags.push('EF');
  if (station.prise_type_2)          tags.push('T2');
  if (station.prise_type_combo_ccs)  tags.push('CCS');
  if (station.prise_type_chademo)    tags.push('CHAdeMO');
  return tags;
}

// ── Render station card ─────────────────────────────────────────
function renderCard(station, idx) {
  const name    = station.n_station || 'Borne de recharge';
  const address = station.ad_station || '';
  const pdc     = station.nbre_pdc   ? `${station.nbre_pdc} point${station.nbre_pdc > 1 ? 's' : ''}` : '';
  const power   = station.puiss_max  ? `${station.puiss_max} kW` : '';
  const access  = station.condition_acces === 'Accès libre' ? 'Accès libre' : (station.condition_acces || '');
  const tags    = connectors(station);
  const isOpen  = station.condition_acces === 'Accès libre';

  const tagsHtml = [
    pdc   && `<span class="station-tag">🔌 ${pdc}</span>`,
    power && `<span class="station-tag">⚡ ${power} kW</span>`,
    access && `<span class="station-tag">${isOpen ? '🔓' : '🔒'} ${access}</span>`,
    ...tags.map(t => `<span class="station-tag">${t}</span>`),
  ].filter(Boolean).join('');

  return `<div class="station-card" data-idx="${idx}">
    <div class="station-top">
      <div class="station-name">${name}</div>
      <span class="station-badge badge-${isOpen ? 'available' : 'unknown'}">${isOpen ? 'Libre' : 'Accès restreint'}</span>
    </div>
    ${address ? `<div class="station-address">📍 ${address}</div>` : ''}
    <div class="station-meta">${tagsHtml}</div>
  </div>`;
}

// ── Main search ─────────────────────────────────────────────────
async function search(e) {
  e.preventDefault();
  clearResults();

  const startVal  = document.getElementById('city-start').value.trim();
  const endVal    = document.getElementById('city-end').value.trim();
  const radiusKm  = parseInt(document.getElementById('radius').value);

  if (!startVal || !endVal) return;

  setLoading(true);

  try {
    // 1. Geocode cities
    const [startCoord, endCoord] = await Promise.all([geocode(startVal), geocode(endVal)]);

    // 2. Get route
    const route = await getRoute(startCoord, endCoord);
    const routeCoords = route.geometry.coordinates; // [[lon,lat], ...]

    // 3. Draw route
    drawRoute(routeCoords, startCoord, endCoord);

    // Update chips
    document.getElementById('chip-distance').textContent = `📏 ${fmtDistance(route.distance)}`;
    document.getElementById('chip-duration').textContent = `⏱ ${fmtDuration(route.duration)}`;

    // 4. Fetch stations
    const bbox = routeBbox(routeCoords, radiusKm + 5);
    const stations = await fetchStations(bbox, routeCoords, radiusKm);

    document.getElementById('chip-count').textContent = `⚡ ${stations.length} borne${stations.length !== 1 ? 's' : ''}`;
    document.getElementById('results').classList.remove('hidden');

    if (stations.length === 0) {
      document.getElementById('stations-list').innerHTML =
        `<p style="color:var(--gray-400);font-size:13px;text-align:center;padding:20px 0">
          Aucune borne trouvée dans ce rayon.<br>Essayez d'augmenter le rayon de recherche.
        </p>`;
    } else {
      renderStations(stations);
    }

  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

// ── Draw route on map ───────────────────────────────────────────
function drawRoute(coords, startCoord, endCoord) {
  if (routeLayer) map.removeLayer(routeLayer);
  if (startMarker) map.removeLayer(startMarker);
  if (endMarker) map.removeLayer(endMarker);

  const latlngs = coords.map(([lon, lat]) => [lat, lon]);

  routeLayer = L.polyline(latlngs, {
    color: '#3b82f6',
    weight: 5,
    opacity: .8,
    dashArray: null,
  }).addTo(map);

  startMarker = L.marker([startCoord.lat, startCoord.lon], { icon: cityIcon('#22c55e', '🚗') })
    .addTo(map)
    .bindPopup(`<b>Départ</b><br>${startCoord.display.split(',')[0]}`);

  endMarker = L.marker([endCoord.lat, endCoord.lon], { icon: cityIcon('#ef4444', '📍') })
    .addTo(map)
    .bindPopup(`<b>Arrivée</b><br>${endCoord.display.split(',')[0]}`);

  map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
}

// ── Render stations on map and in list ─────────────────────────
function renderStations(stations) {
  // Remove old markers
  stationMarkers.forEach(m => map.removeLayer(m));
  stationMarkers = [];

  const listEl = document.getElementById('stations-list');
  listEl.innerHTML = stations.map((s, i) => renderCard(s, i)).join('');

  stations.forEach((s, i) => {
    const lat = parseFloat(s.lat_station);
    const lon = parseFloat(s.lon_station);
    if (isNaN(lat) || isNaN(lon)) return;

    const marker = L.marker([lat, lon], { icon: stationIcon() })
      .addTo(map)
      .bindPopup(popupContent(s));

    marker.on('click', () => highlightCard(i));
    stationMarkers.push(marker);
  });

  // Card click → fly to marker
  listEl.querySelectorAll('.station-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.idx);
      const s = stations[idx];
      const lat = parseFloat(s.lat_station);
      const lon = parseFloat(s.lon_station);
      if (!isNaN(lat) && !isNaN(lon)) {
        map.flyTo([lat, lon], 16, { duration: .8 });
        stationMarkers[idx]?.openPopup();
      }
      highlightCard(idx);
    });
  });
}

function popupContent(s) {
  const name  = s.n_station || 'Borne de recharge';
  const addr  = s.ad_station ? `<br>📍 ${s.ad_station}` : '';
  const pdc   = s.nbre_pdc  ? `<br>🔌 ${s.nbre_pdc} point(s)` : '';
  const power = s.puiss_max ? `<br>⚡ ${s.puiss_max} kW` : '';
  const tags  = connectors(s).join(', ');
  return `<b>${name}</b>${addr}${pdc}${power}${tags ? `<br>${tags}` : ''}`;
}

function highlightCard(idx) {
  if (activeCard) activeCard.classList.remove('active');
  const card = document.querySelector(`.station-card[data-idx="${idx}"]`);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    activeCard = card;
  }
}

// ── UI helpers ──────────────────────────────────────────────────
function setLoading(on) {
  document.getElementById('search-btn').disabled = on;
  document.getElementById('btn-text').textContent = on ? 'Recherche en cours…' : 'Rechercher les bornes';
  document.getElementById('btn-spinner').classList.toggle('hidden', !on);
}

function clearResults() {
  document.getElementById('results').classList.add('hidden');
  document.getElementById('error-msg').classList.add('hidden');
  document.getElementById('stations-list').innerHTML = '';
  stationMarkers.forEach(m => map.removeLayer(m));
  stationMarkers = [];
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = `⚠️ ${msg}`;
  el.classList.remove('hidden');
}

// ── Autocomplete setup ──────────────────────────────────────────
function setupAutocomplete(inputId, listId) {
  const input = document.getElementById(inputId);
  const list  = document.getElementById(listId);

  input.addEventListener('input', () => {
    clearTimeout(suggestTimeout[inputId]);
    suggestTimeout[inputId] = setTimeout(() => suggest(input.value, list), 300);
  });

  list.addEventListener('mousedown', e => {
    const li = e.target.closest('li');
    if (!li) return;
    input.value = li.dataset.name;
    list.innerHTML = '';
    list.classList.add('hidden');
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !list.contains(e.target)) {
      list.classList.add('hidden');
    }
  });
}

// ── Radius slider ───────────────────────────────────────────────
document.getElementById('radius').addEventListener('input', function () {
  document.getElementById('radius-value').textContent = `${this.value} km`;
});

// ── Boot ────────────────────────────────────────────────────────
initMap();
setupAutocomplete('city-start', 'suggestions-start');
setupAutocomplete('city-end', 'suggestions-end');
document.getElementById('route-form').addEventListener('submit', search);
