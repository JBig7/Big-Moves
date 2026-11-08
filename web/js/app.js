// BigMoves app shell: search, results, map and details. Routing and timing live in their own modules.
import { createRouter } from "./router.js";
import { createTimeModel, formatRange, formatLegRange } from "./timeModel.js";
import { createSearch, kindLabel } from "./search.js";

const $ = (id) => document.getElementById(id);
const LEG_COLORS = ["--leg1", "--leg2", "--leg3"];
const SRC_LABEL = { tfc: "2021 survey", am15: "2015 survey" };
const REPORTS_KEY = "bigmoves.reports.v1";

const state = {
  net: null, tm: null, router: null, search: null,
  from: null, to: null, band: defaultBand().band,
  options: [], sort: "time", active: 0,
};

let map, layers;

// ------------------------------------------------------------------ boot
init();

async function init() {
  setupMap();
  setupForm();
  try {
    const [net, tmParams] = await Promise.all([
      fetch("data/network.json").then(okJson),
      fetch("data/time_model_v0.json").then(okJson),
    ]);
    state.net = net;
    state.tm = createTimeModel(tmParams);
    state.router = createRouter(net, state.tm);
    state.search = createSearch(net);
    fillAbout();
    renderBands();
    restoreFromUrl();
  } catch (err) {
    console.error(err);
    showMessage("We couldn't load the route data. Check your connection and try again.", "error", {
      label: "Try again", onClick: () => location.reload(),
    });
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

function okJson(r) {
  if (!r.ok) throw new Error(`${r.url}: ${r.status}`);
  return r.json();
}

function defaultBand() {
  const h = new Date().getHours();
  const band = h < 10 ? 0 : h < 15 ? 1 : 2;
  return { band, outside: h < 6 || h >= 19 };
}

// ------------------------------------------------------------------ map
function setupMap() {
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([5.6037, -0.187], 11);
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · routes: GUMAP 2021 (TfC &amp; Transitec for MLGDRD, CC BY 4.0), Accra GTFS 2015 (CC BY 4.0)',
  }).addTo(map);
  let errors = 0;
  tiles.on("tileerror", () => { if (++errors > 3) $("tileNote").hidden = false; });
  tiles.on("tileload", () => { errors = 0; $("tileNote").hidden = true; });
  layers = L.layerGroup().addTo(map);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

const shapeCache = new Map();
function rideGeometry(leg) {
  const p = state.net.patterns[leg.pi];
  if (!shapeCache.has(leg.pi)) shapeCache.set(leg.pi, decodePolyline(p.shp));
  const pts = shapeCache.get(leg.pi);
  return pts.slice(p.sp[leg.from], p.sp[leg.to] + 1);
}

const stopLL = (i) => [state.net.stops.la[i], state.net.stops.lo[i]];

function legEnds(j) {
  // concrete coordinates for every walk leg (access/egress use the searched place)
  return j.legs.map((l) => {
    if (l.type !== "walk") return null;
    const a = l.access ? [state.from.la, state.from.lo] : stopLL(l.fromStop);
    const b = l.egress ? [state.to.la, state.to.lo] : stopLL(l.toStop);
    return [a, b];
  });
}

function drawJourneys() {
  layers.clearLayers();
  const bounds = [];
  state.options.forEach((j, idx) => {
    if (idx === state.active) return;
    j.legs.forEach((l) => {
      if (l.type === "ride") L.polyline(rideGeometry(l), { color: cssVar("--walk"), weight: 3, opacity: 0.35 }).addTo(layers);
    });
  });
  const j = state.options[state.active];
  if (j) {
    const ends = legEnds(j);
    let r = 0;
    j.legs.forEach((l, i) => {
      if (l.type === "walk") {
        L.polyline(ends[i], { color: cssVar("--walk"), weight: 4, dashArray: "4 8" }).addTo(layers);
        bounds.push(...ends[i]);
        return;
      }
      const color = cssVar(LEG_COLORS[r++ % 3]);
      const geo = rideGeometry(l);
      L.polyline(geo, { color: "#ffffff", weight: 9, opacity: 0.9 }).addTo(layers);
      L.polyline(geo, { color, weight: 6 }).addTo(layers);
      bounds.push(...geo);
      const p = state.net.patterns[l.pi];
      for (let k = l.from + 1; k < l.to; k++) {
        L.circleMarker(stopLL(p.s[k]), { radius: 3.5, color, weight: 2, fillColor: "#fff", fillOpacity: 1 })
          .bindTooltip(state.net.stops.n[p.s[k]]).addTo(layers);
      }
    });
    // board / transfer / alight points
    const rides = j.legs.filter((l) => l.type === "ride");
    rides.forEach((l, i) => {
      const p = state.net.patterns[l.pi];
      const board = p.s[l.from], alight = p.s[l.to];
      const isTransfer = i > 0;
      L.circleMarker(stopLL(board), {
        radius: isTransfer ? 8 : 7, color: "#1c1b18", weight: 2, fillColor: isTransfer ? cssVar("--accent") : "#fff", fillOpacity: 1,
      }).bindTooltip(`${isTransfer ? "Change at" : "Board at"} ${state.net.stops.n[board]}`, { permanent: isTransfer, direction: "top", className: "stop-label" }).addTo(layers);
      if (i === rides.length - 1) {
        L.circleMarker(stopLL(alight), { radius: 7, color: "#1c1b18", weight: 2, fillColor: "#fff", fillOpacity: 1 })
          .bindTooltip(`Get off at ${state.net.stops.n[alight]}`).addTo(layers);
      }
    });
  }
  drawEndpoints(bounds);
  if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
}

function drawEndpoints(bounds = []) {
  for (const [e, label, fill] of [[state.from, "Start", cssVar("--leg1")], [state.to, "Destination", cssVar("--danger")]]) {
    if (!e) continue;
    L.circleMarker([e.la, e.lo], { radius: 9, color: "#fff", weight: 3, fillColor: fill, fillOpacity: 1 })
      .bindTooltip(`${label}: ${e.n}`).addTo(layers);
    bounds.push([e.la, e.lo]);
  }
  return bounds;
}

// ------------------------------------------------------------------ form + suggestions
function setupForm() {
  for (const which of ["from", "to"]) setupAutocomplete(which);
  $("swapBtn").addEventListener("click", () => {
    [state.from, state.to] = [state.to, state.from];
    [$("fromInput").value, $("toInput").value] = [$("toInput").value, $("fromInput").value];
    if (state.options.length) runSearch();
  });
  $("tripForm").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });
  document.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    state.sort = b.dataset.sort;
    document.querySelectorAll("[data-sort]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    sortOptions();
    state.active = 0;
    renderOptions();
    drawJourneys();
  }));
  $("backBtn").addEventListener("click", () => showView("list"));
  $("aboutBtn").addEventListener("click", () => { updateReportCount(); $("aboutDlg").showModal(); });
  $("reportBtn").addEventListener("click", () => { $("reportNote").value = ""; $("reportDlg").showModal(); });
  $("reportDlg").addEventListener("close", () => { if ($("reportDlg").returnValue === "save") saveReport(); });
  $("exportReports").addEventListener("click", exportReports);
  $("clearReports").addEventListener("click", () => { writeReports([]); updateReportCount(); });
}

function setupAutocomplete(which) {
  const input = $(which + "Input"), list = $(which + "List");
  let items = [], sel = -1;

  const close = () => { list.hidden = true; sel = -1; input.setAttribute("aria-expanded", "false"); };
  const pick = (e) => {
    state[which] = e;
    input.value = e.n;
    close();
    if (which === "from") $("toInput").focus();
  };
  const render = () => {
    list.innerHTML = "";
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "s-empty";
      li.textContent = `No stops or places match "${input.value.trim()}". Try a station, market or area name.`;
      list.append(li);
    }
    items.forEach((e, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === sel));
      li.innerHTML = `<div class="s-name"></div><div class="s-meta"></div>`;
      li.firstChild.textContent = e.n;
      li.lastChild.textContent = [kindLabel(e.k), state.net.districts[e.d]].filter(Boolean).join(" · ");
      li.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(e); });
      list.append(li);
    });
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  input.addEventListener("input", () => {
    state[which] = null;
    if (!state.search) return;
    if (input.value.trim().length < 2) return close();
    items = state.search.find(input.value);
    sel = -1;
    render();
  });
  input.addEventListener("keydown", (ev) => {
    if (list.hidden || !items.length) return;
    if (ev.key === "ArrowDown") { sel = (sel + 1) % items.length; render(); ev.preventDefault(); }
    else if (ev.key === "ArrowUp") { sel = (sel - 1 + items.length) % items.length; render(); ev.preventDefault(); }
    else if (ev.key === "Enter" && sel >= 0) { pick(items[sel]); ev.preventDefault(); }
    else if (ev.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

function renderBands() {
  const g = $("bandGroup");
  g.innerHTML = "";
  state.net.bands.forEach((b, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(i === state.band));
    btn.textContent = b.label.replace(/ \(.*\)/, "");
    btn.title = b.label;
    btn.addEventListener("click", () => {
      state.band = i;
      g.querySelectorAll("button").forEach((x, k) => x.setAttribute("aria-checked", String(k === i)));
      $("bandNote").hidden = true;
      if (state.options.length) runSearch();
    });
    g.append(btn);
  });
  const { outside } = defaultBand();
  if (outside) {
    $("bandNote").textContent = "Trotro data covers 6am–7pm. Showing times for the nearest period.";
    $("bandNote").hidden = false;
  }
}

// ------------------------------------------------------------------ search
function resolve(which) {
  if (state[which]) return state[which];
  const text = $(which + "Input").value.trim();
  if (!text) return null;
  const hit = state.search.find(text, 1)[0];
  if (hit) { state[which] = hit; $(which + "Input").value = hit.n; }
  return hit || null;
}

function runSearch() {
  hideMessage();
  if (!state.router) return;
  const fromText = $("fromInput").value.trim(), toText = $("toInput").value.trim();
  if (!fromText || !toText) return showMessage("Enter where you are starting from and where you are going.");
  const from = resolve("from"), to = resolve("to");
  if (!from) return showMessage(`We couldn't find "${fromText}". Try a nearby station, market or area name.`);
  if (!to) return showMessage(`We couldn't find "${toText}". Try a nearby station, market or area name.`);
  if (from === to || (from.n === to.n && from.d === to.d)) return showMessage("Start and destination are the same place.");

  const t0 = performance.now();
  let opts;
  try {
    opts = state.router.plan(state.search.access(from), state.search.access(to), state.band);
  } catch (err) {
    console.error(err);
    return showMessage("Something went wrong while searching. Please try again.", "error");
  }
  console.info(`route search ${(performance.now() - t0).toFixed(0)} ms, ${opts.length} options`);
  state.options = opts;
  state.active = 0;
  sortOptions();
  writeUrl();

  if (!opts.length) {
    $("results").hidden = true;
    $("detail").hidden = true;
    layers.clearLayers();
    const b = drawEndpoints();
    if (b.length) map.fitBounds(b, { padding: [30, 30] });
    return showMessage(
      `We couldn't find a trotro journey from ${from.n} to ${to.n} with up to 2 changes. ` +
      `Our route data (2015 and 2021 surveys) may not cover this trip yet. Try a nearby main station.`);
  }
  showView("list");
  renderOptions();
  drawJourneys();
}

function sortOptions() {
  const byTime = (a, b) => a.time.mid - b.time.mid;
  state.options.sort(state.sort === "time" ? byTime : (a, b) => a.transfers - b.transfers || byTime(a, b));
}

// ------------------------------------------------------------------ rendering
const changesLabel = (n) => (n === 0 ? "Direct" : n === 1 ? "1 change" : `${n} changes`);
const stopName = (i) => state.net.stops.n[i];

function renderOptions() {
  const ol = $("optionList");
  ol.innerHTML = "";
  $("resultsTitle").textContent = `${state.options.length} option${state.options.length > 1 ? "s" : ""} · ${state.net.bands[state.band].label}`;
  state.options.forEach((j, idx) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option" + (idx === state.active ? " active" : "");
    const rides = j.legs.filter((l) => l.type === "ride");
    const p0 = state.net.patterns[rides[0].pi];
    const transfers = rides.slice(1).map((l) => stopName(state.net.patterns[l.pi].s[l.from]));
    btn.innerHTML = `
      <div class="opt-top"><span class="opt-time"></span><span class="chip ${j.transfers === 0 ? "direct" : ""}"></span></div>
      <div class="opt-legs"></div>
      <p class="opt-sub"></p>`;
    btn.querySelector(".opt-time").textContent = formatRange(j.time);
    btn.querySelector(".chip").textContent = changesLabel(j.transfers);
    const legsEl = btn.querySelector(".opt-legs");
    rides.forEach((l, i) => {
      if (i) legsEl.append("›");
      const s = document.createElement("span");
      s.className = "leg-pill";
      s.style.setProperty("--c", `var(${LEG_COLORS[i % 3]})`);
      s.textContent = state.net.patterns[l.pi].name;
      legsEl.append(s);
    });
    btn.querySelector(".opt-sub").textContent =
      `Board at ${stopName(p0.s[rides[0].from])}` + (transfers.length ? ` · change at ${transfers.join(", ")}` : "");
    btn.addEventListener("click", () => {
      state.active = idx;
      renderOptions();
      drawJourneys();
      showView("detail");
    });
    li.append(btn);
    ol.append(li);
  });
}

function renderDetail() {
  const j = state.options[state.active];
  const body = $("detailBody");
  body.innerHTML = "";
  const head = el("div", "detail-head");
  head.append(el("span", "opt-time", formatRange(j.time)), el("span", "chip" + (j.transfers ? "" : " direct"), changesLabel(j.transfers)));
  body.append(head, el("p", "disclaimer", `Estimated range for ${state.net.bands[state.band].label.toLowerCase()}. Based on 2015/2021 survey data; real times vary with traffic.`));

  const steps = el("ol", "steps");
  const add = (cls, color, title, ...lines) => {
    const li = el("li", "step " + cls);
    if (color) li.style.setProperty("--c", `var(${color})`);
    li.append(el("span", "dot"), el("h3", "", title));
    for (const l of lines) if (l) li.append(typeof l === "string" ? el("p", "", l) : l);
    steps.append(li);
    return li;
  };

  add("start", "--leg1", `Start at ${state.from.n}`);
  let r = 0;
  mergeWalks(j.legs).forEach((l) => {
    if (l.type === "walk") {
      const to = l.egress ? state.to.n : stopName(l.toStop);
      if (l.sec < 45 && !l.egress && !l.access) return;
      add("walk", null, `Walk to ${to}`, `About ${formatLegRange(l.time)}`);
      return;
    }
    const p = state.net.patterns[l.pi];
    const color = LEG_COLORS[r % 3];
    const isTransfer = r > 0;
    const waitText = l.from === 0
      ? `Wait ${formatLegRange(l.wait)} for the trotro to fill and leave the station`
      : `Wait ${formatLegRange(l.wait)} for a trotro` + (p.hw && p.hw[state.band] ? ` (about every ${Math.round(p.hw[state.band] / 60)} min)` : "");
    const routeLine = el("p");
    routeLine.append(el("span", "route", p.name), " ", el("span", "src", `· ${SRC_LABEL[p.src]}${p.code ? " · " + p.code : ""}`));
    add(isTransfer ? "transfer" : "board", color, `${isTransfer ? "Change at" : "Board at"} ${stopName(p.s[l.from])}`, routeLine, waitText);

    const n = l.to - l.from;
    const stopsBox = document.createElement("div");
    const toggle = el("button", "stops-toggle", `Show all ${p.s.length} stops on this route`);
    toggle.type = "button";
    const list = el("ol", "stop-list");
    list.hidden = true;
    p.s.forEach((s, k) => {
      const li = el("li", "", stopName(s));
      if (k >= l.from && k <= l.to) li.className = "ridden";
      if (k === l.from) li.className = "board";
      if (k === l.to) li.className = "alight";
      list.append(li);
    });
    toggle.addEventListener("click", () => {
      list.hidden = !list.hidden;
      toggle.textContent = list.hidden ? `Show all ${p.s.length} stops on this route` : "Hide stops";
    });
    stopsBox.append(toggle, list);
    add("ride", color, `Ride ${n} stop${n > 1 ? "s" : ""} · ${formatLegRange(l.time)}`, `Get off at ${stopName(p.s[l.to])}`, stopsBox);
    r++;
  });
  add("end", "--danger", `Arrive at ${state.to.n}`);
  body.append(steps);
}

// "walk to the stop, then walk to the next stop" reads as one step for the rider
function mergeWalks(legs) {
  const out = [];
  for (const l of legs) {
    const prev = out[out.length - 1];
    if (l.type === "walk" && prev && prev.type === "walk") {
      out[out.length - 1] = {
        ...prev, ...l, access: prev.access, sec: prev.sec + l.sec,
        time: { lo: prev.time.lo + l.time.lo, mid: prev.time.mid + l.time.mid, hi: prev.time.hi + l.time.hi },
      };
    } else out.push(l);
  }
  return out;
}

function showView(v) {
  $("results").hidden = v !== "list";
  $("detail").hidden = v !== "detail";
  if (v === "detail") {
    renderDetail();
    $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function el(tag, cls = "", text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function showMessage(text, kind = "", action) {
  const m = $("message");
  m.className = "message" + (kind ? " " + kind : "");
  m.textContent = text;
  if (action) {
    const b = el("button", "secondary", action.label);
    b.addEventListener("click", action.onClick);
    m.append(document.createElement("br"), b);
  }
  m.hidden = false;
}
function hideMessage() { $("message").hidden = true; }

// ------------------------------------------------------------------ about + reports
function fillAbout() {
  const { net, tm } = state;
  $("modelId").textContent = tm.id;
  $("dataVersion").textContent = `${net.meta.version} (built ${net.meta.built})`;
  $("limitsList").replaceChildren(...tm.limits.map((t) => el("li", "", t)));
  $("sourcesList").replaceChildren(...net.meta.sources.map((s) => el("li", "", `${s.name} — collected ${s.collected}. Licence: ${s.licence}.`)));
}

function readReports() {
  try { return JSON.parse(localStorage.getItem(REPORTS_KEY) || "[]"); } catch { return []; }
}
function writeReports(list) {
  try { localStorage.setItem(REPORTS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}
function updateReportCount() { $("reportCount").textContent = readReports().length; }

function saveReport() {
  const j = state.options[state.active];
  if (!j) return;
  const kind = new FormData($("reportForm")).get("kind");
  const list = readReports();
  list.push({
    at: new Date().toISOString(), kind, note: $("reportNote").value.trim(),
    dataVersion: state.net.meta.version, timeModel: state.tm.id, band: state.net.bands[state.band].id,
    from: state.from.n, to: state.to.n,
    legs: j.legs.filter((l) => l.type === "ride").map((l) => {
      const p = state.net.patterns[l.pi];
      return { pattern: p.id, board: state.net.stops.id[p.s[l.from]], alight: state.net.stops.id[p.s[l.to]] };
    }),
    estimate: { loMin: Math.round(j.time.lo / 60), hiMin: Math.round(j.time.hi / 60) },
  });
  writeReports(list);
  showMessage("Thanks — your report is saved on this phone.");
}

function exportReports() {
  const blob = new Blob([JSON.stringify(readReports(), null, 1)], { type: "application/json" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = "bigmoves-reports.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ shareable trip links
function writeUrl() {
  const q = new URLSearchParams({ from: state.from.i, to: state.to.i, t: state.net.bands[state.band].id });
  history.replaceState(null, "", "?" + q);
}

function restoreFromUrl() {
  const q = new URLSearchParams(location.search);
  const f = state.search.entries[q.get("from")], t = state.search.entries[q.get("to")];
  const b = state.net.bands.findIndex((x) => x.id === q.get("t"));
  if (b >= 0) {
    state.band = b;
    renderBands();
  }
  if (f && t) {
    state.from = f; state.to = t;
    $("fromInput").value = f.n; $("toInput").value = t.n;
    runSearch();
  }
}
