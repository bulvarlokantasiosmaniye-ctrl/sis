/* =====================================================
   SeismoWatch — script.js  v3.0
   Multi-Source Global Earthquake Monitor
   Sources: USGS · EMSC · GeoNet · INGV · BGS
   ===================================================== */

'use strict';

// ── Data Sources ───────────────────────────────────────
const SOURCES = {
  usgs: {
    name: 'USGS',
    flag: '🇺🇸',
    color: '#3b82f6',
    priority: 1,
    feeds: {
      hour:  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
      day:   'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
      week:  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson',
      month: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson',
    },
    parser: parseUSGS,
    status: 'unknown', // 'ok' | 'error' | 'unknown'
    lastSuccess: null,
    count: 0
  },
  emsc: {
    name: 'EMSC',
    flag: '🇪🇺',
    color: '#22c55e',
    priority: 2,
    feeds: {
      // EMSC FDSN WebService — public, no key needed
      hour:  'https://www.seismicportal.eu/fdsnws/event/1/query?limit=100&format=json&orderby=time&minmag=-1&starttime=HOUR_AGO',
      day:   'https://www.seismicportal.eu/fdsnws/event/1/query?limit=500&format=json&orderby=time&minmag=-1&starttime=DAY_AGO',
      week:  'https://www.seismicportal.eu/fdsnws/event/1/query?limit=1000&format=json&orderby=time&minmag=2&starttime=WEEK_AGO',
      month: 'https://www.seismicportal.eu/fdsnws/event/1/query?limit=1000&format=json&orderby=time&minmag=4&starttime=MONTH_AGO',
    },
    parser: parseEMSC,
    status: 'unknown',
    lastSuccess: null,
    count: 0
  },
  geonet: {
    name: 'GeoNet NZ',
    flag: '🇳🇿',
    color: '#f59e0b',
    priority: 3,
    feeds: {
      // GeoNet FDSN – covers Pacific/NZ/Oceania well
      hour:  'https://service.geonet.org.nz/fdsnws/event/1/query?format=geojson&limit=100&orderby=time&starttime=HOUR_AGO',
      day:   'https://service.geonet.org.nz/fdsnws/event/1/query?format=geojson&limit=500&orderby=time&minmagnitude=1&starttime=DAY_AGO',
      week:  'https://service.geonet.org.nz/fdsnws/event/1/query?format=geojson&limit=500&orderby=time&minmagnitude=2&starttime=WEEK_AGO',
      month: 'https://service.geonet.org.nz/fdsnws/event/1/query?format=geojson&limit=500&orderby=time&minmagnitude=3&starttime=MONTH_AGO',
    },
    parser: parseGeoJSON, // GeoJSON compatible
    status: 'unknown',
    lastSuccess: null,
    count: 0
  },
  ingv: {
    name: 'INGV',
    flag: '🇮🇹',
    color: '#a855f7',
    priority: 4,
    feeds: {
      // Italian National Institute of Geophysics – Mediterranean focus
      hour:  'https://webservices.ingv.it/fdsnws/event/1/query?format=geojson&limit=100&orderby=time&starttime=HOUR_AGO',
      day:   'https://webservices.ingv.it/fdsnws/event/1/query?format=geojson&limit=500&orderby=time&minmagnitude=1&starttime=DAY_AGO',
      week:  'https://webservices.ingv.it/fdsnws/event/1/query?format=geojson&limit=500&orderby=time&minmagnitude=2&starttime=WEEK_AGO',
      month: 'https://webservices.ingv.it/fdsnws/event/1/query?format=geojson&limit=500&orderby=time&minmagnitude=3&starttime=MONTH_AGO',
    },
    parser: parseGeoJSON,
    status: 'unknown',
    lastSuccess: null,
    count: 0
  }
};

// ── Dedup Config ───────────────────────────────────────
const DEDUP_DISTANCE_KM  = 50;   // Max distance between same event from 2 sources
const DEDUP_TIME_WINDOW  = 120;  // Seconds window for same event
const DEDUP_MAG_DIFF     = 0.5;  // Max magnitude difference

// ── Constants ──────────────────────────────────────────
const REFRESH_INTERVAL  = 30 * 1000;
const PAGE_SIZE         = 25;
const RECENT_PAGE_SIZE  = 30;

// ── State ──────────────────────────────────────────────
let state = {
  raw: [],
  filtered: [],
  period: 'day',
  minMag: 0,
  search: '',
  sortBy: 'time',
  page: 1,
  isDark: true,
  countdown: REFRESH_INTERVAL / 1000,
  refreshTimer: null,
  countdownTimer: null,
  recentCountdownTimer: null,
  charts: {},
  deferredInstallPrompt: null,
  autoRefresh: true,
  lastFetchTime: null,
  recentSortBy: 'time',
  errorCount: 0,
  lastError: null,
  consistencyWarnings: [],
  enabledSources: new Set(Object.keys(SOURCES)),
  sourceStats: {},
  dedupStats: { total: 0, removed: 0 }
};

let map, markerCluster;

// ── Time helpers for URL templates ────────────────────
function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, '');
}
function buildFeedUrl(tpl, period) {
  const map = {
    HOUR_AGO:  isoAgo(3600000),
    DAY_AGO:   isoAgo(86400000),
    WEEK_AGO:  isoAgo(7 * 86400000),
    MONTH_AGO: isoAgo(30 * 86400000),
  };
  return tpl.replace(/HOUR_AGO|DAY_AGO|WEEK_AGO|MONTH_AGO/g, m => map[m] || m);
}

// ── Parsers ────────────────────────────────────────────
function parseUSGS(json) {
  return (json.features || []).map(f => ({
    id:         `usgs_${f.id}`,
    sourceId:   f.id,
    source:     'usgs',
    lat:        f.geometry?.coordinates?.[1],
    lng:        f.geometry?.coordinates?.[0],
    depth:      f.geometry?.coordinates?.[2] ?? 0,
    mag:        f.properties.mag ?? 0,
    place:      f.properties.place || 'Unknown',
    time:       f.properties.time,
    type:       f.properties.type || 'earthquake',
    status:     f.properties.status || '',
    tsunami:    !!f.properties.tsunami,
    alert:      f.properties.alert || '',
    felt:       f.properties.felt || 0,
    net:        f.properties.net || 'USGS',
    url:        f.properties.url || '',
    raw:        f
  })).filter(e => e.lat != null && e.lng != null);
}

function parseEMSC(json) {
  // EMSC returns { type: "FeatureCollection", features: [...] }
  const features = json.features || [];
  return features.map(f => {
    const p = f.properties || {};
    const coords = f.geometry?.coordinates || [];
    return {
      id:       `emsc_${f.id || p.unid || (coords[0]+coords[1]+p.time)}`,
      sourceId: f.id || p.unid || '',
      source:   'emsc',
      lat:      coords[1],
      lng:      coords[0],
      depth:    coords[2] ?? (p.depth || 0),
      mag:      p.mag ?? p.magnitude ?? 0,
      place:    p.flynn_region || p.place || p.region || 'Unknown',
      time:     p.time ? new Date(p.time).getTime() : (p.lastupdate ? new Date(p.lastupdate).getTime() : Date.now()),
      type:     'earthquake',
      status:   p.evtype || '',
      tsunami:  false,
      alert:    '',
      felt:     0,
      net:      'EMSC',
      url:      `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid || ''}`,
      raw:      f
    };
  }).filter(e => e.lat != null && e.lng != null);
}

function parseGeoJSON(json) {
  // Standard GeoJSON FeatureCollection (GeoNet, INGV)
  const features = json.features || [];
  return features.map(f => {
    const p = f.properties || {};
    const coords = f.geometry?.coordinates || [];
    const srcName = f._source || 'global';
    return {
      id:       `${srcName}_${f.id || p.publicID || (coords.join('_'))}`,
      sourceId: f.id || p.publicID || '',
      source:   srcName,
      lat:      coords[1],
      lng:      coords[0],
      depth:    coords[2] ?? (p.depth || 0),
      mag:      p.mag ?? p.magnitude?.mag ?? p.ML ?? 0,
      place:    p.place || p.flynn_region || p.description?.text || 'Unknown',
      time:     p.time ? new Date(p.time).getTime() : Date.now(),
      type:     p.type || 'earthquake',
      status:   p.status || '',
      tsunami:  false,
      alert:    '',
      felt:     0,
      net:      p.net || srcName.toUpperCase(),
      url:      p.url || '',
      raw:      f
    };
  }).filter(e => e.lat != null && e.lng != null);
}

// ── Deduplication ──────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function deduplicateEvents(events) {
  // Sort by source priority so higher-priority source is kept
  events.sort((a, b) => {
    const pa = SOURCES[a.source]?.priority ?? 99;
    const pb = SOURCES[b.source]?.priority ?? 99;
    return pa - pb || b.time - a.time;
  });

  const kept = [];
  let removedCount = 0;

  for (const ev of events) {
    let isDuplicate = false;
    for (const k of kept) {
      const timeDiff = Math.abs(ev.time - k.time) / 1000; // seconds
      if (timeDiff > DEDUP_TIME_WINDOW) continue;
      const dist = haversineKm(ev.lat, ev.lng, k.lat, k.lng);
      if (dist > DEDUP_DISTANCE_KM) continue;
      const magDiff = Math.abs(ev.mag - k.mag);
      if (magDiff > DEDUP_MAG_DIFF) continue;
      // It's a duplicate — merge source info
      if (!k.sources) k.sources = [k.source];
      k.sources.push(ev.source);
      isDuplicate = true;
      removedCount++;
      break;
    }
    if (!isDuplicate) kept.push(ev);
  }

  state.dedupStats = { total: events.length, removed: removedCount };
  return kept;
}

// ── Fetch single source ────────────────────────────────
async function fetchSource(sourceKey, period) {
  const src = SOURCES[sourceKey];
  if (!src || !state.enabledSources.has(sourceKey)) return [];

  const tpl = src.feeds[period] || src.feeds.day;
  const url = buildFeedUrl(tpl, period) + `&_=${Date.now()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    // Tag features with source for generic parsers
    if (json.features) json.features.forEach(f => f._source = sourceKey);

    const events = src.parser(json);
    src.status = 'ok';
    src.lastSuccess = Date.now();
    src.count = events.length;
    return events;
  } catch (err) {
    src.status = 'error';
    src.count = 0;
    console.warn(`[SeismoWatch] ${src.name} failed:`, err.message);
    return [];
  }
}

// ── Main Fetch ─────────────────────────────────────────
async function fetchData() {
  updateSourceStatusUI('loading');

  const activeSources = [...state.enabledSources];
  const results = await Promise.allSettled(
    activeSources.map(key => fetchSource(key, state.period))
  );

  const allEvents = [];
  let successCount = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.length > 0) {
      allEvents.push(...r.value);
      successCount++;
    }
  });

  if (successCount === 0 && allEvents.length === 0) {
    // All sources failed
    const pulse = document.getElementById('pulse-dot');
    if (pulse) pulse.style.background = '#ef4444';

    let msg = '📡 Tüm veri kaynakları yanıt vermedi.';
    if (!navigator.onLine) msg = '📡 İnternet bağlantısı yok. Lütfen bağlantınızı kontrol edin.';

    showError(msg, true);

    if (state.raw.length > 0 && state.lastFetchTime) {
      const age = Math.round((Date.now() - state.lastFetchTime) / 60000);
      showConsistencyWarning(`⏰ Son başarılı güncelleme ${age} dakika önce (önbellek).`);
    } else {
      const recentList = document.getElementById('recent-list');
      if (recentList) recentList.innerHTML = `
        <div class="error-state">
          <div class="error-state-icon">📡</div>
          <h3>Veri Alınamadı</h3>
          <p>${msg}</p>
          <button onclick="fetchData()" class="btn-primary">🔄 Tekrar Dene</button>
        </div>`;
    }
    updateSourceStatusUI('error');
    return;
  }

  // Deduplicate merged results
  const deduped = deduplicateEvents(allEvents);

  // Consistency check
  checkDataConsistency(deduped);

  state.raw = deduped;
  state.lastFetchTime = Date.now();
  state.errorCount = 0;
  dismissError();
  processData();

  const pulse = document.getElementById('pulse-dot');
  const recentPulse = document.getElementById('recent-pulse');
  if (pulse) pulse.style.background = '#22c55e';
  if (recentPulse) { recentPulse.classList.add('active'); setTimeout(() => recentPulse.classList.remove('active'), 1000); }

  updateSourceStatusUI('ok');
  renderSourcePanel();
}

async function fetchMajor() {
  // Use USGS month feed for M6+ global
  const url = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson?_=${Date.now()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const events = parseUSGS(json).filter(e => e.mag >= 6);
    events.sort((a, b) => b.time - a.time);
    renderMajorList(events.slice(0, 12));
  } catch(e) {
    const el = document.getElementById('major-list');
    if (el) el.innerHTML = `<div class="error-state compact"><span>⚠️</span><p>Büyük deprem verileri yüklenemedi.</p><button onclick="fetchMajor()" class="btn-ghost btn-sm">Tekrar Dene</button></div>`;
  }
}

// ── Source Status UI ───────────────────────────────────
function updateSourceStatusUI(state_) {
  const indicator = document.getElementById('source-indicator');
  if (!indicator) return;
  if (state_ === 'loading') {
    indicator.textContent = '⟳ Kaynaklar güncelleniyor…';
    indicator.className = 'source-indicator loading';
  } else if (state_ === 'ok') {
    const ok = Object.values(SOURCES).filter(s => s.status === 'ok').length;
    const total = Object.keys(SOURCES).length;
    indicator.textContent = `✓ ${ok}/${total} kaynak aktif`;
    indicator.className = 'source-indicator ok';
  } else {
    indicator.textContent = '✗ Bağlantı hatası';
    indicator.className = 'source-indicator error';
  }
}

function renderSourcePanel() {
  const panel = document.getElementById('source-panel');
  if (!panel) return;

  const rows = Object.entries(SOURCES).map(([key, src]) => {
    const statusIcon = src.status === 'ok' ? '🟢' : src.status === 'error' ? '🔴' : '⚪';
    const lastOk = src.lastSuccess
      ? `${Math.round((Date.now() - src.lastSuccess) / 1000)}s önce`
      : '—';
    const isEnabled = state.enabledSources.has(key);
    return `
      <div class="source-row ${src.status}">
        <span class="source-dot">${statusIcon}</span>
        <span class="source-flag">${src.flag}</span>
        <span class="source-name">${src.name}</span>
        <span class="source-count">${src.count > 0 ? src.count + ' kayıt' : lastOk}</span>
        <label class="toggle-label source-toggle" title="${isEnabled ? 'Devre dışı bırak' : 'Etkinleştir'}">
          <input type="checkbox" data-source="${key}" ${isEnabled ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>`;
  }).join('');

  const dedupInfo = state.dedupStats.removed > 0
    ? `<div class="dedup-info">🔗 ${state.dedupStats.removed} yinelenen kayıt kaldırıldı (${state.dedupStats.total} → ${state.dedupStats.total - state.dedupStats.removed})</div>`
    : '';

  panel.innerHTML = rows + dedupInfo;

  // Bind toggles
  panel.querySelectorAll('input[data-source]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.source;
      if (cb.checked) state.enabledSources.add(key);
      else state.enabledSources.delete(key);
      fetchData();
    });
  });
}

// ── Error Handling ─────────────────────────────────────
function showError(message, retryable = true) {
  state.lastError = message;
  state.errorCount++;
  const banner = document.getElementById('error-banner');
  const msg = document.getElementById('error-message');
  const retryBtn = document.getElementById('error-retry');
  if (!banner || !msg) return;
  msg.textContent = message;
  if (retryBtn) retryBtn.style.display = retryable ? '' : 'none';
  banner.classList.remove('hidden');
  banner.classList.add('show');
  if (state.errorCount <= 2) setTimeout(() => dismissError(), 10000);
}

function dismissError() {
  const banner = document.getElementById('error-banner');
  if (banner) {
    banner.classList.remove('show');
    setTimeout(() => banner.classList.add('hidden'), 300);
  }
}

function showConsistencyWarning(msg) {
  const bar = document.getElementById('recent-consistency-bar');
  const msgEl = document.getElementById('consistency-message');
  if (!bar || !msgEl) return;
  msgEl.textContent = msg;
  bar.classList.remove('hidden');
  setTimeout(() => bar.classList.add('hidden'), 8000);
}

// ── Data Consistency Check ─────────────────────────────
function checkDataConsistency(events) {
  const warnings = [];
  const now = Date.now();

  const future = events.filter(e => e.time > now + 60000);
  if (future.length > 0) warnings.push(`⚠️ ${future.length} kayıt gelecek zaman damgası içeriyor.`);

  const badMag = events.filter(e => e.mag !== null && (e.mag < -2 || e.mag > 10));
  if (badMag.length > 0) warnings.push(`⚠️ ${badMag.length} kayıt geçersiz büyüklük değeri içeriyor.`);

  state.consistencyWarnings = warnings;
  if (warnings.length > 0) {
    showConsistencyWarning(warnings[0]);
    console.warn('[SeismoWatch] Tutarsızlıklar:', warnings);
  }
  return warnings;
}

// ── Process ────────────────────────────────────────────
function processData() {
  let data = [...state.raw];

  if (state.minMag > 0) data = data.filter(e => e.mag >= state.minMag);

  if (state.search.trim()) {
    const q = normalizeSearch(state.search);
    data = data.filter(e => e.place.toLowerCase().includes(q));
  }

  if (state.sortBy === 'time') {
    data.sort((a, b) => b.time - a.time);
  } else {
    data.sort((a, b) => b.mag - a.mag);
  }

  state.filtered = data;
  state.page = 1;

  renderStats();
  renderList();
  updateMapMarkersSync(data.slice(0, 800));
  renderCharts(data);
  renderTicker(data);
  renderRecentList();
  fetchMajor();
}

// ── Turkey alias map ───────────────────────────────────
const COUNTRY_ALIASES = {
  'türkiye': 'turkey', 'turkiye': 'turkey',
  'japonya': 'japan', 'yunanistan': 'greece',
  'italya': 'italy', 'endonezya': 'indonesia',
  'şili': 'chile', 'meksika': 'mexico',
  'iran': 'iran', 'irak': 'iraq', 'suriye': 'syria',
  'çin': 'china', 'rusya': 'russia',
  'yeni zelanda': 'new zealand', 'filipinler': 'philippines',
  'arjantin': 'argentina', 'peru': 'peru',
  'afganistan': 'afghanistan', 'pakistan': 'pakistan',
  'hindistan': 'india', 'endonezya': 'indonesia',
  'almanya': 'germany', 'fransa': 'france', 'ispanya': 'spain',
  'portekiz': 'portugal', 'romanya': 'romania'
};
function normalizeSearch(q) {
  const lower = q.toLowerCase().trim();
  return COUNTRY_ALIASES[lower] || lower;
}

// ── Stats ──────────────────────────────────────────────
function renderStats() {
  const data = state.raw;
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);

  const total = data.length;
  const today = data.filter(e => e.time >= todayStart.getTime());
  const largest = today.reduce((mx, e) => (e.mag > (mx?.mag || 0) ? e : mx), null);
  const week = data.filter(e => e.time >= now - 7*86400000);
  const major = week.filter(e => e.mag >= 4.5);

  const regionMap = {};
  data.forEach(e => {
    const r = extractRegion(e.place);
    regionMap[r] = (regionMap[r] || 0) + 1;
  });
  const topRegion = Object.entries(regionMap).sort((a,b) => b[1]-a[1])[0];

  const turkeyAll = data.filter(e => e.place.toLowerCase().includes('turkey'));
  const turkeyToday = turkeyAll.filter(e => e.time >= todayStart.getTime());
  const turkeyLargest = turkeyAll.reduce((mx, e) => (e.mag > (mx?.mag || 0) ? e : mx), null);
  setEl('#val-turkey-today', turkeyToday.length);
  setEl('#val-turkey-total', turkeyAll.length);
  setEl('#val-turkey-largest', turkeyLargest ? `M${turkeyLargest.mag.toFixed(1)}` : '—');

  animate('#val-total', total);
  animate('#val-today', today.length);
  setEl('#val-largest', largest ? `M${largest.mag.toFixed(1)}` : '—');
  animate('#val-major', major.length);
  setEl('#val-region', topRegion ? topRegion[0] : '—');
  setEl('#list-count', state.filtered.length);
}

function extractRegion(place) {
  if (!place) return 'Unknown';
  const parts = place.split(',');
  return parts[parts.length - 1].trim() || parts[0].trim();
}

function animate(selector, target) {
  const el = document.querySelector(selector);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  const duration = 600;
  const t0 = performance.now();
  function step(now) {
    const p = Math.min((now - t0) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(start + (target - start) * ease);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function setEl(selector, text) {
  const el = document.querySelector(selector);
  if (el) el.textContent = text;
}

// ── Map ────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { center: [20, 0], zoom: 2, zoomControl: true, attributionControl: true, preferCanvas: true });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18
  }).addTo(map);

  markerCluster = L.markerClusterGroup({
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: createClusterIcon
  });
  map.addLayer(markerCluster);
}

function createClusterIcon(cluster) {
  const count = cluster.getChildCount();
  const markers = cluster.getAllChildMarkers();
  const maxMag = Math.max(...markers.map(m => m.options.mag || 0));
  const color = magColor(maxMag);
  const size = count < 10 ? 32 : count < 50 ? 40 : 48;
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;background:${color};border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:${count<10?13:11}px;border:2px solid rgba(255,255,255,0.4);box-shadow:0 2px 8px rgba(0,0,0,0.4);">${count}</div>`,
    className: '',
    iconSize: [size, size]
  });
}

function magColor(mag) {
  if (mag >= 7)   return '#ef4444';
  if (mag >= 6)   return '#f97316';
  if (mag >= 4.5) return '#eab308';
  if (mag >= 3)   return '#22c55e';
  return '#3b82f6';
}
function magClass(mag) {
  if (mag >= 7)   return 'mc-major';
  if (mag >= 6)   return 'mc-strong';
  if (mag >= 4.5) return 'mc-moderate';
  if (mag >= 3)   return 'mc-light';
  return 'mc-minor';
}

let _prevEqIds = new Set();

function updateMapMarkersSync(events) {
  const newIds = new Set(events.map(e => e.id));
  const addedIds = new Set([...newIds].filter(id => !_prevEqIds.has(id)));

  markerCluster.clearLayers();

  events.forEach(ev => {
    if (ev.lat == null || ev.lng == null) return;
    const mag = ev.mag || 0;
    const r = Math.max(6, Math.min(22, mag * 3.5));
    const color = magColor(mag);
    const srcColor = SOURCES[ev.source]?.color || '#888';
    const isNew = addedIds.has(ev.id);

    const marker = L.circleMarker([ev.lat, ev.lng], {
      radius: isNew ? r + 3 : r,
      fillColor: color,
      color: isNew ? '#ffffff' : `${srcColor}66`,
      weight: isNew ? 2.5 : 1.5,
      fillOpacity: isNew ? 1 : 0.85,
      mag: mag
    });

    marker.bindPopup(buildPopupHTML(ev), { maxWidth: 280, className: 'eq-popup' });
    marker.on('click', () => openModal(ev));
    markerCluster.addLayer(marker);
  });

  _prevEqIds = newIds;
}

function buildPopupHTML(ev) {
  const mag = (ev.mag || 0).toFixed(1);
  const depth = (ev.depth || 0).toFixed(1);
  const time = formatTime(ev.time);
  const color = magColor(ev.mag || 0);
  const srcName = SOURCES[ev.source]?.name || ev.source || '?';
  const srcFlag = SOURCES[ev.source]?.flag || '';
  return `
    <div class="popup-mag" style="color:${color}">M ${mag}</div>
    <div class="popup-place">${ev.place}</div>
    <div class="popup-meta">Derinlik: ${depth} km · ${time}</div>
    <div class="popup-source">${srcFlag} ${srcName}</div>
  `;
}

// ── List ───────────────────────────────────────────────
function renderList() {
  const list = document.getElementById('eq-list');
  const data = state.filtered;
  const total = data.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const start = (state.page - 1) * PAGE_SIZE;
  const page = data.slice(start, start + PAGE_SIZE);

  document.getElementById('list-count').textContent = total;

  if (!page.length) {
    list.innerHTML = '<div class="empty-state">Filtrelerinize uyan deprem bulunamadı.</div>';
    document.getElementById('list-pagination').innerHTML = '';
    return;
  }

  list.innerHTML = page.map(ev => buildListItem(ev)).join('');

  list.querySelectorAll('.eq-item').forEach((el, i) => {
    const ev = page[i];
    el.addEventListener('click', () => { openModal(ev); flyToEq(ev); });
  });

  renderPagination(totalPages);
}

function buildListItem(ev) {
  const mag = (ev.mag || 0).toFixed(1);
  const cls = magClass(ev.mag || 0);
  const depth = (ev.depth || 0).toFixed(0);
  const time = timeAgo(ev.time);
  const place = ev.place || 'Bilinmeyen konum';
  const srcFlag = SOURCES[ev.source]?.flag || '';
  return `
    <div class="eq-item" role="listitem" tabindex="0">
      <div class="eq-mag-circle ${cls}">${mag}</div>
      <div>
        <div class="eq-place" title="${place}">${place}</div>
        <div class="eq-meta">Derinlik ${depth} km · <span class="src-badge">${srcFlag} ${SOURCES[ev.source]?.name || ev.source}</span></div>
      </div>
      <div class="eq-time">${time}</div>
    </div>
  `;
}

function renderPagination(totalPages) {
  const container = document.getElementById('list-pagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }
  const curr = state.page;
  const showPages = getPageRange(curr, totalPages);
  let html = `<button class="page-btn" ${curr===1?'disabled':''} data-page="${curr-1}">‹</button>`;
  showPages.forEach(p => {
    if (p === '…') html += `<span style="color:var(--text3);padding:0 4px;">…</span>`;
    else html += `<button class="page-btn ${p===curr?'active':''}" data-page="${p}">${p}</button>`;
  });
  html += `<button class="page-btn" ${curr===totalPages?'disabled':''} data-page="${curr+1}">›</button>`;
  container.innerHTML = html;
  container.querySelectorAll('.page-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      state.page = parseInt(btn.dataset.page);
      renderList();
      document.getElementById('list-section').scrollIntoView({ behavior: 'smooth' });
    });
  });
}

function getPageRange(curr, total) {
  if (total <= 7) return Array.from({length: total}, (_,i) => i+1);
  const pages = [1];
  if (curr > 3) pages.push('…');
  for (let i = Math.max(2, curr-1); i <= Math.min(total-1, curr+1); i++) pages.push(i);
  if (curr < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

// ── Charts ─────────────────────────────────────────────
function renderCharts(data) {
  const isDark = state.isDark;
  const textColor = isDark ? '#9aa3bc' : '#4a5568';
  const gridColor = isDark ? '#333a52' : '#d1d8ee';
  Chart.defaults.color = textColor;

  const magBuckets = { '<2':0,'2–3':0,'3–4':0,'4–5':0,'5–6':0,'6–7':0,'7+':0 };
  data.forEach(e => {
    const m = e.mag || 0;
    if (m<2) magBuckets['<2']++;
    else if (m<3) magBuckets['2–3']++;
    else if (m<4) magBuckets['3–4']++;
    else if (m<5) magBuckets['4–5']++;
    else if (m<6) magBuckets['5–6']++;
    else if (m<7) magBuckets['6–7']++;
    else magBuckets['7+']++;
  });
  buildChart('chart-mag','bar',{labels:Object.keys(magBuckets),datasets:[{label:'Sayı',data:Object.values(magBuckets),backgroundColor:['#3b82f6','#22c55e','#6366f1','#eab308','#f97316','#ef4444','#dc2626'],borderRadius:6,borderSkipped:false}]},{indexAxis:'x',gridColor});

  const now = Date.now();
  const hourCounts = new Array(24).fill(0);
  data.forEach(e => {
    const h = Math.floor((now - e.time) / 3600000);
    if (h < 24) hourCounts[23-h]++;
  });
  const hourLabels = Array.from({length:24},(_,i)=>{
    const d=new Date(now-(23-i)*3600000);
    return `${d.getHours()}:00`;
  });
  buildChart('chart-time','line',{labels:hourLabels,datasets:[{label:'Olay',data:hourCounts,borderColor:'#f59e0b',backgroundColor:'rgba(245,158,11,0.12)',fill:true,tension:0.4,pointRadius:3,pointBackgroundColor:'#f59e0b'}]},{gridColor});

  const regionMap = {};
  data.forEach(e => { const r=extractRegion(e.place); regionMap[r]=(regionMap[r]||0)+1; });
  const topRegions = Object.entries(regionMap).sort((a,b)=>b[1]-a[1]).slice(0,8);
  buildChart('chart-regions','bar',{labels:topRegions.map(r=>r[0]),datasets:[{label:'Depremler',data:topRegions.map(r=>r[1]),backgroundColor:'#f59e0b',borderRadius:6,borderSkipped:false}]},{indexAxis:'y',gridColor});

  const depthBuckets={'0–10km':0,'10–35km':0,'35–70km':0,'70–150km':0,'150–300km':0,'300km+':0};
  data.forEach(e=>{
    const d=e.depth||0;
    if(d<10)depthBuckets['0–10km']++;
    else if(d<35)depthBuckets['10–35km']++;
    else if(d<70)depthBuckets['35–70km']++;
    else if(d<150)depthBuckets['70–150km']++;
    else if(d<300)depthBuckets['150–300km']++;
    else depthBuckets['300km+']++;
  });
  buildChart('chart-depth','doughnut',{labels:Object.keys(depthBuckets),datasets:[{data:Object.values(depthBuckets),backgroundColor:['#3b82f6','#6366f1','#a855f7','#ec4899','#f97316','#ef4444'],borderWidth:2,borderColor:isDark?'#1e2130':'#ffffff'}]},{gridColor,isDoughnut:true});
}

function buildChart(id, type, data, opts={}) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  if (state.charts[id]) state.charts[id].destroy();
  const gridColor = opts.gridColor || '#333a52';
  const baseOpts = {
    responsive:true, maintainAspectRatio:true,
    plugins:{
      legend:{display:type==='doughnut',position:'bottom',labels:{boxWidth:12,padding:16}},
      tooltip:{backgroundColor:'#252a3a',borderColor:'#333a52',borderWidth:1,padding:10,cornerRadius:8}
    }
  };
  if (type!=='doughnut') {
    baseOpts.scales={
      x:{grid:{color:gridColor,drawBorder:false},ticks:{maxRotation:45}},
      y:{grid:{color:gridColor,drawBorder:false},beginAtZero:true}
    };
    if (opts.indexAxis==='y') { baseOpts.indexAxis='y'; baseOpts.scales.y.grid={color:gridColor}; }
  }
  state.charts[id] = new Chart(canvas,{type,data,options:baseOpts});
}

function updateChartTheme() {
  if (state.filtered.length) renderCharts(state.filtered);
}

// ── Major List ─────────────────────────────────────────
function renderMajorList(data) {
  const el = document.getElementById('major-list');
  if (!data.length) { el.innerHTML='<p class="empty-state">Son 30 günde M6.0+ deprem yok.</p>'; return; }
  el.innerHTML = data.map(ev => `
    <div class="major-card" data-id="${ev.id}">
      <div class="major-card-mag">M${(ev.mag||0).toFixed(1)}</div>
      <div class="major-card-place">${ev.place}</div>
      <div class="major-card-meta">${formatTime(ev.time)}</div>
    </div>`).join('');
  el.querySelectorAll('.major-card').forEach((card,i) => card.addEventListener('click',()=>openModal(data[i])));
}

// ── Ticker ─────────────────────────────────────────────
function renderTicker(data) {
  const top = data.filter(e=>e.mag>=3).sort((a,b)=>b.time-a.time).slice(0,15);
  if (!top.length) return;
  const content = top.map(e=>{
    const isTurkey = e.place.toLowerCase().includes('turkey');
    const label = isTurkey ? `🇹🇷 ${e.place}` : e.place;
    const srcFlag = SOURCES[e.source]?.flag || '';
    return `  ★ M${e.mag.toFixed(1)} — ${label} ${srcFlag} (${timeAgo(e.time)})  `;
  }).join('  │  ');
  const el = document.getElementById('ticker-content');
  el.textContent = content;
  el.style.animation='none'; el.offsetHeight; el.style.animation='';
}

// ── Recent List ─────────────────────────────────────────
function renderRecentList() {
  const container = document.getElementById('recent-list');
  if (!container) return;

  let data = [...state.raw];
  if (state.recentSortBy==='time') data.sort((a,b)=>b.time-a.time);
  else if (state.recentSortBy==='time-asc') data.sort((a,b)=>a.time-b.time);
  else if (state.recentSortBy==='mag') data.sort((a,b)=>b.mag-a.mag);

  const recent = data.slice(0, RECENT_PAGE_SIZE);
  const countEl = document.getElementById('recent-count');
  if (countEl) countEl.textContent = data.length;

  if (!recent.length) {
    container.innerHTML = '<div class="empty-state">Deprem verisi bulunamadı.</div>';
    return;
  }

  container.innerHTML = recent.map(ev => buildRecentItem(ev)).join('');
  container.querySelectorAll('.recent-item').forEach((el,i) => {
    el.addEventListener('click',()=>{ openModal(recent[i]); flyToEq(recent[i]); });
  });
}

function buildRecentItem(ev) {
  const mag = (ev.mag||0).toFixed(1);
  const cls = magClass(ev.mag||0);
  const color = magColor(ev.mag||0);
  const depth = (ev.depth||0).toFixed(0);
  const time = formatTime(ev.time);
  const ago = timeAgo(ev.time);
  const place = ev.place||'Bilinmeyen';
  const isTurkey = place.toLowerCase().includes('turkey');
  const srcFlag = SOURCES[ev.source]?.flag||'';
  const srcName = SOURCES[ev.source]?.name||ev.source||'';
  const multiSrc = ev.sources?.length > 1
    ? `<span class="multi-src-badge" title="${ev.sources.join(', ')}">+${ev.sources.length-1} kaynak</span>` : '';

  return `
    <div class="recent-item" role="listitem" tabindex="0">
      <div class="recent-mag ${cls}" style="border-color:${color}40">${mag}</div>
      <div class="recent-info">
        <div class="recent-place">${isTurkey?'🇹🇷 ':''}${place}</div>
        <div class="recent-meta">
          <span>🕐 ${time}</span>
          <span>📏 ${depth} km</span>
          <span class="src-tag">${srcFlag} ${srcName}</span>
          ${multiSrc}
          ${ev.tsunami?'<span class="tsunami-warn">🌊 Tsunami</span>':''}
        </div>
      </div>
      <div class="recent-time-ago">${ago}</div>
    </div>`;
}

// ── Modal ──────────────────────────────────────────────
function openModal(ev) {
  const mag = (ev.mag||0).toFixed(1);
  const depth = (ev.depth||0).toFixed(1);
  const color = magColor(ev.mag||0);
  const srcName = SOURCES[ev.source]?.name || ev.source || '?';

  const badge = document.getElementById('modal-mag-badge');
  badge.textContent = `M ${mag}`;
  badge.style.background = color+'22';
  badge.style.color = color;
  badge.style.border = `1px solid ${color}40`;

  document.getElementById('modal-title').textContent = ev.place||'Bilinmeyen';

  const rows = [
    ['Büyüklük', `M ${mag}`],
    ['Derinlik', `${depth} km`],
    ['Enlem', (ev.lat||0).toFixed(4)+'°'],
    ['Boylam', (ev.lng||0).toFixed(4)+'°'],
    ['Zaman (UTC)', new Date(ev.time).toUTCString()],
    ['Yerel Zaman', new Date(ev.time).toLocaleString()],
    ['Tür', ev.type||'earthquake'],
    ['Durum', ev.status||'—'],
    ['Tsunami Uyarısı', ev.tsunami?'⚠️ Evet':'✓ Hayır'],
    ['Uyarı Seviyesi', ev.alert||'—'],
    ['Hissedildi', ev.felt?ev.felt.toLocaleString():'—'],
    ['Veri Kaynağı', `${SOURCES[ev.source]?.flag||''} ${srcName}`],
    ...(ev.sources?.length>1?[['Çapraz Doğrulama', ev.sources.map(s=>SOURCES[s]?.name||s).join(', ')]]:[])
  ];

  document.getElementById('modal-body').innerHTML = rows.map(([l,v])=>
    `<div class="modal-row"><span class="label">${l}</span><span class="value">${v}</span></div>`
  ).join('');

  const link = document.getElementById('modal-usgs-link');
  link.href = ev.url || `https://earthquake.usgs.gov/earthquakes/eventpage/${ev.sourceId||ev.id}/executive`;

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-close').focus();

  if (ev.mag>=5 && Notification.permission==='granted') {
    new Notification(`M${mag} Deprem`,{body:ev.place,icon:'icons/icon-192.png',tag:ev.id});
  }
}

function closeModal() { document.getElementById('modal-overlay').classList.add('hidden'); }

function flyToEq(ev) {
  if (ev.lat!=null && ev.lng!=null) {
    map.flyTo([ev.lat, ev.lng], 6, {duration:1.2});
    document.getElementById('map-section').scrollIntoView({behavior:'smooth'});
  }
}

// ── Notifications ──────────────────────────────────────
function requestNotifications() {
  if (!('Notification' in window)) { alert('Tarayıcınız bildirimleri desteklemiyor.'); return; }
  Notification.requestPermission().then(perm=>{
    const btn=document.getElementById('btn-notify');
    if(perm==='granted'){btn.textContent='🔔✓';btn.style.color='#22c55e';}
    else btn.textContent='🔕';
  });
}

// ── UI Bindings ────────────────────────────────────────
function bindUI() {
  document.getElementById('btn-dark-toggle').addEventListener('click', toggleTheme);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e=>{ if(e.target===document.getElementById('modal-overlay')) closeModal(); });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModal(); });
  document.getElementById('btn-notify').addEventListener('click', requestNotifications);

  document.getElementById('filter-period').addEventListener('change', e=>{ state.period=e.target.value; });
  document.getElementById('filter-mag').addEventListener('input', e=>{
    state.minMag=parseFloat(e.target.value);
    document.getElementById('mag-display').textContent=state.minMag.toFixed(1);
  });
  document.getElementById('btn-apply-filters').addEventListener('click', ()=>{
    state.search=document.getElementById('filter-search').value;
    fetchData();
  });
  document.getElementById('btn-reset-filters').addEventListener('click', ()=>{
    state.period='day'; state.minMag=0; state.search=''; state.sortBy='time';
    document.getElementById('filter-period').value='day';
    document.getElementById('filter-mag').value=0;
    document.getElementById('mag-display').textContent='0.0';
    document.getElementById('filter-search').value='';
    document.getElementById('sort-by').value='time';
    fetchData();
  });
  document.getElementById('sort-by').addEventListener('change', e=>{ state.sortBy=e.target.value; processData(); });

  document.querySelectorAll('[data-country-filter]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const val=btn.dataset.countryFilter;
      document.getElementById('filter-search').value=val;
      state.search=val; state.period='week';
      document.getElementById('filter-period').value='week';
      document.querySelectorAll('[data-country-filter]').forEach(b=>b.classList.remove('active-filter'));
      btn.classList.add('active-filter');
      fetchData();
    });
  });
  document.getElementById('filter-search').addEventListener('keydown', e=>{
    if(e.key==='Enter') document.getElementById('btn-apply-filters').click();
  });
}

// ── Init Map & Dark Mode ───────────────────────────────
function initDarkMode() {
  const saved=localStorage.getItem('theme');
  state.isDark=saved?saved==='dark':true;
  applyTheme();
}
function applyTheme() {
  document.body.classList.toggle('dark',state.isDark);
  document.body.classList.toggle('light',!state.isDark);
  document.getElementById('dark-icon').textContent=state.isDark?'☀️':'🌙';
  if(state.charts.mag) updateChartTheme();
}
function toggleTheme() {
  state.isDark=!state.isDark;
  localStorage.setItem('theme',state.isDark?'dark':'light');
  applyTheme();
}

// ── Refresh Cycle ──────────────────────────────────────
function startRefreshCycle() {
  clearInterval(state.refreshTimer);
  clearInterval(state.countdownTimer);
  clearInterval(state.recentCountdownTimer);
  if(!state.autoRefresh) return;

  state.refreshTimer=setInterval(()=>{ if(state.autoRefresh) { fetchData(); state.countdown=REFRESH_INTERVAL/1000; } }, REFRESH_INTERVAL);

  state.countdown=REFRESH_INTERVAL/1000;
  state.countdownTimer=setInterval(()=>{
    state.countdown--;
    const el=document.getElementById('refresh-countdown');
    if(el) el.textContent=state.countdown>0?`${state.countdown}s`:'…';
    if(state.countdown<=0) state.countdown=REFRESH_INTERVAL/1000;
  },1000);

  let rc=REFRESH_INTERVAL/1000;
  state.recentCountdownTimer=setInterval(()=>{
    rc--;
    const el=document.getElementById('recent-countdown');
    if(el) el.textContent=rc>0?`${rc}s`:'…';
    if(rc<=0) rc=REFRESH_INTERVAL/1000;
  },1000);
}

// ── Recent Section Init ────────────────────────────────
function initRecentSection() {
  document.getElementById('recent-sort')?.addEventListener('change',e=>{ state.recentSortBy=e.target.value; renderRecentList(); });

  document.getElementById('auto-refresh-toggle')?.addEventListener('change',e=>{
    state.autoRefresh=e.target.checked;
    if(state.autoRefresh) startRefreshCycle();
    else {
      clearInterval(state.refreshTimer); clearInterval(state.countdownTimer); clearInterval(state.recentCountdownTimer);
      const el=document.getElementById('recent-countdown');
      if(el) el.textContent='Durduruldu';
    }
  });

  document.getElementById('btn-manual-refresh')?.addEventListener('click',()=>{
    const btn=document.getElementById('btn-manual-refresh');
    btn.classList.add('spinning');
    fetchData().finally(()=>setTimeout(()=>btn.classList.remove('spinning'),600));
  });

  document.getElementById('error-retry')?.addEventListener('click',()=>{ dismissError(); fetchData(); });
  document.getElementById('error-dismiss')?.addEventListener('click', dismissError);
}

// ── Service Worker & Install ───────────────────────────
function registerSW() {
  if('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(console.error);
}
function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); state.deferredInstallPrompt=e; document.getElementById('btn-install').classList.remove('hidden'); });
  document.getElementById('btn-install')?.addEventListener('click',()=>{
    if(state.deferredInstallPrompt){ state.deferredInstallPrompt.prompt(); state.deferredInstallPrompt.userChoice.then(r=>{ if(r.outcome==='accepted') document.getElementById('btn-install').classList.add('hidden'); }); }
  });
  window.addEventListener('appinstalled',()=>document.getElementById('btn-install').classList.add('hidden'));
}

// ── Time Helpers ───────────────────────────────────────
function timeAgo(ts) {
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return `${s}s önce`;
  const m=Math.floor(s/60);
  if(m<60) return `${m}dk önce`;
  const h=Math.floor(m/60);
  if(h<24) return `${h}s önce`;
  return `${Math.floor(h/24)}g önce`;
}
function formatTime(ts) {
  return new Date(ts).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});
}

// ── Init ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  initDarkMode();
  initMap();
  bindUI();
  fetchData();
  startRefreshCycle();
  registerSW();
  initInstallPrompt();
  initRecentSection();
  document.getElementById('year').textContent=new Date().getFullYear();
});
