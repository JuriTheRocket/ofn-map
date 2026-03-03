// OFN Global Atlas — compact UI, living map overlays, ping markers, sites, dossiers.
// Build: 2026-03-03

const BUILD = "2026-03-03";

const el = (id) => document.getElementById(id);
const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

const UI = {
  search: el("search"),
  filter: el("filter"),
  aboutBtn: el("aboutBtn"),
  fitBtn: el("fitBtn"),
  resetBtn: el("resetBtn"),

  themeAuto: el("themeAuto"),
  themeDay: el("themeDay"),
  themeNight: el("themeNight"),

  liveDayNight: el("liveDayNight"),
  liveTraffic: el("liveTraffic"),
  livePings: el("livePings"),

  hoverName: el("hoverName"),
  coordInfo: el("coordInfo"),

  dossier: el("dossier"),
  dMark: el("dMark"),
  dName: el("dName"),
  dMeta: el("dMeta"),
  dBody: el("dBody"),
  zoomBtn: el("zoomBtn"),
  pinBtn: el("pinBtn"),
  closeBtn: el("closeBtn"),

  aboutOverlay: el("aboutOverlay"),
  aboutClose: el("aboutClose"),

  liveCanvas: el("liveCanvas"),
};

let MAP = null;
let BASE = null;
let COUNTRIES = null;

let ROSTER = null;
let SITES = [];

let selected = null; // { kind, id, name, layer, feature, site, latlng }
let pins = [];       // [{kind,id,name}]

let pingLayer = null;     // member/observer/invite beacons
let siteLayer = null;     // site shapes + site beacons

let THEME_MODE = "auto";  // auto|day|night
let LIVE = {
  dayNight: true,
  traffic: true,
  radiance: true
};

// ----- Status logic -----
function canonicalName(name){
  if (!name) return "";
  const n = name.trim();
  // convenience aliases
  const aliases = new Map([
    ["USA", "United States of America"],
    ["United States", "United States of America"],
  ]);
  return aliases.get(n) || n;
}

function statusOfName(name){
  const n = canonicalName(name);
  if (!ROSTER) return "neutral";

  if (ROSTER.hq === n) return "hq";
  if ((ROSTER.founding || []).includes(n)) return "founding";
  if ((ROSTER.members || []).includes(n)) return "member";
  if ((ROSTER.invites || []).includes(n)) return "invite";
  if ((ROSTER.observers || []).includes(n)) return "observer";

  return "neutral";
}

function isFictionName(name){
  const n = canonicalName(name);
  return (ROSTER?.fiction || []).some(f => norm(f.name) === norm(n));
}

function statusLabel(s){
  return ({
    founding: "Founding State",
    hq: "Headquarters State",
    member: "Member State",
    invite: "Open Invite",
    observer: "Observer State",
    neutral: "Neutral",
    fiction: "Fictional",
    site: "Site"
  }[s] || "Neutral");
}

function pingColorKey(s){
  if (s === "founding") return "gold";
  if (s === "hq") return "gold";
  if (s === "member") return "blue";
  if (s === "invite") return "orange";
  if (s === "observer") return "green";
  if (s === "fiction") return "ink";
  if (s === "site") return "blue";
  return "ink";
}

function statusToCSSColor(s){
  const css = getComputedStyle(document.documentElement);
  const ofn = css.getPropertyValue("--ofn").trim() || "#1f5cff";
  const gold = css.getPropertyValue("--gold").trim() || "#c6a24b";
  const green = css.getPropertyValue("--green").trim() || "#1f7a5c";
  const orange = css.getPropertyValue("--orange").trim() || "#b86a00";
  const ink = css.getPropertyValue("--ink").trim() || "#1a1f2a";

  return ({
    founding: gold,
    hq: gold,
    member: ofn,
    invite: orange,
    observer: green,
    fiction: ink,
    neutral: "rgba(127,127,127,.55)",
    site: ofn
  }[s] || "rgba(127,127,127,.55)");
}

function escapeHTML(s){
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

// ----- Theme -----
function getAutoTheme(){
  const h = new Date().getHours();
  return (h >= 7 && h < 19) ? "day" : "night";
}

function applyTheme(mode){
  THEME_MODE = mode;
  const actual = (mode === "auto") ? getAutoTheme() : mode;

  document.documentElement.setAttribute("data-theme", actual);

  UI.themeAuto.classList.toggle("on", mode === "auto");
  UI.themeDay.classList.toggle("on", mode === "day");
  UI.themeNight.classList.toggle("on", mode === "night");

  setBaseTiles(actual);
  refreshStyles();
}

function setBaseTiles(actualTheme){
  if (!MAP) return;

  const night = actualTheme === "night";
  const url = night
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

function startAutoThemeTimer(){
  setInterval(() => {
    if (THEME_MODE === "auto") applyTheme("auto");
  }, 60 * 1000);
}

// ----- Ping marker (divIcon) -----
function pingIcon(colorKey){
  return L.divIcon({
    className: "",
    html: `
      <div class="ofnPing" data-color="${colorKey}">
        <div class="ring"></div>
        <div class="core"></div>
      </div>
    `,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
}

// ----- Countries -----
function countryName(feature){
  return feature?.properties?.name || feature?.properties?.ADMIN || feature?.properties?.Name || "";
}

function styleCountry(feature){
  const nm = canonicalName(countryName(feature));
  let s = statusOfName(nm);

  // Fiction doesn't exist on map polygons, but we still keep neutral for real ones.
  const fill = statusToCSSColor(s);

  // Keep fills subtle—pings do the talking.
  let fillOpacity = 0.06;
  if (s === "member") fillOpacity = 0.10;
  if (s === "founding" || s === "hq") fillOpacity = 0.12;
  if (s === "observer") fillOpacity = 0.08;
  if (s === "invite") fillOpacity = 0.08;

  // Filter dims non-matching
  const f = UI.filter.value || "all";
  const fictionWanted = (f === "fiction");
  if (f !== "all"){
    // "site" and "fiction" filters shouldn't kill countries completely; we just dim.
    if (!fictionWanted && f !== "site"){
      if (s !== f){
        fillOpacity = Math.min(fillOpacity, 0.02);
      }
    } else {
      fillOpacity = Math.min(fillOpacity, 0.03);
    }
  }

  const theme = document.documentElement.getAttribute("data-theme");
  const day = theme !== "night";
  const stroke = day ? "rgba(0,0,0,.22)" : "rgba(255,255,255,.16)";

  return {
    color: stroke,
    weight: 1,
    opacity: 0.9,
    fillColor: fill,
    fillOpacity
  };
}

function centroidOfLayer(layer){
  try{
    const b = layer.getBounds();
    return b.getCenter();
  }catch(_){ return null; }
}

// ----- Pings (memberstates etc.) -----
function rebuildPings(){
  if (!MAP || !COUNTRIES || !ROSTER) return;

  if (pingLayer){
    pingLayer.remove();
    pingLayer = null;
  }
  pingLayer = L.layerGroup();

  // Make pings for: founding/hq/member/invite/observer
  const wanted = new Set([
    ...ROSTER.founding,
    ROSTER.hq,
    ...ROSTER.members,
    ...ROSTER.invites,
    ...ROSTER.observers
  ].filter(Boolean).map(canonicalName));

  COUNTRIES.eachLayer(layer => {
    const nm = canonicalName(countryName(layer.feature));
    if (!wanted.has(nm)) return;

    const st = statusOfName(nm);
    // Filter rules
    const f = UI.filter.value || "all";
    if (f !== "all" && f !== "site" && f !== "fiction"){
      if (st !== f) return;
    }

    const c = centroidOfLayer(layer);
    if (!c) return;

    const marker = L.marker(c, {
      icon: pingIcon(pingColorKey(st)),
      riseOnHover: true
    });

    marker.on("click", (e) => {
      const alt = e.originalEvent?.altKey;
      selectCountry(layer, alt);
    });

    marker.bindTooltip(`${nm} • ${statusLabel(st)}`, { direction:"top", opacity:0.95 });

    marker.addTo(pingLayer);
  });

  pingLayer.addTo(MAP);
}

// ----- Sites -----
function styleSiteShape(site){
  const theme = document.documentElement.getAttribute("data-theme");
  const day = theme !== "night";
  const stroke = day ? "rgba(0,0,0,.30)" : "rgba(255,255,255,.20)";

  // Sites: OFN blue fill, subtle
  const fill = statusToCSSColor("site");
  return { color: stroke, weight: 2, opacity: 0.9, fillColor: fill, fillOpacity: 0.10 };
}

function rebuildSites(){
  if (!MAP || !SITES) return;

  if (siteLayer){
    siteLayer.remove();
    siteLayer = null;
  }
  siteLayer = L.layerGroup();

  const f = UI.filter.value || "all";
  const showOnlySites = (f === "site");

  for (const site of SITES){
    const center = L.latLng(site.lat, site.lng);

    // If filter is strict to e.g. member, we still show sites unless user chose something else.
    // If user picks "site", we show only sites (countries dimmed anyway).
    if (f !== "all" && !showOnlySites && f !== "fiction"){
      // do nothing; sites can still show.
    }
    if (f === "fiction") {
      // still allow sites but keep them; user asked fiction, not hide.
    }

    let shapeLayer = null;
    const shape = String(site.shape || "circle").toLowerCase();

    if (shape === "square" || shape === "rect" || shape === "rectangle"){
      const halfKm = Math.max(6, Number(site.size_km || 18));
      const dLat = halfKm / 111;
      const dLng = halfKm / (111 * Math.cos(center.lat * Math.PI/180) || 1);

      const bounds = L.latLngBounds(
        [center.lat - dLat, center.lng - dLng],
        [center.lat + dLat, center.lng + dLng]
      );

      shapeLayer = L.rectangle(bounds, styleSiteShape(site));
    } else {
      const radiusKm = Math.max(10, Number(site.radius_km || 22));
      shapeLayer = L.circle(center, { radius: radiusKm * 1000, ...styleSiteShape(site) });
    }

    const beacon = L.marker(center, {
      icon: pingIcon("blue"),
      riseOnHover: true
    });

    const title = `${site.name} • ${site.type || "Site"}`;
    beacon.bindTooltip(title, { direction:"top", opacity:0.95 });

    const onPick = (e) => {
      const alt = e?.originalEvent?.altKey;
      selectSite(site.id, alt);
    };

    shapeLayer.on("click", onPick);
    beacon.on("click", onPick);

    shapeLayer.addTo(siteLayer);
    beacon.addTo(siteLayer);
  }

  // Show sites always, unless user explicitly filtered to a status other than site/fiction/all?
  // We'll keep them always (you said you like pings showing important things).
  siteLayer.addTo(MAP);
}

// ----- Dossier -----
function openDossier(){ UI.dossier.classList.add("open"); UI.dossier.classList.remove("closed"); }
function closeDossier(){ UI.dossier.classList.remove("open"); UI.dossier.classList.add("closed"); }

function badgeHtml(text, cls){
  return `<span class="b ${cls}">${escapeHTML(text)}</span>`;
}
function makeCard(title, inner){
  return `<div class="card"><h3>${escapeHTML(title)}</h3>${inner}</div>`;
}
function kv(k, v){
  return `<div class="kv"><div class="k">${escapeHTML(k)}</div><div class="v">${v}</div></div>`;
}

async function wikiBrief(name){
  // best-effort: never break UI if blocked
  const key = "ofn_atlas_wiki:" + name;
  const ttl = 7 * 24 * 3600 * 1000;

  try{
    const raw = localStorage.getItem(key);
    if (raw){
      const obj = JSON.parse(raw);
      if (obj?.t && obj?.text && (Date.now() - obj.t) < ttl) return obj.text;
    }
  }catch(_){}

  try{
    const t = encodeURIComponent(String(name).replace(/\s+/g, "_"));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${t}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(url, { signal: ctrl.signal, headers:{accept:"application/json"} });
    clearTimeout(timer);
    if (!res.ok) throw new Error("http");
    const data = await res.json();
    if (data?.type === "disambiguation") return null;
    const text = (data?.extract || data?.description || "").trim();
    if (!text) return null;

    try{
      localStorage.setItem(key, JSON.stringify({ t: Date.now(), text }));
    }catch(_){}
    return text;
  }catch(_){
    return null;
  }
}

// ----- Sounds (optional) -----
const SFX_BASE = "assets/sfx/";
function tryPlaySfx(label){
  // label should map to filename Label.mp3
  const file = `${SFX_BASE}${label}.mp3`;
  const a = new Audio(file);
  a.volume = 0.55;
  a.play().catch(() => {/* ignore */});
}

function playForSelection(kind, statusOrType){
  // Only play if files exist; Audio will fail silently if missing.
  if (kind === "site") {
    tryPlaySfx("Site");
    return;
  }
  const s = statusOrType;
  if (s === "hq") tryPlaySfx("Headquarters");
  else if (s === "founding") tryPlaySfx("Founding");
  else if (s === "member") tryPlaySfx("Member");
  else if (s === "invite") tryPlaySfx("Invite");
  else if (s === "observer") tryPlaySfx("Observer");
  else tryPlaySfx("Neutral");
}

function pinCurrent(){
  if (!selected) return;
  const key = `${selected.kind}:${selected.id}`;
  if (pins.some(p => `${p.kind}:${p.id}` === key)) return;
  pins.push({ kind: selected.kind, id: selected.id, name: selected.name });
}

// Select country polygon
function selectCountry(layer, pin=false){
  const name = canonicalName(countryName(layer.feature));
  const st = statusOfName(name);

  selected = { kind:"country", id:name, name, layer, feature: layer.feature };

  UI.dMark.textContent = "FILE";
  UI.dName.textContent = name;
  UI.dMeta.textContent = `${statusLabel(st)} • Real-world`;

  const badges = [];
  if (st === "hq") badges.push(badgeHtml("Headquarters", "hq"));
  else badges.push(badgeHtml(statusLabel(st), st === "founding" ? "founding" : st));
  if ((ROSTER.members || []).includes(name)) badges.push(badgeHtml("OFN Member", "member"));
  if ((ROSTER.invites || []).includes(name)) badges.push(badgeHtml("Open Invite", "invite"));
  if ((ROSTER.observers || []).includes(name)) badges.push(badgeHtml("Observer", "observer"));
  if ((ROSTER.founding || []).includes(name)) badges.push(badgeHtml("Founding", "founding"));
  if (name === ROSTER.hq) badges.push(badgeHtml("HQ State", "hq"));

  UI.dBody.innerHTML = [
    makeCard("Classification", `
      <div class="badges">${badges.join("")}</div>
      ${kv("Designation", escapeHTML(statusLabel(st)))}
      ${kv("OFN", escapeHTML(name === ROSTER.hq ? "Headquarters State" : ((ROSTER.members || []).includes(name) ? "Member State" : "—")))}
    `),
    makeCard("Brief", `<p class="p" id="wikiLine">Loading brief…</p>`)
  ].join("");

  UI.zoomBtn.onclick = () => {
    try{ MAP.fitBounds(layer.getBounds().pad(0.22)); }catch(_){}
  };
  UI.pinBtn.onclick = () => pinCurrent();

  if (pin) pinCurrent();
  openDossier();
  playForSelection("country", st);

  // load wiki
  (async () => {
    const line = document.getElementById("wikiLine");
    if (!line) return;
    const text = await wikiBrief(name);
    line.textContent = text || "Brief temporarily unavailable.";
  })();
}

// Select fictional dossier
function selectFictionByName(name, pin=false){
  const f = (ROSTER.fiction || []).find(x => norm(x.name) === norm(name));
  if (!f) return;

  const st = f.status || "neutral";
  selected = { kind:"fiction", id: f.id || f.name, name: f.name, fiction: f };

  UI.dMark.textContent = "FILE";
  UI.dName.textContent = f.name;
  UI.dMeta.textContent = `${statusLabel(st)} • Fictional dossier`;

  const badges = [
    badgeHtml("Fictional", "fiction"),
    badgeHtml(statusLabel(st), st === "member" ? "member" : st === "invite" ? "invite" : "observer")
  ];

  const metaRows = f.meta ? Object.entries(f.meta).map(([k,v]) => kv(k, escapeHTML(String(v)))) : [];
  UI.dBody.innerHTML = [
    makeCard("Classification", `
      <div class="badges">${badges.join("")}</div>
      ${kv("Polity", escapeHTML(f.polity || "—"))}
    `),
    makeCard("Key facts", metaRows.length ? metaRows.join("") : `<p class="p">—</p>`),
    makeCard("Overview", `<p class="p">${escapeHTML(f.overview || "—")}</p>`)
  ].join("");

  UI.zoomBtn.onclick = () => {};
  UI.pinBtn.onclick = () => pinCurrent();

  if (pin) pinCurrent();
  openDossier();
  playForSelection("country", "neutral");
}

// Select site
function selectSite(id, pin=false){
  const site = SITES.find(s => s.id === id);
  if (!site) return;

  selected = { kind:"site", id: site.id, name: site.name, site, latlng: [site.lat, site.lng] };

  UI.dMark.textContent = "SITE";
  UI.dName.textContent = site.name;
  UI.dMeta.textContent = `${site.type || "Site"} • ${site.host || "—"}`;

  const badges = [
    badgeHtml("Site", "site"),
    badgeHtml(site.type || "—", "site"),
    badgeHtml(site.admin || "—", "site")
  ];

  const metaRows = site.meta ? Object.entries(site.meta).map(([k,v]) => kv(k, escapeHTML(String(v)))) : [];
  UI.dBody.innerHTML = [
    makeCard("Snapshot", `
      <div class="badges">${badges.join("")}</div>
      ${kv("Host", escapeHTML(site.host || "—"))}
      ${kv("Administration", escapeHTML(site.admin || "—"))}
      ${kv("Permission", escapeHTML(site.permission || "—"))}
      ${kv("Coordinates", escapeHTML(`${site.lat.toFixed(3)}, ${site.lng.toFixed(3)}`))}
    `),
    makeCard("Key facts", metaRows.length ? metaRows.join("") : `<p class="p">—</p>`),
    makeCard("Overview", `<p class="p">${escapeHTML(site.overview || "—")}</p>`),
    site.image ? makeCard("Image", `
      <div style="border:1px solid var(--hair); border-radius:14px; overflow:hidden;">
        <img src="${escapeHTML(site.image)}" alt="${escapeHTML(site.name)}" style="width:100%; height:auto; display:block;">
      </div>
    `) : ""
  ].join("");

  UI.zoomBtn.onclick = () => {
    MAP.setView([site.lat, site.lng], Math.max(MAP.getZoom(), 5));
  };
  UI.pinBtn.onclick = () => pinCurrent();

  if (pin) pinCurrent();
  openDossier();
  playForSelection("site", site.type || "Site");
}

// ----- Search -----
function findCountryLayerByName(name){
  const q = norm(canonicalName(name));
  let found = null;
  if (!COUNTRIES) return null;

  // exact first
  COUNTRIES.eachLayer(l => {
    if (found) return;
    const nm = norm(canonicalName(countryName(l.feature)));
    if (nm === q) found = l;
  });
  if (found) return found;

  // partial
  COUNTRIES.eachLayer(l => {
    if (found) return;
    const nm = norm(canonicalName(countryName(l.feature)));
    if (nm.includes(q)) found = l;
  });
  return found;
}

function runSearch(){
  const q = UI.search.value.trim();
  if (!q) return;

  // 1) sites by name
  const site = SITES.find(s => norm(s.name).includes(norm(q)) || norm(s.id) === norm(q));
  if (site){
    selectSite(site.id, false);
    MAP.setView([site.lat, site.lng], Math.max(MAP.getZoom(), 5));
    return;
  }

  // 2) fiction
  const f = (ROSTER.fiction || []).find(x => norm(x.name).includes(norm(q)));
  if (f){
    selectFictionByName(f.name, false);
    return;
  }

  // 3) countries
  const layer = findCountryLayerByName(q);
  if (layer){
    selectCountry(layer, false);
    try{ MAP.fitBounds(layer.getBounds().pad(0.22)); }catch(_){}
  }
}

// ----- UI wiring -----
function setAbout(open){
  UI.aboutOverlay.classList.toggle("open", !!open);
}

function refreshStyles(){
  if (COUNTRIES){
    COUNTRIES.eachLayer(l => l.setStyle(styleCountry(l.feature)));
  }
  rebuildPings();
  rebuildSites();

  document.body.classList.toggle("radiance", !!LIVE.radiance);
}

// ----- Live Canvas overlay (day/night + traffic) -----
const Live = {
  ctx: null,
  dpr: 1,
  w: 0,
  h: 0,

  // stylized traffic particles
  flights: [],
  ships: [],
  lastSpawn: 0
};

// Approx sun position (good enough for ambience)
function subsolarPointUTC(date){
  // simple approximation: based on NOAA-ish declination approximations
  // Not for navigation; good for a moving terminator feel.
  const rad = Math.PI / 180;

  const d = (date.getTime() / 86400000) - (Date.UTC(2000,0,1) / 86400000);
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = (280.459 + 0.98564736 * d) * rad;
  const L = q + (1.915 * rad) * Math.sin(g) + (0.020 * rad) * Math.sin(2*g);

  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L)); // declination

  // equation of time rough
  const y = Math.tan(e/2) ** 2;
  const eq = 4 * ( y*Math.sin(2*q) - 2*0.0167*Math.sin(g) + 4*0.0167*y*Math.sin(g)*Math.cos(2*q) - 0.5*y*y*Math.sin(4*q) - 1.25*0.0167*0.0167*Math.sin(2*g) ); // minutes, approx

  // subsolar longitude: where local solar noon happens now
  const utcMinutes = date.getUTCHours()*60 + date.getUTCMinutes() + date.getUTCSeconds()/60;
  const lon = ( (720 - utcMinutes - eq) / 4 ); // degrees
  // normalize [-180,180]
  let lonN = ((lon + 540) % 360) - 180;

  const lat = dec / rad; // degrees
  return { lat, lon: lonN };
}

function resizeLiveCanvas(){
  const c = UI.liveCanvas;
  const ctx = c.getContext("2d");
  Live.ctx = ctx;

  Live.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  Live.w = c.clientWidth;
  Live.h = c.clientHeight;

  c.width = Math.floor(Live.w * Live.dpr);
  c.height = Math.floor(Live.h * Live.dpr);
  ctx.setTransform(Live.dpr,0,0,Live.dpr,0,0);
}

function latLngToPoint(lat, lng){
  if (!MAP) return null;
  return MAP.latLngToContainerPoint([lat, lng]);
}

function drawDayNight(){
  const ctx = Live.ctx;
  if (!ctx || !MAP || !LIVE.dayNight) return;

  const theme = document.documentElement.getAttribute("data-theme");
  const isNightTheme = theme === "night";

  const now = new Date();
  const sun = subsolarPointUTC(now);

  const p = latLngToPoint(sun.lat, sun.lon);
  if (!p) return;

  // create a big soft vignette: bright near sun, dark on opposite side
  // We'll draw a dark layer, then "cut" daylight with radial gradient
  ctx.save();

  // night tint
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = isNightTheme ? "rgba(0,0,0,.10)" : "rgba(0,0,0,.16)";
  ctx.fillRect(0,0,Live.w,Live.h);

  // daylight “window”
  const r = Math.max(Live.w, Live.h) * 0.65;
  const g = ctx.createRadialGradient(p.x, p.y, r*0.10, p.x, p.y, r);
  g.addColorStop(0.0, "rgba(0,0,0,0)");
  g.addColorStop(0.55, "rgba(0,0,0,0.08)");
  g.addColorStop(1.0, "rgba(0,0,0,0.45)");

  // overlay shadow
  ctx.fillStyle = g;
  ctx.fillRect(0,0,Live.w,Live.h);

  ctx.restore();
}

function spawnTraffic(nowMs){
  // spawn a few stylized routes between hubs so it feels alive
  if (!MAP || !LIVE.traffic) return;

  if (nowMs - Live.lastSpawn < 1400) return;
  Live.lastSpawn = nowMs;

  const hubs = [
    { name:"Lux", lat:49.6117, lng:6.1319 },
    { name:"Falk", lat:-51.69, lng:-57.86 },
    { name:"DC", lat:38.90, lng:-77.04 },
    { name:"Athens", lat:37.98, lng:23.73 },
    { name:"Dublin", lat:53.35, lng:-6.26 },
    { name:"Tbilisi", lat:41.72, lng:44.78 },
    { name:"Jerusalem", lat:31.78, lng:35.22 },
    { name:"Manila", lat:14.60, lng:120.98 },
    { name:"Jakarta", lat:-6.20, lng:106.85 },
    { name:"Canberra", lat:-35.28, lng:149.13 }
  ];

  // random route
  const a = hubs[Math.floor(Math.random()*hubs.length)];
  let b = hubs[Math.floor(Math.random()*hubs.length)];
  if (b === a) b = hubs[(hubs.indexOf(a)+3) % hubs.length];

  const isFlight = Math.random() < 0.65;

  const obj = {
    a, b,
    t: 0,
    speed: isFlight ? (0.006 + Math.random()*0.008) : (0.003 + Math.random()*0.005),
    life: 1
  };

  if (isFlight) Live.flights.push(obj);
  else Live.ships.push(obj);

  // keep lists bounded
  Live.flights = Live.flights.slice(-28);
  Live.ships = Live.ships.slice(-22);
}

function lerp(a,b,t){ return a + (b-a)*t; }

function drawTraffic(dt){
  const ctx = Live.ctx;
  if (!ctx || !MAP || !LIVE.traffic) return;

  // colors depend on theme
  const theme = document.documentElement.getAttribute("data-theme");
  const day = theme !== "night";
  const flightCol = day ? "rgba(31,92,255,.55)" : "rgba(31,92,255,.45)";
  const shipCol = day ? "rgba(26,31,42,.38)" : "rgba(234,240,255,.28)";

  function drawObj(obj, col, size){
    obj.t += obj.speed * dt;
    if (obj.t >= 1){ obj.life = 0; return; }

    // simple lerp in lat/lng (not true great-circle; fine for ambience)
    const lat = lerp(obj.a.lat, obj.b.lat, obj.t);
    const lng = lerp(obj.a.lng, obj.b.lng, obj.t);
    const p = latLngToPoint(lat, lng);
    if (!p) return;

    ctx.save();
    ctx.fillStyle = col;

    // tiny comet tail
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(p.x, p.y, size, 0, Math.PI*2);
    ctx.fill();

    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(p.x-6, p.y+2, size*1.2, 0, Math.PI*2);
    ctx.fill();

    ctx.restore();
  }

  // update + draw
  Live.flights = Live.flights.filter(o => o.life);
  Live.ships = Live.ships.filter(o => o.life);

  for (const f of Live.flights) drawObj(f, flightCol, 2.0);
  for (const s of Live.ships) drawObj(s, shipCol, 1.8);
}

let lastFrame = performance.now();
function liveLoop(now){
  const ctx = Live.ctx;
  if (!ctx){
    requestAnimationFrame(liveLoop);
    return;
  }

  const dt = Math.max(10, Math.min(40, now - lastFrame)); // clamp for stability
  lastFrame = now;

  // Clear
  ctx.clearRect(0,0,Live.w,Live.h);

  // Spawn + draw
  spawnTraffic(now);
  drawTraffic(dt);
  drawDayNight();

  requestAnimationFrame(liveLoop);
}

// ----- Map init -----
async function loadJson(path){
  const res = await fetch(path, { cache:"no-store" });
  if (!res.ok) throw new Error("http");
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

  // coords + hover
  MAP.on("mousemove", (e) => {
    UI.coordInfo.textContent = `Lat ${e.latlng.lat.toFixed(2)}, Lng ${e.latlng.lng.toFixed(2)}`;
  });

  // fit button uses country bounds later
}

function wireUI(){
  UI.search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });

  UI.filter.addEventListener("change", () => refreshStyles());

  UI.fitBtn.addEventListener("click", () => {
    if (COUNTRIES){
      const b = COUNTRIES.getBounds();
      if (b && b.isValid()) MAP.fitBounds(b.pad(0.02));
      else MAP.setView([22,0], 2);
    } else {
      MAP.setView([22,0], 2);
    }
  });

  UI.resetBtn.addEventListener("click", () => {
    UI.search.value = "";
    UI.filter.value = "all";
    closeDossier();
    refreshStyles();
    if (MAP) MAP.closePopup();

    // restore live toggles
    LIVE.dayNight = true;
    LIVE.traffic = true;
    LIVE.radiance = true;
    UI.liveDayNight.classList.add("on");
    UI.liveTraffic.classList.add("on");
    UI.livePings.classList.add("on");
    refreshStyles();
  });

  UI.closeBtn.addEventListener("click", closeDossier);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape"){
      closeDossier();
      setAbout(false);
    }
  });

  UI.aboutBtn.addEventListener("click", () => setAbout(true));
  UI.aboutClose.addEventListener("click", () => setAbout(false));
  UI.aboutOverlay.addEventListener("click", (e) => {
    if (e.target === UI.aboutOverlay) setAbout(false);
  });

  // Theme buttons
  UI.themeAuto.addEventListener("click", () => applyTheme("auto"));
  UI.themeDay.addEventListener("click", () => applyTheme("day"));
  UI.themeNight.addEventListener("click", () => applyTheme("night"));

  // Live toggles
  UI.liveDayNight.addEventListener("click", () => {
    LIVE.dayNight = !LIVE.dayNight;
    UI.liveDayNight.classList.toggle("on", LIVE.dayNight);
  });
  UI.liveTraffic.addEventListener("click", () => {
    LIVE.traffic = !LIVE.traffic;
    UI.liveTraffic.classList.toggle("on", LIVE.traffic);
  });
  UI.livePings.addEventListener("click", () => {
    LIVE.radiance = !LIVE.radiance;
    UI.livePings.classList.toggle("on", LIVE.radiance);
    refreshStyles();
  });
}

// ----- Boot -----
(async function boot(){
  initMap();
  wireUI();

  // theme + tiles
  applyTheme("auto");
  startAutoThemeTimer();

  // live canvas
  resizeLiveCanvas();
  window.addEventListener("resize", resizeLiveCanvas, { passive:true });
  document.body.classList.add("radiance"); // default
  requestAnimationFrame(liveLoop);

  // Load data
  try{
    ROSTER = await loadJson(`data/ofn_roster.json?v=${encodeURIComponent(BUILD)}`);
  }catch(_){
    ROSTER = { hq:"Luxembourg", founding:[], members:[], invites:[], observers:[], fiction:[] };
  }

  try{
    SITES = await loadJson(`data/sites.json?v=${encodeURIComponent(BUILD)}`);
  }catch(_){
    SITES = [];
  }

  // Load geojson
  const geoUrl = `https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson?v=${encodeURIComponent(BUILD)}`;

  try{
    const geo = await loadJson(geoUrl);

    COUNTRIES = L.geoJSON(geo, {
      style: (f) => styleCountry(f),
      onEachFeature: (feature, layer) => {
        const nm = canonicalName(countryName(feature));

        layer.on("mouseover", () => {
          UI.hoverName.textContent = `Hover: ${nm}`;
        });
        layer.on("mouseout", () => {
          UI.hoverName.textContent = `Hover: —`;
        });

        layer.on("click", (e) => {
          const alt = e.originalEvent?.altKey;
          selectCountry(layer, !!alt);

          // quick popup with classification
          const st = statusOfName(nm);
          const popup = `<b>${escapeHTML(nm)}</b><div style="margin-top:6px; font-family:var(--mono); opacity:.85;">${escapeHTML(statusLabel(st))}</div>`;
          layer.bindPopup(popup).openPopup();
        });
      }
    }).addTo(MAP);

    // initial fit
    const b = COUNTRIES.getBounds();
    if (b && b.isValid()) MAP.fitBounds(b.pad(0.02));

    // pings + sites
    rebuildPings();
    rebuildSites();

  }catch(_){
    // still let sites show even if geo fails
    rebuildSites();
  }

  // Search: allow fiction & sites even without geo.
  UI.search.addEventListener("blur", () => {
    // small “nice” behavior: if user typed exact fiction name, open it
    const q = UI.search.value.trim();
    if (!q) return;
    const f = (ROSTER.fiction || []).find(x => norm(x.name) === norm(q));
    if (f) selectFictionByName(f.name, false);
  });

  // Also allow filter "fiction" selection to open roster highlights via search:
  UI.search.addEventListener("input", () => {
    // no auto-open; just lets user hit enter
  });

  // Quick fiction access: if user searches exact fiction, Enter works in runSearch()
  // (already implemented)
})();
