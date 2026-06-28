// 静态可视化:index.json 趟清单 → 趟切换 + 点/段图层切换 → 地图+图表+卡片+元信息
const COMFORT_LEGEND = [
  ["#1a9850", "1 not uncomfortable"], ["#91cf60", "2 a little"],
  ["#fee08b", "3 fairly"], ["#fc8d59", "4 uncomfortable"],
  ["#d73027", "5 very/extreme"], ["#9e9e9e", "no data"],
];

// ML 路面层(二分类 smooth/rough)颜色:smooth=绿,rough=红,无预测=中性灰(降透明)。
const SURFACE_COLORS = { smooth: "#1a9850", rough: "#d73027" };
const SURFACE_NULL_COLOR = "#bdbdbd";
const SURFACE_LEGEND = [
  ["#1a9850", "smooth"], ["#d73027", "rough"], [SURFACE_NULL_COLOR, "no prediction"],
];

let map, layerControl, charts = [], legendCtrl = null;
let colorMode = "comfort";   // "comfort"(默认,ISO a_w) | "surface"(ML 路面)
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

// 段层样式随当前 colorMode 切换:comfort=ISO a_w 颜色;surface=ML 预测类(无预测则灰+降透明)。
function segStyle(f) {
  const p = f.properties;
  if (colorMode === "surface") {
    const pred = p.surf_pred;
    if (pred == null) return { color: SURFACE_NULL_COLOR, weight: 6, opacity: 0.35 };
    return { color: SURFACE_COLORS[pred] || SURFACE_NULL_COLOR, weight: 6, opacity: 0.85 };
  }
  return { color: p.comfort_color, weight: 6, opacity: 0.85 };
}

function segmentsLayer(gj) {
  return L.geoJSON(gj, {
    style: segStyle,
    onEachFeature: (f, lyr) => {
      const p = f.properties;
      const ml = p.surf_pred
        ? `<br>ML surface: ${p.surf_pred}` +
          ` (conf ${p.surf_conf == null ? "—" : p.surf_conf.toFixed(2)}, n=${p.surf_n ?? "—"})`
        : "";
      lyr.bindPopup(
        `<b>Segment ${p.bin_id} (50 m)</b><br>` +
        `median a_w: ${p.a_w_median == null ? "—" : p.a_w_median.toFixed(3)} m/s²<br>` +
        `comfort: ${p.comfort ?? "—"}<br>windows: ${p.n}${ml}`);
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

// 图例 = 配色模式切换(段控)+ 当前模式色阶 + 诚实注记。切换时重绘图例并 setStyle 段层。
function renderLegend(d) {
  const toggle =
    `<div class="legend-toggle" role="group" aria-label="Segment color mode">` +
    `<button type="button" class="lt-btn${colorMode === "comfort" ? " active" : ""}" ` +
      `data-mode="comfort">Comfort a_w</button>` +
    `<button type="button" class="lt-btn${colorMode === "surface" ? " active" : ""}" ` +
      `data-mode="surface">ML surface</button>` +
    `</div>`;
  const body = colorMode === "surface"
    ? "<b>ML road surface (predicted)</b><br>" +
      SURFACE_LEGEND.map(([c, t]) => `<i style="background:${c}"></i>${t}`).join("<br>") +
      `<div class="legend-note">Binary model (smooth vs rough), modest accuracy ` +
      `(F1-macro ≈ 0.62) — OSM-weak-supervised, treat as a hint, not ground truth. ` +
      `Baseline rides have no prediction.</div>`
    : "<b>Comfort — vertical Wk a_w (ISO 2631-1)</b><br>" +
      COMFORT_LEGEND.map(([c, t]) => `<i style="background:${c}"></i>${t}`).join("<br>") +
      `<div class="legend-note">ISO 2631-1 reaction scale on frame-mounted vertical Wk a_w · ` +
      `Gao 2018 cited for awv–comfort correlation only</div>`;
  d.innerHTML = toggle + body;
  d.querySelectorAll(".lt-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const mode = b.dataset.mode;
      if (mode === colorMode) return;
      colorMode = mode;
      renderLegend(d);
      if (current.segments) current.segments.setStyle(segStyle);
    });
  });
}

function addLegend(m) {
  const ctrl = L.control({ position: "bottomright" });
  ctrl.onAdd = () => {
    const d = L.DomUtil.create("div", "legend");
    L.DomEvent.disableClickPropagation(d);   // 点按钮不拖地图
    renderLegend(d);
    return d;
  };
  ctrl.addTo(m);
  legendCtrl = ctrl;
}

function fmtNum(v, d) {
  if (v == null || Number.isNaN(v)) return "—";
  return (Math.round(v * 10 ** d) / 10 ** d).toString();
}

// 环境卡片:该趟均值(大字)+ min–max 区间(小字);读 env_stats,缺失回退 latest 单值。
// gas 是 BME680 预热斜坡(电阻上升),非空气质量 → 区间后附安静后缀,完整说明见 Air sensor 图注。
function renderCards(meta) {
  const stats = meta.env_stats || null;
  const latest = meta.latest || {};
  const spec = [   // [标签, 键, 单位, 小数位]
    ["Temp", "envT", "°C", 1], ["Humidity", "hum", "%", 0],
    ["Pressure", "press", "hPa", 0], ["Gas", "gas", "kΩ", 0],
  ];
  document.getElementById("cards").innerHTML = spec.map(([lbl, key, u, d]) => {
    const s = stats && stats[key];
    const mean = s ? s.mean : latest[key];          // 优先 env_stats 均值,回退 latest
    const empty = mean == null || Number.isNaN(mean);
    let sub = "";
    if (s && s.min != null && s.max != null) {
      const lo = fmtNum(s.min, d), hi = fmtNum(s.max, d);
      sub = lo === hi ? "" : `${lo}–${hi}`;          // 该分辨率下恒定 → 不显冗余区间
    }
    if (key === "gas" && !empty) sub = sub ? `${sub} · warming up` : "warming up";
    return `<div class="card"><div class="val${empty ? " empty" : ""}">${fmtNum(mean, d)}</div>` +
      `<div class="card-range">${sub}</div>` +
      `<div class="lbl">${lbl} ${u}</div></div>`;
  }).join("");
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
  // 温湿双轴(均可见):Temp 左轴(TUM orange) / Humidity 右轴(TUM blue);press 移出(太平,仅卡片)。
  lineChart("chart-env", labels, [
    { label: "Temp °C", data: ts.envT, borderColor: "#E37222", borderWidth: 1.5, yAxisID: "yT" },
    { label: "Humidity %", data: ts.hum, borderColor: "#0065BD", borderWidth: 1.5, yAxisID: "yH" },
  ], {
    yT: { position: "left", title: { display: true, text: "°C" } },
    yH: { position: "right", grid: { drawOnChartArea: false }, title: { display: true, text: "%" } },
  });
  // gas:BME680 预热斜坡(电阻上升),单序列单独图;非空气质量,说明见图下注记。
  lineChart("chart-gas", labels, [
    { label: "Gas kΩ", data: ts.gas, borderColor: "#808080", borderWidth: 1.5, yAxisID: "yG" },
  ], { yG: { position: "left", title: { display: true, text: "kΩ" } } });
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
  const el = document.getElementById("switcher");
  el.innerHTML = '<span class="eyebrow">Ride</span>';
  const tabs = document.createElement("div");
  tabs.className = "tabs";
  sessions.forEach((s, i) => {
    const [id, sub] = s.label.split(" · ");   // "0003 · 20:37" → id + 时刻
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab" + (i === 0 ? " active" : "");
    b.innerHTML = `<span class="tab-id">${id}</span><span class="tab-sub">${sub ?? ""}</span>`;
    b.addEventListener("click", () => {
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      b.classList.add("active");
      onChange(s.session);
    });
    tabs.appendChild(b);
  });
  el.appendChild(tabs);
}

(async function main() {
  // 图表 TUM 化:单字族 + 淡发丝网格 + 中性文字(减 chartjunk)
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 11;
  Chart.defaults.color = "#555";
  Chart.defaults.borderColor = "#ededed";

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
