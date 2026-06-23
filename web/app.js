// 静态可视化:index.json 趟清单 → 趟切换 + 点/段图层切换 → 地图+图表+卡片+元信息
const COMFORT_LEGEND = [
  ["#1a9850", "1 not uncomfortable"], ["#91cf60", "2 a little"],
  ["#fee08b", "3 fairly"], ["#fc8d59", "4 uncomfortable"],
  ["#d73027", "5 very/extreme"], ["#9e9e9e", "no data"],
];

let map, layerControl, charts = [];
const current = { points: null, segments: null, surface: null };

async function loadJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function loadJSONopt(path) { try { return await loadJSON(path); } catch { return null; } }

function initMap() {
  const m = L.map("map").setView([48.1446, 11.5598], 13);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap, &copy; CARTO", maxZoom: 19,
  }).addTo(m);
  return m;
}

function pointsLayer(gj) {
  return L.geoJSON(gj, {
    pointToLayer: (f, latlng) => L.circleMarker(latlng, {
      radius: 6, color: "#333", weight: 1,
      fillColor: f.properties.comfort_color, fillOpacity: 0.9,
    }),
    style: (f) => f.geometry.type === "LineString"
      ? { color: f.properties.comfort_color, weight: 5, opacity: 0.8 } : {},
    onEachFeature: (f, lyr) => {
      if (f.geometry.type !== "Point") return;
      const p = f.properties;
      const speed = p.speed == null ? "—" : `${p.speed} km/h`;
      lyr.bindPopup(
        `<b>${new Date(p.time).toLocaleString()}</b><br>` +
        `a_w (vertical Wk): ${p.a_w == null ? "—" : p.a_w.toFixed(3)} m/s²<br>` +
        `comfort: ${p.comfort ?? "—"}<br>impacts: ${p.vib ?? "—"}<br>speed: ${speed}`);
    },
  });
}

function segmentsLayer(gj) {
  return L.geoJSON(gj, {
    style: (f) => ({ color: f.properties.comfort_color, weight: 6, opacity: 0.85 }),
    onEachFeature: (f, lyr) => {
      const p = f.properties;
      lyr.bindPopup(
        `<b>Segment ${p.bin_id} (50 m)</b><br>` +
        `median a_w: ${p.a_w_median == null ? "—" : p.a_w_median.toFixed(3)} m/s²<br>` +
        `comfort: ${p.comfort ?? "—"}<br>windows: ${p.n}`);
    },
  });
}

function surfaceLayer(gj) {
  return L.geoJSON(gj, {
    style: (f) => ({ color: f.properties.surface_color, weight: 6, opacity: 0.85,
                     dashArray: f.properties.snap_far ? "4 6" : null }),
    onEachFeature: (f, lyr) => {
      const p = f.properties;
      lyr.bindPopup(
        `<b>OSM surface: ${p.surface ?? "unknown"}</b> (${p.roughness})<br>` +
        `${p.osm_name ? p.osm_name + "<br>" : ""}` +
        `measured a_w: ${p.a_w_median == null ? "—" : p.a_w_median.toFixed(3)} m/s² (comfort ${p.comfort ?? "—"})<br>` +
        `snap: ${p.snap_dist_m} m${p.snap_far ? " ⚠far" : ""}`);
    },
  });
}

function addLegend(m) {
  const ctrl = L.control({ position: "bottomright" });
  ctrl.onAdd = () => {
    const d = L.DomUtil.create("div", "panel legend");
    d.innerHTML = "<b>Comfort — vertical Wk a_w (ISO 2631-1)</b><br>" +
      COMFORT_LEGEND.map(([c, t]) => `<i style="background:${c}"></i>${t}`).join("<br>") +
      `<div class="legend-note">ISO 2631-1 reaction scale on frame-mounted vertical Wk a_w · ` +
      `Gao 2018 cited for awv–comfort correlation only</div>`;
    return d;
  };
  ctrl.addTo(m);
}

function renderCards(meta) {
  const L_ = meta.latest || {};
  const cards = [
    ["Temp", L_.envT, "°C"], ["Humidity", L_.hum, "%"],
    ["Pressure", L_.press, "hPa"], ["Gas", L_.gas, "kΩ"],
  ];
  document.getElementById("cards").innerHTML = cards.map(([lbl, v, u]) =>
    `<div class="card"><div class="val">${v == null ? "—" : v}</div>` +
    `<div class="lbl">${lbl} ${u}</div></div>`).join("");
}

function renderMeta(meta) {
  const r = meta.time_range || {};
  document.getElementById("meta").innerHTML =
    `<h3>Data quality</h3><dl>` +
    `<dt>Range</dt><dd class="mono">${r.start ?? "—"} → ${r.end ?? "—"}</dd>` +
    `<dt>Unique points</dt><dd>${meta.n_unique} (raw ${meta.n_raw}, dedup ${meta.dedup_pct}%)</dd>` +
    `</dl>`;
}

function lineChart(canvasId, labels, datasets, extraScales = {}) {
  charts.push(new Chart(document.getElementById(canvasId), {
    type: "line", data: { labels, datasets },
    options: {
      responsive: true, animation: false, parsing: true,
      elements: { point: { radius: 0 } },
      interaction: { mode: "index", intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 6 } }, ...extraScales },
      plugins: { legend: { labels: { boxWidth: 12, font: { size: 10 } } } },
    },
  }));
}

function renderCharts(ts) {
  charts.forEach((c) => c.destroy());   // 切趟前销毁旧图,避免 canvas 占用报错
  charts = [];
  const labels = ts.time.map((t) => new Date(t).toLocaleTimeString());
  lineChart("chart-vib", labels, [
    { label: "a_w (m/s²)", data: ts.a_w, borderColor: "#d73027", yAxisID: "y", borderWidth: 1.5 },
    { label: "impacts", data: ts.vib, borderColor: "#0065BD", yAxisID: "y2", borderWidth: 1.5 },
  ]);
  lineChart("chart-env", labels, [
    { label: "Temp °C", data: ts.envT, borderColor: "#E37222", borderWidth: 1.5, yAxisID: "yT" },
    { label: "Hum %", data: ts.hum, borderColor: "#0065BD", borderWidth: 1.5, yAxisID: "yH" },
    { label: "Press hPa", data: ts.press, borderColor: "#A2AD00", borderWidth: 1.5, yAxisID: "yP" },
    { label: "Gas kΩ", data: ts.gas, borderColor: "#808080", borderWidth: 1.5, yAxisID: "yG" },
  ], { yT: { display: false }, yH: { display: false }, yP: { display: false }, yG: { display: false } });
}

function showSession(track, segments, snapped, ts, meta) {
  for (const k of ["points", "segments", "surface"]) {
    if (current[k]) { map.removeLayer(current[k]); current[k] = null; }
  }
  if (layerControl) { map.removeControl(layerControl); layerControl = null; }
  current.points = pointsLayer(track);
  current.segments = segmentsLayer(segments);
  current.segments.addTo(map);   // 默认显段层
  const overlays = { "Segments (50 m)": current.segments, "Points (per-window)": current.points };
  if (snapped) {
    current.surface = surfaceLayer(snapped);   // 默认不 addTo(map),仅入控件
    overlays["OSM surface"] = current.surface;
  }
  layerControl = L.control.layers(null, overlays, { collapsed: false }).addTo(map);
  let b = current.segments.getBounds();
  if (!b.isValid()) b = current.points.getBounds();
  if (b.isValid()) map.fitBounds(b.pad(0.3));
  renderCards(meta); renderMeta(meta); renderCharts(ts);
}

async function loadSession(sess) {
  const base = `data/${sess}`;
  const [track, segments, snapped, ts, meta] = await Promise.all([
    loadJSON(`${base}/track.geojson`), loadJSON(`${base}/segments.geojson`),
    loadJSONopt(`${base}/snapped.geojson`),
    loadJSON(`${base}/timeseries.json`), loadJSON(`${base}/meta.json`),
  ]);
  showSession(track, segments, snapped, ts, meta);
}

function buildSwitcher(sessions, onChange) {
  const sel = document.createElement("select");
  sel.id = "session-select";
  sessions.forEach((s) => {
    const o = document.createElement("option");
    o.value = s.session; o.textContent = s.label; sel.appendChild(o);
  });
  sel.addEventListener("change", () => onChange(sel.value));
  const el = document.getElementById("switcher");
  el.innerHTML = "<span>Ride:</span>";
  el.appendChild(sel);
}

(async function main() {
  map = initMap();
  addLegend(map);
  try {
    const index = await loadJSON("data/index.json");
    buildSwitcher(index.sessions, loadSession);
    await loadSession(index.sessions[0].session);
  } catch (e) {
    document.getElementById("meta").innerHTML = `<b style="color:#d73027">加载失败: ${e.message}</b>`;
  }
})();
