/* OFN Briefing Board
   - Data: data/ofn_roster.json + data/checkpoints.json
   - GeoJSON: remote countries dataset
*/

const BUILD = "2026-03-03";

const el = (id) => document.getElementById(id);
const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

const UI = {
  netDot: el("netDot"),
  netText: el("netText"),

  modeBorders: el("modeBorders"),
  modeSignals: el("modeSignals"),

  themeArchive: el("themeArchive"),
  themeOps: el("themeOps"),

  fitBtn: el("fitBtn"),
  resetBtn: el("resetBtn"),

  search: el("search"),
  clearPinsBtn: el("clearPinsBtn"),

  tabNations: el("tabNations"),
  tabCheckpoints: el("tabCheckpoints"),
  tabFiction: el("tabFiction"),

  statusFilter: el("statusFilter"),
  yearFilter: el("yearFilter"),
  yearLabel: el("yearLabel"),
  cpTypeFilter: el("cpTypeFilter"),

  listTitle: el("listTitle"),
  listCount: el("listCount"),
  list: el("list"),

  right: el("right"),
  dName: el("dName"),
  dMini: el("dMini"),
  dBadgeBox: el("dBadgeBox"),
  dBody: el("dBody"),
  zoomBtn: el("zoomBtn"),
  pinBtn: el("pinBtn"),
  closeBtn: el("closeBtn"),

  hoverChip: el("hoverChip"),
  coordChip: el("coordChip"),
  pinChip: el("pinChip"),
  buildChip: el("buildChip"),
};

UI.buildChip.textContent = `Build: ${BUILD}`;

/* ---------- Theme ---------- */
function setTheme(theme){
  document.documentElement.setAttribute("data-theme", theme === "ops" ? "ops" : "archive");
  UI.themeArchive.classList.toggle("on", theme !== "ops");
  UI.themeOps.classList.toggle("on", theme === "ops");
  refreshStyles();
}

/* ---------- Data state ---------- */
let ROSTER = null;
let CHECKPOINTS = [];
let MAP = null;
let BASE = null;
let COUNTRIES = null;

let MODE = "borders"; // borders | signals
let ACTIVE_TAB = "nations"; // nations | checkpoints | fiction

let selected = null; // {kind:'nation'|'checkpoint'|'fiction', id/name, layer?, feature?, cp?}
let pinned = []; // array of selected-like entries (minimal)

let signalsLayer = null;      // centroid beacons
let checkpointsLayer = null;  // checkpoint shapes + beacons

const STATUS_ORDER = {
  founding: 0, member: 1, observer: 2, partner: 3, invite: 4, sanctioned: 5, neutral: 6
};

function statusLabel(s){
  return ({
    founding: "Founding",
    member: "Member",
    observer: "Observer",
    partner: "Partner",
    invite: "Invite",
    sanctioned: "Sanctioned",
    neutral: "Neutral",
  }[s] || "Neutral");
}

function statusTagClass(s){
  return (["founding","member","observer","partner","invite","sanctioned","neutral"].includes(s) ? s : "neutral");
}

function statusColor(s){
  const css = getComputedStyle(document.documentElement);
  const ofn = css.getPropertyValue("--ofn").trim() || "#1f5cff";
  const gold = css.getPropertyValue("--gold").trim() || "#caa34a";
  const good = css.getPropertyValue("--good").trim() || "#1a7f5a";
  const warn = css.getPropertyValue("--warn").trim() || "#b66a00";
  const bad  = css.getPropertyValue("--bad").trim() || "#b0122b";

  return ({
    founding: gold,
    member: ofn,
    observer: good,
    partner: ofn,
    invite: warn,
    sanctioned: bad,
    neutral: "rgba(127,127,127,.55)",
  }[s] || "rgba(127,127,127,.55)");
}

function escapeHTML(s){
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

/* ---------- Net indicator ---------- */
function setNet(state, label){
  UI.netText.textContent = label;
  UI.netDot.style.background = state === "ok" ? statusColor("observer")
    : state === "warn" ? statusColor("invite")
    : statusColor("sanctioned");
}

/* ---------- Dossier ---------- */
function openDossier(){ UI.right.classList.add("open"); UI.right.classList.remove("closed"); }
function closeDossier(){ UI.right.classList.remove("open"); UI.right.classList.add("closed"); }

function setDossierHeader(badgeText, name, mini){
  UI.dBadgeBox.textContent = badgeText || "OFN";
  UI.dName.textContent = name || "—";
  UI.dMini.textContent = mini || "—";
}

function makeCard(title, inner){
  return `<div class="card"><h3>${escapeHTML(title)}</h3>${inner}</div>`;
}
function kv(k, v){
  return `<div class="kv"><div class="k">${escapeHTML(k)}</div><div class="v">${v}</div></div>`;
}
function badgeLine(badges){
  const html = (badges || []).map(t => `<span class="b">${escapeHTML(t)}</span>`).join("");
  return `<div class="badgeLine">${html}</div>`;
}

/* ---------- Wikipedia brief (optional, cached) ---------- */
const WIKI_CACHE_PREFIX = "ofn_bb_wiki:";
const WIKI_TTL = 7 * 24 * 3600 * 1000;

function cacheGet(key){
  try{
    const raw = localStorage.getItem(WIKI_CACHE_PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.t || !obj.data) return null;
    if (Date.now() - obj.t > WIKI_TTL) return null;
    return obj.data;
  }catch(_){ return null; }
}
function cacheSet(key, data){
  try{ localStorage.setItem(WIKI_CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), data })); }catch(_){}
}

async function fetchJsonTimeout(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try{
    const res = await fetch(url, { headers:{accept:"application/json"}, signal: ctrl.signal });
    if (!res.ok) throw new Error("http");
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function wikiSummary(title){
  const cached = cacheGet(title);
  if (cached) return { ...cached, _cached:true };

  const t = encodeURIComponent(String(title).replace(/\s+/g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${t}`;
  const tries = [0, 350, 850];
  let last = null;

  for (const wait of tries){
    if (wait) await new Promise(r => setTimeout(r, wait));
    try{
      const data = await fetchJsonTimeout(url, 4500);
      cacheSet(title, data);
      return data;
    }catch(e){ last = e; }
  }
  throw last || new Error("wiki");
}

/* ---------- Selection + Pins ---------- */
function pinCurrent(){
  if (!selected) return;
  const key = `${selected.kind}:${selected.id}`;
  if (pinned.some(p => `${p.kind}:${p.id}` === key)) return;
  pinned.push({ kind: selected.kind, id: selected.id, name: selected.name });
  UI.pinChip.textContent = `Pins: ${pinned.length}`;
}

function clearPins(){
  pinned = [];
  UI.pinChip.textContent = `Pins: 0`;
}

/* ---------- List rendering ---------- */
function setTab(tab){
  ACTIVE_TAB = tab;
  UI.tabNations.classList.toggle("on", tab === "nations");
  UI.tabCheckpoints.classList.toggle("on", tab === "checkpoints");
  UI.tabFiction.classList.toggle("on", tab === "fiction");

  UI.tabNations.setAttribute("aria-selected", tab === "nations");
  UI.tabCheckpoints.setAttribute("aria-selected", tab === "checkpoints");
  UI.tabFiction.setAttribute("aria-selected", tab === "fiction");

  UI.listTitle.textContent = tab === "nations" ? "Nations"
    : tab === "checkpoints" ? "Checkpoints"
    : "Fiction";

  renderList();
}

function currentYear(){
  return Number(UI.yearFilter.value || 2026);
}

function matchSearch(name, extra=""){
  const q = norm(UI.search.value);
  if (!q) return true;
  const hay = norm(name + " " + extra);
  return hay.includes(q);
}

function matchesStatusFilter(status){
  const f = UI.statusFilter.value || "all";
  if (f === "all") return true;
  return status === f;
}

function inActiveWindow(item){
  // if no window, treat as always active
  const y = currentYear();
  const a = Number(item.active_from ?? item.since ?? 0) || 0;
  const b = Number(item.active_to ?? 9999) || 9999;
  return y >= a && y <= b;
}

function matchesCheckpointType(cp){
  const f = UI.cpTypeFilter.value || "all";
  if (f === "all") return true;
  return (cp.type || "") === f;
}

function itemTag(status){
  const cls = statusTagClass(status);
  return `<span class="tag ${cls}">${escapeHTML(statusLabel(status))}</span>`;
}

function renderList(){
  if (!ROSTER) return;

  let items = [];
  if (ACTIVE_TAB === "nations"){
    items = (ROSTER.nations || [])
      .filter(n => matchesStatusFilter(n.status || "neutral"))
      .filter(n => inActiveWindow(n))
      .filter(n => matchSearch(n.name, n.code || ""));
    items.sort((a,b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));

    UI.list.innerHTML = items.map(n => `
      <div class="item" role="listitem" data-kind="nation" data-id="${escapeHTML(n.code || n.name)}">
        <div class="iLeft">
          <div class="iName">${escapeHTML(n.name)}</div>
          <div class="iSub">${escapeHTML(n.code ? `${n.code} • ${n.region || "—"}` : (n.region || "—"))}</div>
        </div>
        <div class="iRight">
          ${itemTag(n.status)}
        </div>
      </div>
    `).join("");
  }

  if (ACTIVE_TAB === "checkpoints"){
    items = (CHECKPOINTS || [])
      .filter(cp => matchesCheckpointType(cp))
      .filter(cp => inActiveWindow(cp))
      .filter(cp => matchSearch(cp.name, `${cp.type || ""} ${cp.region || ""}`));
    items.sort((a,b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name));

    UI.list.innerHTML = items.map(cp => `
      <div class="item" role="listitem" data-kind="checkpoint" data-id="${escapeHTML(cp.id)}">
        <div class="iLeft">
          <div class="iName">${escapeHTML(cp.name)}</div>
          <div class="iSub">${escapeHTML(`${cp.type || "Checkpoint"} • ${cp.region || "—"}`)}</div>
        </div>
        <div class="iRight">
          <span class="tag ${cp.severity === "High" ? "sanctioned" : cp.severity === "Medium" ? "invite" : "observer"}">
            ${escapeHTML(cp.severity || "Low")}
          </span>
        </div>
      </div>
    `).join("");
  }

  if (ACTIVE_TAB === "fiction"){
    items = (ROSTER.fiction || [])
      .filter(f => matchesStatusFilter(f.status || "neutral"))
      .filter(f => inActiveWindow(f))
      .filter(f => matchSearch(f.name, f.polity || ""));
    items.sort((a,b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));

    UI.list.innerHTML = items.map(f => `
      <div class="item" role="listitem" data-kind="fiction" data-id="${escapeHTML(f.id || f.name)}">
        <div class="iLeft">
          <div class="iName">${escapeHTML(f.name)}</div>
          <div class="iSub">${escapeHTML(f.polity || "Fictional entry")}</div>
        </div>
        <div class="iRight">
          ${itemTag(f.status)}
        </div>
      </div>
    `).join("");
  }

  UI.listCount.textContent = String(items.length);
}

/* ---------- Map ---------- */
function baseTiles(theme){
  const isOps = theme === "ops";
  // Use CARTO tiles; you can swap these if you want a different map provider later.
  const url = isOps
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";

  if (BASE) BASE.remove();
  BASE = L.tileLayer(url, {
    subdomains: "abcd",
    minZoom: 2,
    maxZoom: 7,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
  }).addTo(MAP);
}

function countryName(feature){
  return feature?.properties?.name || feature?.properties?.ADMIN || feature?.properties?.Name || "";
}

function nationByName(name){
  const n = norm(name);
  return (ROSTER?.nations || []).find(x => norm(x.name) === n) || null;
}

function statusOfCountry(feature){
  const nm = countryName(feature);
  const entry = nationByName(nm);
  return entry?.status || "neutral";
}

function styleBorders(feature){
  const theme = document.documentElement.getAttribute("data-theme");
  const day = theme !== "ops";
  const hair = day ? "rgba(0,0,0,.22)" : "rgba(255,255,255,.16)";

  const s = statusOfCountry(feature);
  const col = statusColor(s);

  // Borders mode: soft fill for members, otherwise almost transparent.
  let fillOpacity = (s === "member" || s === "founding") ? 0.18 : (s === "observer" ? 0.12 : 0.06);
  let weight = 1.0;

  // If status filter active, dim non-matching.
  const f = UI.statusFilter.value || "all";
  if (f !== "all" && s !== f){
    fillOpacity = Math.min(fillOpacity, 0.03);
    weight = 0.8;
  }

  return {
    color: hair,
    weight,
    opacity: 0.9,
    fillColor: col,
    fillOpacity
  };
}

function centroidLatLng(layer){
  try{
    const b = layer.getBounds();
    return b.getCenter();
  }catch(_){ return null; }
}

function beaconIcon(color){
  return L.divIcon({
    className: "ofnBeacon",
    html: `
      <div style="
        width:14px;height:14px;border-radius:999px;
        background:${color};
        box-shadow:0 0 0 6px color-mix(in srgb, ${color} 20%, transparent),
                   0 0 0 14px color-mix(in srgb, ${color} 10%, transparent);
        border:1px solid rgba(255,255,255,.22);
      "></div>`,
    iconSize: [14,14],
    iconAnchor: [7,7],
  });
}

function rebuildSignals(){
  if (!MAP || !COUNTRIES) return;

  if (signalsLayer){
    signalsLayer.remove();
    signalsLayer = null;
  }

  signalsLayer = L.layerGroup();

  COUNTRIES.eachLayer(layer => {
    const nm = countryName(layer.feature);
    const entry = nationByName(nm);
    if (!entry) return;

    // Apply filters
    if (!matchesStatusFilter(entry.status)) return;
    if (!inActiveWindow(entry)) return;

    const c = centroidLatLng(layer);
    if (!c) return;

    const m = L.marker(c, { icon: beaconIcon(statusColor(entry.status)), riseOnHover:true });
    m.on("click", (e) => {
      const alt = e.originalEvent?.altKey;
      selectNationByName(entry.name, layer, alt);
    });
    m.bindTooltip(`${entry.name} • ${statusLabel(entry.status)}`, { direction:"top", opacity:0.9 });
    m.addTo(signalsLayer);
  });

  signalsLayer.addTo(MAP);
}

function styleCheckpointShape(cp){
  const theme = document.documentElement.getAttribute("data-theme");
  const day = theme !== "ops";
  const hair = day ? "rgba(0,0,0,.30)" : "rgba(255,255,255,.20)";

  const sev = cp.severity || "Low";
  const col = sev === "High" ? statusColor("sanctioned")
    : sev === "Medium" ? statusColor("invite")
    : statusColor("observer");

  return {
    color: hair,
    weight: 2,
    opacity: 0.9,
    fillColor: col,
    fillOpacity: 0.16
  };
}

function rebuildCheckpoints(){
  if (!MAP) return;

  if (checkpointsLayer){
    checkpointsLayer.remove();
    checkpointsLayer = null;
  }
  checkpointsLayer = L.layerGroup();

  const y = currentYear();

  for (const cp of CHECKPOINTS){
    if (!inActiveWindow(cp)) continue;
    if (!matchesCheckpointType(cp)) continue;

    // shape
    const center = L.latLng(cp.lat, cp.lng);
    let shapeLayer = null;

    const shape = String(cp.shape || "circle").toLowerCase();
    if (shape === "square" || shape === "rect" || shape === "rectangle"){
      const halfKm = Math.max(6, Number(cp.size_km || 18));
      const dLat = halfKm / 111;
      const dLng = halfKm / (111 * Math.cos(center.lat * Math.PI/180) || 1);
      const bounds = L.latLngBounds(
        [center.lat - dLat, center.lng - dLng],
        [center.lat + dLat, center.lng + dLng]
      );
      shapeLayer = L.rectangle(bounds, styleCheckpointShape(cp));
    } else {
      const radiusKm = Math.max(10, Number(cp.radius_km || 22));
      shapeLayer = L.circle(center, { radius: radiusKm * 1000, ...styleCheckpointShape(cp) });
    }

    shapeLayer.on("click", (e) => {
      const alt = e.originalEvent?.altKey;
      selectCheckpoint(cp.id, alt);
    });

    // beacon marker
    const color = (cp.severity === "High") ? statusColor("sanctioned")
      : (cp.severity === "Medium") ? statusColor("invite")
      : statusColor("observer");

    const beacon = L.marker(center, { icon: beaconIcon(color), riseOnHover:true });
    beacon.on("click", (e) => {
      const alt = e.originalEvent?.altKey;
      selectCheckpoint(cp.id, alt);
    });

    const tip = `${cp.name} • ${cp.type || "Checkpoint"} • ${cp.severity || "Low"} • Active ${cp.active_from || "—"}–${cp.active_to || "—"}`;
    beacon.bindTooltip(tip, { direction:"top", opacity:0.9 });

    shapeLayer.addTo(checkpointsLayer);
    beacon.addTo(checkpointsLayer);
  }

  checkpointsLayer.addTo(MAP);
}

function setMode(mode){
  MODE = mode;
  UI.modeBorders.classList.toggle("on", mode === "borders");
  UI.modeSignals.classList.toggle("on", mode === "signals");

  if (COUNTRIES){
    // In signals mode, make borders much lighter.
    refreshStyles();
  }
  if (signalsLayer){
    signalsLayer.remove();
    signalsLayer = null;
  }
  if (MODE === "signals"){
    rebuildSignals();
  }
}

/* ---------- Selectors ---------- */
function selectNationByName(name, layer, pin=false){
  const entry = (ROSTER.nations || []).find(n => n.name === name) || nationByName(name);
  const status = entry?.status || "neutral";

  selected = { kind:"nation", id: entry?.code || name, name, layer, entry };
  setDossierHeader("NATION", name, `${statusLabel(status)} • ${entry?.region || "—"}`);
  openDossier();

  const badges = [
    statusLabel(status),
    entry?.since ? `Since ${entry.since}` : null,
    entry?.code ? entry.code : null
  ].filter(Boolean);

  UI.dBody.innerHTML = [
    makeCard("Classification", `
      ${badgeLine(badges)}
      ${kv("Status", `<span class="v">${escapeHTML(statusLabel(status))}</span>`)}
      ${entry?.seat ? kv("Seat", escapeHTML(entry.seat)) : ""}
      ${entry?.notes ? kv("Notes", `<span class="v">${escapeHTML(entry.notes)}</span>`) : ""}
    `),
    makeCard("Brief", `<p class="p" id="wikiLine">Loading brief…</p>`)
  ].join("");

  // Zoom helper
  UI.zoomBtn.onclick = () => {
    if (layer){
      try{ MAP.fitBounds(layer.getBounds().pad(0.22)); }catch(_){}
    }
  };

  UI.pinBtn.onclick = () => pinCurrent();

  if (pin) pinCurrent();

  // Wiki (best effort; never “angry error”)
  (async () => {
    const line = document.getElementById("wikiLine");
    if (!line) return;

    try{
      const data = await wikiSummary(name);
      if (data?.type === "disambiguation"){
        line.textContent = "Brief unavailable (disambiguation).";
        return;
      }
      const text = (data?.extract || data?.description || "").trim();
      if (!text){
        line.textContent = "Brief temporarily unavailable.";
        return;
      }
      line.textContent = text;
    }catch(_){
      line.textContent = "Brief temporarily unavailable (network).";
    }
  })();
}

function selectCheckpoint(id, pin=false){
  const cp = CHECKPOINTS.find(x => x.id === id);
  if (!cp) return;

  selected = { kind:"checkpoint", id: cp.id, name: cp.name, cp };
  setDossierHeader("SITE", cp.name, `${cp.type || "Checkpoint"} • ${cp.region || "—"}`);
  openDossier();

  const badges = [
    cp.type || "Checkpoint",
    cp.severity ? `${cp.severity} Severity` : null,
    (cp.active_from || cp.active_to) ? `Active ${cp.active_from || "—"}–${cp.active_to || "—"}` : null
  ].filter(Boolean);

  const metaRows = cp.meta ? Object.entries(cp.meta).map(([k,v]) => kv(k, escapeHTML(String(v)))) : [];
  UI.dBody.innerHTML = [
    makeCard("Snapshot", `
      ${badgeLine(badges)}
      ${kv("Role", escapeHTML(cp.role || "—"))}
      ${kv("Access", escapeHTML(cp.access || "—"))}
      ${kv("Coordinates", escapeHTML(`${cp.lat.toFixed(3)}, ${cp.lng.toFixed(3)}`))}
      ${kv("Priority", escapeHTML(String(cp.priority ?? "—")))}
    `),
    makeCard("Key facts", metaRows.length ? metaRows.join("") : `<p class="p">—</p>`),
    makeCard("Overview", `<p class="p">${escapeHTML(cp.overview || "—")}</p>`),
    cp.image ? makeCard("Image", `
      <div style="border:1px solid var(--hair); border-radius:14px; overflow:hidden;">
        <img src="${escapeHTML(cp.image)}" alt="${escapeHTML(cp.name)}" style="width:100%; height:auto; display:block;">
      </div>
    `) : ""
  ].join("");

  UI.zoomBtn.onclick = () => {
    const center = L.latLng(cp.lat, cp.lng);
    MAP.setView(center, Math.max(MAP.getZoom(), 5));
  };
  UI.pinBtn.onclick = () => pinCurrent();
  if (pin) pinCurrent();
}

function selectFiction(id, pin=false){
  const f = (ROSTER.fiction || []).find(x => (x.id || x.name) === id) || null;
  if (!f) return;

  selected = { kind:"fiction", id: f.id || f.name, name: f.name, f };
  setDossierHeader("FILE", f.name, `${statusLabel(f.status || "neutral")} • Fictional`);
  openDossier();

  const badges = [
    statusLabel(f.status || "neutral"),
    f.since ? `Since ${f.since}` : null
  ].filter(Boolean);

  const metaRows = f.meta ? Object.entries(f.meta).map(([k,v]) => kv(k, escapeHTML(String(v)))) : [];
  UI.dBody.innerHTML = [
    makeCard("Classification", `${badgeLine(badges)}${kv("Polity", escapeHTML(f.polity || "—"))}`),
    makeCard("Key facts", metaRows.length ? metaRows.join("") : `<p class="p">—</p>`),
    makeCard("Overview", `<p class="p">${escapeHTML(f.overview || "—")}</p>`)
  ].join("");

  UI.zoomBtn.onclick = () => { /* Fiction: no map target */ };
  UI.pinBtn.onclick = () => pinCurrent();
  if (pin) pinCurrent();
}

/* ---------- Hover intelligence ---------- */
function setCoord(lat, lng){
  UI.coordChip.textContent = `Lat ${lat.toFixed(2)}, Lng ${lng.toFixed(2)}`;
}

/* ---------- Styles refresh ---------- */
function refreshStyles(){
  if (COUNTRIES){
    COUNTRIES.eachLayer(l => {
      const st = styleBorders(l.feature);
      // In signals mode: make fills extremely subtle (borders only-ish)
      if (MODE === "signals"){
        st.fillOpacity = Math.min(st.fillOpacity, 0.04);
        st.opacity = Math.min(st.opacity, 0.75);
        st.weight = Math.min(st.weight, 0.9);
      }
      l.setStyle(st);
    });
  }
  rebuildCheckpoints();
  if (MODE === "signals") rebuildSignals();
}

/* ---------- Map init ---------- */
async function loadData(){
  setNet("warn", "LOADING");
  try{
    const [rosterRes, cpRes] = await Promise.all([
      fetch(`data/ofn_roster.json?v=${encodeURIComponent(BUILD)}`, { cache:"no-store" }),
      fetch(`data/checkpoints.json?v=${encodeURIComponent(BUILD)}`, { cache:"no-store" })
    ]);

    ROSTER = await rosterRes.json();
    CHECKPOINTS = await cpRes.json();

    setNet("ok", "ONLINE");
  }catch(_){
    setNet("bad", "OFFLINE");
    ROSTER = { nations:[], fiction:[] };
    CHECKPOINTS = [];
  }
}

async function loadGeo(){
  const geoUrl = `https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson?v=${encodeURIComponent(BUILD)}`;
  const res = await fetch(geoUrl);
  return await res.json();
}

function initMap(){
  MAP = L.map("map", {
    zoomControl: true,
    preferCanvas: true,
    worldCopyJump: true,
    minZoom: 2,
    maxZoom: 7,
    maxBounds: L.latLngBounds(L.latLng(-85, -180), L.latLng(85, 180)),
    maxBoundsViscosity: 1.0
  }).setView([22, 0], 2);

  baseTiles(document.documentElement.getAttribute("data-theme") === "ops" ? "ops" : "archive");

  MAP.on("mousemove", (e) => setCoord(e.latlng.lat, e.latlng.lng));
  setCoord(0,0);

  // country under cursor label (cheap: use events from layers)
  UI.hoverChip.textContent = "Hover: —";
}

function wireUI(){
  // theme
  UI.themeArchive.addEventListener("click", () => { setTheme("archive"); baseTiles("archive"); });
  UI.themeOps.addEventListener("click", () => { setTheme("ops"); baseTiles("ops"); });

  // mode
  UI.modeBorders.addEventListener("click", () => setMode("borders"));
  UI.modeSignals.addEventListener("click", () => setMode("signals"));

  // tabs
  UI.tabNations.addEventListener("click", () => setTab("nations"));
  UI.tabCheckpoints.addEventListener("click", () => setTab("checkpoints"));
  UI.tabFiction.addEventListener("click", () => setTab("fiction"));

  // filters
  UI.statusFilter.addEventListener("change", () => { renderList(); refreshStyles(); });
  UI.cpTypeFilter.addEventListener("change", () => { renderList(); refreshStyles(); });

  UI.yearFilter.addEventListener("input", () => {
    UI.yearLabel.textContent = String(currentYear());
    renderList();
    refreshStyles();
  });
  UI.yearLabel.textContent = String(currentYear());

  // search
  UI.search.addEventListener("input", () => renderList());

  // dossier controls
  UI.closeBtn.addEventListener("click", closeDossier);

  // fit/reset
  UI.fitBtn.addEventListener("click", () => {
    if (COUNTRIES){
      const b = COUNTRIES.getBounds();
      if (b && b.isValid()) MAP.fitBounds(b.pad(0.02));
    } else {
      MAP.setView([22,0], 2);
    }
  });

  UI.resetBtn.addEventListener("click", () => {
    UI.search.value = "";
    UI.statusFilter.value = "all";
    UI.cpTypeFilter.value = "all";
    UI.yearFilter.value = "2026";
    UI.yearLabel.textContent = "2026";
    clearPins();
    closeDossier();
    setMode("borders");
    setTab("nations");
    renderList();
    refreshStyles();
    if (MAP) MAP.closePopup();
  });

  // pins
  UI.clearPinsBtn.addEventListener("click", clearPins);

  // list click
  UI.list.addEventListener("click", (e) => {
    const it = e.target.closest(".item");
    if (!it) return;
    const kind = it.getAttribute("data-kind");
    const id = it.getAttribute("data-id");
    const alt = e.altKey;

    if (kind === "nation"){
      // find map layer by name if possible, else still open dossier
      const entry = (ROSTER.nations || []).find(n => (n.code || n.name) === id) || null;
      const nm = entry?.name || id;

      let layerFound = null;
      if (COUNTRIES){
        COUNTRIES.eachLayer(l => {
          if (layerFound) return;
          if (norm(countryName(l.feature)) === norm(nm)) layerFound = l;
        });
      }
      selectNationByName(nm, layerFound, alt);
      if (layerFound){
        try{ MAP.fitBounds(layerFound.getBounds().pad(0.22)); }catch(_){}
      }
    }

    if (kind === "checkpoint"){
      selectCheckpoint(id, alt);
      const cp = CHECKPOINTS.find(x => x.id === id);
      if (cp) MAP.setView([cp.lat, cp.lng], Math.max(MAP.getZoom(), 5));
    }

    if (kind === "fiction"){
      selectFiction(id, alt);
    }
  });

  // keyboard
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDossier();
  });
}

/* ---------- Boot ---------- */
(async function boot(){
  // default theme: archive
  document.documentElement.setAttribute("data-theme", "archive");

  initMap();
  wireUI();

  await loadData();
  renderList();

  try{
    const geo = await loadGeo();
    COUNTRIES = L.geoJSON(geo, {
      style: (f) => styleBorders(f),
      onEachFeature: (feature, layer) => {
        layer.on("mouseover", () => {
          const nm = countryName(feature) || "—";
          UI.hoverChip.textContent = `Hover: ${nm}`;
        });
        layer.on("mouseout", () => { UI.hoverChip.textContent = "Hover: —"; });

        layer.on("click", (e) => {
          const nm = countryName(feature) || "—";
          const alt = e.originalEvent?.altKey;
          selectNationByName(nm, layer, alt);
        });
      }
    }).addTo(MAP);

    const b = COUNTRIES.getBounds();
    if (b && b.isValid()) MAP.fitBounds(b.pad(0.02));

    rebuildCheckpoints();
    refreshStyles();
    setNet("ok", "ONLINE");
  }catch(_){
    // still usable as a roster browser
    setNet("warn", "NO GEO");
    rebuildCheckpoints();
  }
})();