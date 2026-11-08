// Place and stop search (FR-01): prefix/word matching over pre-built entries.

const KIND_LABEL = {
  stop: "Trotro stop", bus_station: "Station", marketplace: "Market", hospital: "Hospital",
  university: "University", college: "College", mall: "Mall", attraction: "Attraction",
  museum: "Museum", hotel: "Hotel", aerodrome: "Airport", stadium: "Stadium",
  city: "City", town: "Town", suburb: "Area", neighbourhood: "Neighbourhood", quarter: "Area",
  village: "Village", locality: "Locality", hamlet: "Village",
};
const KIND_BOOST = { stop: 3, bus_station: 3, town: 3, suburb: 3, city: 3, marketplace: 2, mall: 1, university: 1, hospital: 1 };

export const kindLabel = (k) => KIND_LABEL[k] || "Place";

export function normalize(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function createSearch(net) {
  const entries = net.search.map((e, i) => ({ ...e, i, norm: normalize(e.n), words: normalize(e.n).split(" ") }));

  function score(e, q, qWords) {
    let s;
    if (e.norm === q) s = 100;
    else if (e.norm.startsWith(q)) s = 80;
    else if (qWords.every((w) => e.words.some((x) => x.startsWith(w)))) s = 60;
    else if (e.norm.includes(q)) s = 40;
    else return 0;
    // prefer entries served by more routes, and shorter names
    return s - (e.x ? 25 : 0) + (KIND_BOOST[e.k] || 0) + Math.log2(1 + (e.w || 0)) * 2 - e.norm.length * 0.05;
  }

  function find(text, limit = 8) {
    const q = normalize(text);
    if (q.length < 2) return [];
    const qWords = q.split(" ");
    const hits = [];
    for (const e of entries) {
      const s = score(e, q, qWords);
      if (s > 0) hits.push([s, e]);
    }
    hits.sort((a, b) => b[0] - a[0]);
    // collapse same name + district duplicates
    const seen = new Set();
    const out = [];
    for (const [, e] of hits) {
      const key = e.norm + "|" + e.d;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  // entry -> router access list [{stop, walk}]
  function access(e) {
    const out = [];
    for (let x = 0; x < e.a.length; x += 2) out.push({ stop: e.a[x], walk: e.a[x + 1] });
    return out;
  }

  return { find, access, entries };
}
