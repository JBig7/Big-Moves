// Checks time model v0 against measured 2021 onboard trips (terminal wait + ride).
// Hold-out: calibration factors are re-derived from June trips only, then tested on July–August trips.
// Usage: node tests/validate_time_model.mjs [--md]
import { readFileSync, writeFileSync } from "node:fs";
import { createTimeModel } from "../web/js/timeModel.js";

const root = new URL("..", import.meta.url);
const net = JSON.parse(readFileSync(new URL("web/data/network.json", root)));
const shipped = JSON.parse(readFileSync(new URL("web/data/time_model_v0.json", root)));
const onboard = JSON.parse(readFileSync(new URL("recftfc_contactusformjosephghana/GIS/GIS/Processed/cleaned_onboard.geojson", root))).features;
const BAND = { "06:00 AM": 0, "10:00 AM": 1, "3:00 PM": 2 };

const pattern = new Map(net.patterns.filter((p) => p.src === "tfc").map((p) => [p.id.slice(4), p]));
const sched = (p, b) => (Array.isArray(p.t[0]) ? p.t[b] : p.t).reduce((a, x) => a + x, 0);
const t = (s) => (s ? Date.parse(s.replace(" ", "T").replace("+00", "Z")) / 1000 : NaN);

const trips = [];
for (const f of onboard) {
  const p = f.properties, pat = pattern.get(p.trip_id), b = BAND[p.interval_start];
  if (!pat || b == null) continue;
  const ride = t(p.finished_at) - t(p.departed_at), wait = t(p.departed_at) - t(p.arrived_at);
  const s = sched(pat, b);
  if (!(ride > 60 && wait >= 0 && wait < 3 * 3600 && s > 60 && ride / s > 0.3 && ride / s < 3)) continue;
  trips.push({ month: p.created_at.slice(0, 7), b, pat, s, ride, wait });
}

const q = (xs, p) => { xs = [...xs].sort((a, b) => a - b); const i = (xs.length - 1) * p, lo = Math.floor(i); return xs[lo] + (xs[Math.ceil(i)] - xs[lo]) * (i - lo); };
function calibrate(sample) {
  const params = structuredClone(shipped);
  for (let b = 0; b < 3; b++) {
    const r = sample.filter((x) => x.b === b);
    params.rideFactor[b] = shipped.rangeQuantiles.map((p) => q(r.map((x) => x.ride / x.s), p));
    params.terminalWait[b] = shipped.rangeQuantiles.map((p) => q(r.map((x) => x.wait), p));
  }
  return params;
}

function evaluate(tm, sample) {
  let inside = 0, absErr = 0, width = 0;
  for (const x of sample) {
    const est = tm.journey([tm.wait(null, true, x.b), tm.ride(x.s, x.pat.s.length, x.b)]);
    const actual = x.ride + x.wait;
    if (actual >= est.lo && actual <= est.hi) inside++;
    absErr += Math.abs(est.mid - actual);
    width += est.hi - est.lo;
  }
  const n = sample.length;
  return { n, coverage: inside / n, mae: absErr / n / 60, width: width / n / 60 };
}

const train = trips.filter((x) => x.month === "2021-06"), test = trips.filter((x) => x.month !== "2021-06");
const holdout = evaluate(createTimeModel(calibrate(train)), test);
const inSample = evaluate(createTimeModel(shipped), trips);
const naive = (() => { // plain schedule, no calibration or wait — the "generic estimate" baseline
  const n = test.length;
  return test.reduce((a, x) => a + Math.abs(x.s - (x.ride + x.wait)), 0) / n / 60;
})();

const fmt = (r) => `${r.n} trips · actual time inside range ${(100 * r.coverage).toFixed(0)}% · mid-estimate error ${r.mae.toFixed(1)} min (mean abs) · average range width ${r.width.toFixed(0)} min`;
const text = [
  "# Time model v0 validation", "",
  "Measured door-to-door from boarding terminal = waiting at terminal + ride (2021 onboard surveys, TfC routes only).", "",
  `- **Hold-out** (calibrated on June, tested on July–August): ${fmt(holdout)}`,
  `- Baseline for comparison, schedule only (no calibration, no wait): mean abs error ${naive.toFixed(1)} min on the same hold-out trips`,
  `- In-sample (shipped factors, all trips): ${fmt(inSample)}`, "",
  "Limits: the TfC schedules were themselves built from these surveys, so this checks calibration and range width,",
  "not route accuracy. 2015 central-Accra routes have no measured trips here and reuse the same factors.",
  "Independent checks (Phase 1 field trips, rider reports) are still needed.",
].join("\n");
if (process.argv.includes("--md")) writeFileSync(new URL("docs/time_model_validation.md", root), text + "\n");
console.log(text);
