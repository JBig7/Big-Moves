// Time model v0 — the only place journey times are estimated.
// Estimated time = segment travel time + dwell at stops + boarding/transfer wait (+ walking),
// scaled by calibration factors. Every value is a range {lo, mid, hi} in seconds.
// To drop in a better model, keep the same interface (ride, wait, walk, journey, limits).

export function createTimeModel(params) {
  const p = params;
  const range = (lo, mid, hi) => ({ lo, mid, hi });

  return {
    id: p.model,
    limits: p.limits,

    // schedSec: scheduled seconds between two stops (segments only); nStops: stops passed
    ride(schedSec, nStops, band) {
      const base = schedSec + p.dwellSec * Math.max(0, nStops - 1);
      const [lo, mid, hi] = p.rideFactor[band];
      return range(base * lo, base * mid, base * hi);
    },

    // headway: seconds between vehicles (null if unknown); atTerminal: boarding at the route's first stop
    wait(headway, atTerminal, band) {
      if (atTerminal) {
        const [lo, mid, hi] = p.terminalWait[band];
        return range(lo, mid, hi);
      }
      const h = headway || p.defaultHeadway[band];
      const [lo, mid, hi] = p.waitHeadwayFactor;
      return range(h * lo, h * mid, h * hi);
    },

    walk(sec) {
      return range(sec * 0.9, sec, sec * 1.3);
    },

    // Combine leg ranges into a journey range. Errors are treated as independent,
    // so the total spread grows with the square root of the sum of squares.
    journey(parts) {
      let mid = 0, dlo = 0, dhi = 0;
      for (const r of parts) {
        mid += r.mid;
        dlo += (r.mid - r.lo) ** 2;
        dhi += (r.hi - r.mid) ** 2;
      }
      return range(Math.max(0, mid - Math.sqrt(dlo)), mid, mid + Math.sqrt(dhi));
    },
  };
}

// Display helpers: never show a single exact figure.
export function formatRange(r, step = 5) {
  const lo = Math.max(step, Math.floor(r.lo / 60 / step) * step);
  let hi = Math.ceil(r.hi / 60 / step) * step;
  if (hi <= lo) hi = lo + step;
  return `${lo}–${hi} min`;
}

export function formatLegRange(r) {
  const lo = Math.max(1, Math.floor(r.lo / 60));
  let hi = Math.ceil(r.hi / 60);
  if (hi <= lo) hi = lo + 1;
  return `${lo}–${hi} min`;
}
