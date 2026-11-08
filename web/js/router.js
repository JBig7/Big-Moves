// Journey search over the pre-built route graph.
// Frequency-based RAPTOR: round k finds the best way to reach each stop using k trotro legs,
// with short walks allowed between rides. Costs come from the time model (mid estimates).

const MAX_LEGS = 3; // up to 2 transfers

export function createRouter(net, tm) {
  const nStops = net.stops.n.length;
  const P = net.patterns;

  // stop -> [patternIdx, positionInPattern, ...]
  const stopPatterns = Array.from({ length: nStops }, () => []);
  P.forEach((p, pi) => p.s.forEach((s, i) => stopPatterns[s].push(pi, i)));

  // cumulative scheduled seconds per pattern per band
  const cumCache = new Map();
  function cum(pi, band) {
    const key = pi * 3 + band;
    let c = cumCache.get(key);
    if (!c) {
      const p = P[pi];
      const seg = Array.isArray(p.t[0]) ? p.t[band] : p.t;
      c = new Float64Array(p.s.length);
      for (let i = 1; i < p.s.length; i++) c[i] = c[i - 1] + seg[i - 1];
      cumCache.set(key, c);
    }
    return c;
  }
  const headway = (pi, band) => (P[pi].hw ? P[pi].hw[band] : null);
  const rideMid = (pi, i, j, band) => tm.ride(cum(pi, band)[j] - cum(pi, band)[i], j - i, band).mid;
  const waitMid = (pi, i, band) => tm.wait(headway(pi, band), i === 0, band).mid;

  function raptor(origins, dests, band, excluded) {
    const ride = [], rpar = [], foot = [], fpar = [];
    const best = new Float64Array(nStops).fill(Infinity);
    for (let k = 0; k <= MAX_LEGS; k++) {
      ride.push(new Float64Array(nStops).fill(Infinity));
      foot.push(new Float64Array(nStops).fill(Infinity));
      rpar.push(new Map());
      fpar.push(new Map());
    }
    const egress = new Map(dests.map((d) => [d.stop, tm.walk(d.walk).mid]));
    const destWalk = new Map(dests.map((d) => [d.stop, d.walk]));

    let marked = new Set();
    for (const o of origins) {
      const c = tm.walk(o.walk).mid;
      if (c < ride[0][o.stop]) {
        ride[0][o.stop] = c;
        best[o.stop] = Math.min(best[o.stop], c);
        rpar[0].set(o.stop, { origin: true, walk: o.walk });
        marked.add(o.stop);
      }
    }
    relaxFoot(0, [...marked], marked);

    let bound = Infinity;
    const found = [];
    for (let k = 1; k <= MAX_LEGS && marked.size; k++) {
      const queue = new Map();
      for (const s of marked) {
        const sp = stopPatterns[s];
        for (let x = 0; x < sp.length; x += 2) {
          const pi = sp[x], i = sp[x + 1];
          if (excluded.has(pi)) continue;
          if (!queue.has(pi) || queue.get(pi) > i) queue.set(pi, i);
        }
      }
      const newly = new Set();
      for (const [pi, start] of queue) {
        const p = P[pi];
        let off = Infinity, bIdx = -1;
        for (let i = start; i < p.s.length; i++) {
          const s = p.s[i];
          if (bIdx >= 0) {
            const a = off + rideMid(pi, bIdx, i, band);
            if (a < best[s] && a < bound) {
              ride[k][s] = a;
              best[s] = a;
              rpar[k].set(s, { pi, from: bIdx, to: i });
              newly.add(s);
            }
          }
          const prev = Math.min(ride[k - 1][s], foot[k - 1][s]);
          if (prev < Infinity && i < p.s.length - 1) {
            // compare boarding options by their arrival cost at this same stop
            const cand = prev + waitMid(pi, i, band);
            const curr = bIdx >= 0 ? off + rideMid(pi, bIdx, i, band) : Infinity;
            if (cand < curr) {
              off = cand;
              bIdx = i;
            }
          }
        }
      }
      const rideMarked = [...newly];
      relaxFoot(k, rideMarked, newly);
      marked = newly;

      // best arrival at any destination after k legs
      let bestT = null;
      for (const [s, e] of egress) {
        const a = Math.min(ride[k][s], foot[k][s]) + e;
        if (a < (bestT ? bestT.cost : Infinity)) bestT = { stop: s, cost: a };
      }
      if (bestT && bestT.cost < bound) {
        bound = bestT.cost;
        found.push(reconstruct(k, bestT.stop, destWalk.get(bestT.stop)));
      }
    }
    return found;

    function relaxFoot(k, from, markSet) {
      for (const s of from) {
        const base = ride[k][s];
        const w = net.walk[s];
        for (let x = 0; x < w.length; x += 2) {
          const j = w[x], a = base + tm.walk(w[x + 1]).mid;
          if (a < best[j] && a < foot[k][j]) {
            foot[k][j] = a;
            best[j] = a;
            fpar[k].set(j, { from: s, sec: w[x + 1] });
            markSet.add(j);
          }
        }
      }
    }

    function reconstruct(k, stop, egressWalk) {
      const legs = [];
      if (egressWalk > 0) legs.push({ type: "walk", fromStop: stop, sec: egressWalk, egress: true });
      let s = stop;
      for (let r = k; r >= 0; r--) {
        if (foot[r][s] < ride[r][s]) {
          const f = fpar[r].get(s);
          legs.push({ type: "walk", fromStop: f.from, toStop: s, sec: f.sec });
          s = f.from;
        }
        const rp = rpar[r].get(s);
        if (r === 0) {
          if (rp.walk > 0) legs.push({ type: "walk", toStop: s, sec: rp.walk, access: true });
          break;
        }
        legs.push({ type: "ride", pi: rp.pi, from: rp.from, to: rp.to });
        s = P[rp.pi].s[rp.from];
      }
      return legs.reverse();
    }
  }

  // Every route that goes straight from the origin area to the destination area (FR-02).
  function directOptions(origins, dests, band) {
    const near = (list) => {
      const m = new Map();
      for (const o of list) {
        if (!m.has(o.stop) || m.get(o.stop).walk > o.walk) m.set(o.stop, { walk: o.walk, via: null });
      }
      for (const o of list) {
        const w = net.walk[o.stop];
        for (let x = 0; x < w.length; x += 2) {
          const t = o.walk + w[x + 1];
          if (!m.has(w[x]) || m.get(w[x]).walk > t) m.set(w[x], { walk: t, via: o.stop, viaWalk: o.walk, linkSec: w[x + 1] });
        }
      }
      return m;
    };
    const O = near(origins), D = near(dests);
    const out = [];
    const seenP = new Set();
    for (const [s] of O) {
      const sp = stopPatterns[s];
      for (let x = 0; x < sp.length; x += 2) {
        const pi = sp[x];
        if (seenP.has(pi)) continue;
        seenP.add(pi);
        const p = P[pi];
        let bestBoard = -1, bestOff = Infinity, bestJ = null;
        for (let i = 0; i < p.s.length; i++) {
          const st = p.s[i];
          if (bestBoard >= 0 && D.has(st)) {
            const cost = bestOff + rideMid(pi, bestBoard, i, band) + tm.walk(D.get(st).walk).mid;
            if (!bestJ || cost < bestJ.cost) bestJ = { cost, board: bestBoard, alight: i };
          }
          if (O.has(st) && i < p.s.length - 1) {
            const cand = tm.walk(O.get(st).walk).mid + waitMid(pi, i, band);
            const curr = bestBoard >= 0 ? bestOff + rideMid(pi, bestBoard, i, band) : Infinity;
            if (cand < curr) {
              bestOff = cand;
              bestBoard = i;
            }
          }
        }
        if (bestJ) {
          const legs = [];
          const o = O.get(p.s[bestJ.board]), d = D.get(p.s[bestJ.alight]);
          pushAccess(legs, o, p.s[bestJ.board]);
          legs.push({ type: "ride", pi, from: bestJ.board, to: bestJ.alight });
          pushEgress(legs, d, p.s[bestJ.alight]);
          out.push(legs);
        }
      }
    }
    return out;

    function pushAccess(legs, o, stop) {
      if (o.via == null) {
        if (o.walk > 0) legs.push({ type: "walk", toStop: stop, sec: o.walk, access: true });
      } else {
        if (o.viaWalk > 0) legs.push({ type: "walk", toStop: o.via, sec: o.viaWalk, access: true });
        legs.push({ type: "walk", fromStop: o.via, toStop: stop, sec: o.linkSec });
      }
    }
    function pushEgress(legs, d, stop) {
      if (d.via == null) {
        if (d.walk > 0) legs.push({ type: "walk", fromStop: stop, sec: d.walk, egress: true });
      } else {
        legs.push({ type: "walk", fromStop: stop, toStop: d.via, sec: d.linkSec });
        if (d.viaWalk > 0) legs.push({ type: "walk", fromStop: d.via, sec: d.viaWalk, egress: true });
      }
    }
  }

  // Attach time ranges to each leg and the journey total.
  function evaluate(legs, band) {
    const parts = [];
    const out = legs.map((l) => {
      if (l.type === "walk") {
        const t = tm.walk(l.sec);
        parts.push(t);
        return { ...l, time: t };
      }
      const c = cum(l.pi, band);
      const wait = tm.wait(headway(l.pi, band), l.from === 0, band);
      const rt = tm.ride(c[l.to] - c[l.from], l.to - l.from, band);
      parts.push(wait, rt);
      return { ...l, wait, time: rt };
    });
    const rides = out.filter((l) => l.type === "ride");
    return { legs: out, rides: rides.length, transfers: rides.length - 1, time: tm.journey(parts) };
  }

  // Public: ranked, de-duplicated options for a trip.
  function plan(origins, dests, band) {
    const raw = [...directOptions(origins, dests, band)];
    const excluded = new Set();
    for (let iter = 0; iter < 4; iter++) {
      const found = raptor(origins, dests, band, excluded);
      if (!found.length) break;
      raw.push(...found);
      for (const legs of found) {
        const rides = legs.filter((l) => l.type === "ride");
        // exclude the longest leg so the next pass finds a genuinely different option
        const longest = rides.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
        excluded.add(longest.pi);
      }
    }
    const seen = new Set();
    let opts = [];
    for (const legs of raw) {
      const j = evaluate(legs, band);
      if (!j.rides) continue;
      const sig = j.legs.filter((l) => l.type === "ride").map((l) => P[l.pi].name).join("|");
      if (seen.has(sig)) continue;
      seen.add(sig);
      opts.push(j);
    }
    opts.sort((a, b) => a.time.mid - b.time.mid);
    if (opts.length) {
      const bestMid = opts[0].time.mid;
      const fewest = Math.min(...opts.map((o) => o.transfers));
      // keep options that are not absurdly slower, but always keep the fewest-transfer one
      opts = opts.filter((o, i) => i < 3 || o.time.mid < bestMid * 1.8 + 900 || o.transfers === fewest);
      // drop options dominated on both time and transfers by a much better one
      opts = opts.filter((o) => !opts.some((q) => q !== o && q.transfers < o.transfers && q.time.mid <= o.time.mid));
    }
    return opts.slice(0, 8);
  }

  return { plan, evaluate, stopPatterns };
}
