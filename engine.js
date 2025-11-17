/* ===== Utilities ===== */
// Small helpers
const $id  = (id) => document.getElementById(id);
const bind = (...ids) =>
  ids.reduce((acc, id) => (acc[id] = $id(id), acc), {});


const CSV_DEBUG = true;            // logs fetch attempts + reasons
const CSV_USE_FALLBACK = true;

// ===== KNN Metrics loader (metrics.csv) =====
// Loads metrics from ?metrics=<url> or local metrics.csv and exposes window.METRICS.
// API: await METRICS.ready;  METRICS.estimate({ qtr, game_seconds_remaining, down, ydstogo, yardline_100, score_differential, posteam_is_home })

(function(){
    const qs = new URLSearchParams(location.search);
    const param = (qs.get('metrics') || '').replace('/refs/heads/','/');
    const CANDIDATES = param ? [param] : [new URL('metrics.csv', location.href).href, 'metrics.csv'];
  
    function splitLines(t){ return String(t||'').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n'); }
    function sniffDelimiter(line){
      const c=[',','\t',';','|']; let best=',', n=0;
      for(const d of c){ const k=line.split(d).length; if(k>n){best=d;n=k;} } return best;
    }
    function splitRow(row, d){
      const out=[]; let f='', q=false;
      for(let i=0;i<row.length;i++){
        const c=row[i];
        if(q){ if(c==='"'){ if(row[i+1]==='"'){ f+='"'; i++; } else q=false; } else f+=c; }
        else { if(c==='"') q=true; else if(c===d){ out.push(f); f=''; } else f+=c; }
      }
      out.push(f); return out;
    }
    function parseSmart(text){
      const lines = splitLines(text).filter(l=>l.trim()!==''); if(!lines.length) return {header:[],rows:[]};
      const d = sniffDelimiter(lines[0]);
      const rows = lines.map(line => splitRow(line, d));
      const header = rows[0].map(h=>String(h||'').trim());
      return { header, rows: rows.slice(1) };
    }
    async function fetchFirstOk(urls){
      for(const url of urls){
        try{
          const res = await fetch(url, { cache:'no-store', mode:'cors' });
          if(!res.ok) continue;
          return await res.text();
        }catch(_){}
      }
      throw new Error('metrics.csv not reachable');
    }
    const clamp = (x,a,b)=> Math.max(a, Math.min(b, x));
    const num = v => {
      if (v===undefined || v===null || v==='') return NaN;
      const x = Number(String(v).trim());
      return Number.isFinite(x) ? x : NaN;
    };
  
    class MetricsKNN {
      constructor(k=200){ this.k=k; this.ready=this._init(); }
      async _init(){
        const text = await fetchFirstOk(CANDIDATES);
        const { header, rows } = parseSmart(text);
  
        const idx = name => header.findIndex(h => h.toLowerCase()===name.toLowerCase());
        const c = {
          qtr: idx('qtr'), down: idx('down'), ytg: idx('ydstogo'), yl: idx('yardline_100'),
          gsr: idx('game_seconds_remaining'), diff: idx('score_differential'), hof: idx('posteam_is_home'),
          wp: idx('wp_hat'), ep: idx('ep_hat'), epa: idx('epa_hat'),
          td: idx('td_prob_hat'), fg: idx('fg_prob_hat'), saf: idx('safety_prob_hat'), nos: idx('no_score_prob_hat')
        };
        const reqIn  = [c.qtr,c.down,c.ytg,c.yl,c.gsr,c.diff,c.hof];
        const reqOut = [c.wp,c.ep,c.epa,c.td,c.fg,c.saf,c.nos];
        if (reqIn.some(i=>i<0) || reqOut.some(i=>i<0)) throw new Error('metrics.csv missing required columns');
  
        const feats=[]; const outs=[];
        for(const r of rows){
          const q=num(r[c.qtr]), d=num(r[c.down]), ytg=num(r[c.ytg]), yl=num(r[c.yl]),
                g=num(r[c.gsr]), df=num(r[c.diff]), hf=num(r[c.hof]),
                wp=num(r[c.wp]), ep=num(r[c.ep]), epa=num(r[c.epa]),
                td=num(r[c.td]), fg=num(r[c.fg]), saf=num(r[c.saf]), nos=num(r[c.nos]);
          if (![q,d,ytg,yl,g,df,hf].every(Number.isFinite)) continue;
          if (![wp,ep,epa,td,fg,saf,nos].every(Number.isFinite)) continue;
          feats.push(q,d,ytg,yl,g,df,hf);
          outs.push(wp,ep,epa,td,fg,saf,nos);
        }
        const N = outs.length/7; if(!N) throw new Error('metrics.csv has no usable rows');
  
        this.N=N; this.D=7;
        this.features = new Float32Array(feats);
        this.outputs  = new Float32Array(outs);
  
        // scale per-dimension via 10–90 pct
        const scales = new Float64Array(this.D).fill(1);
        const cols = Array.from({length:this.D}, (_,d)=>[]);
        for(let i=0;i<N;i++){ for(let d=0;d<this.D;d++){ cols[d].push(this.features[i*this.D+d]); } }
        const pct=(a,p)=>{ const s=a.slice().sort((x,y)=>x-y), idx=(s.length-1)*p, lo=Math.floor(idx), hi=Math.ceil(idx);
          return s[lo]*(hi-idx)+s[hi]*(idx-lo);
        };
        for(let d=0; d<this.D; d++){
          const spread = Math.max(1e-6, pct(cols[d],0.90)-pct(cols[d],0.10));
          scales[d]=spread;
        }
        this.scales = new Float32Array(scales);
      }
  
      estimate(state, k=this.k){
        if(!this.N) throw new Error('metrics not loaded');
        // build query
        const q = new Float32Array([
          Number(state.qtr||1),
          Number(state.down||1),
          Number(state.ydstogo||10),
          Number(state.yardline_100||75),
          Number(state.game_seconds_remaining||0),
          Number(state.score_differential||0),
          Number(state.posteam_is_home||0),
        ]);
        for(let d=0; d<this.D; d++) q[d]/=this.scales[d];
  
        const K = Math.min(k, this.N);
        const bestIdx=new Int32Array(K).fill(-1), bestDst=new Float32Array(K).fill(1e30);
        const f=this.features, D=this.D, s=this.scales;
        for(let i=0;i<this.N;i++){
          let off=i*D;
          const dist = (f[off+0]/s[0]-q[0])**2+(f[off+1]/s[1]-q[1])**2+(f[off+2]/s[2]-q[2])**2+
                       (f[off+3]/s[3]-q[3])**2+(f[off+4]/s[4]-q[4])**2+(f[off+5]/s[5]-q[5])**2+
                       (f[off+6]/s[6]-q[6])**2;
          let j=K-1;
          if(dist<bestDst[j]){ bestDst[j]=dist; bestIdx[j]=i;
            while(j>0 && bestDst[j]<bestDst[j-1]){ const td=bestDst[j-1], ti=bestIdx[j-1]; bestDst[j-1]=bestDst[j]; bestIdx[j-1]=bestIdx[j]; bestDst[j]=td; bestIdx[j]=ti; j--; }
          }
        }
        let W=0, wp=0, ep=0, epa=0, td=0, fg=0, saf=0, nos=0;
        for(let j=0;j<K;j++){
          const i=bestIdx[j]; if(i<0) break;
          const w=1/(1e-9+Math.sqrt(bestDst[j]));
          const o=i*7; wp+=w*this.outputs[o+0]; ep+=w*this.outputs[o+1]; epa+=w*this.outputs[o+2];
          td+=w*this.outputs[o+3]; fg+=w*this.outputs[o+4]; saf+=w*this.outputs[o+5]; nos+=w*this.outputs[o+6];
          W+=w;
        }
        if(!W) return { wp:0.5, ep:0, epa:0, td_prob:0, fg_prob:0, safety_prob:0, no_score_prob:1 };
        const norm=(x)=>x/W;
        let tdP=norm(td), fgP=norm(fg), safP=norm(saf), nosP=norm(nos);
        const sum=tdP+fgP+safP+nosP; if(sum>1e-6){ tdP/=sum; fgP/=sum; safP/=sum; nosP/=sum; }
        return { wp:norm(wp), ep:norm(ep), epa:norm(epa), td_prob:tdP, fg_prob:fgP, safety_prob:safP, no_score_prob:nosP };
      }
    }
    window.METRICS = new MetricsKNN(200);
  })();
  

/* ===== Stadium data (team_stadiums.csv) ===== */

// Raw rows from team_stadiums.csv
let STADIUM_ROWS = null;

// Map "ARI", "DAL", etc → stadium row
let STADIUM_BY_ABBR = {};

// Currently active venue (home team’s stadium, usually)
let CURRENT_STADIUM = null;

/** Look up by 2–4 letter code (ARI, DAL, NYG, etc.) */
function stadiumForAbbr(abbr){
  if (!abbr) return null;
  const key = String(abbr).trim().toUpperCase();
  return STADIUM_BY_ABBR[key] || null;
}

/** Try to guess the NFL abbr from whatever is in the label/select */
function guessTeamAbbr(label){
  if (!label) return null;
  const raw = String(label).trim();
  const upper = raw.toUpperCase();

  // Already an abbreviation? (e.g. "ARI", "BUF")
  if (/^[A-Z]{2,4}$/.test(upper) && STADIUM_BY_ABBR[upper]) return upper;

  // Try tokens
  const tokens = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  for (const t of tokens){
    if (STADIUM_BY_ABBR[t]) return t;
  }

  // Fallback: if the label contains any known abbr substring
  for (const k in STADIUM_BY_ABBR){
    if (upper.includes(k)) return k;
  }
  return null;
}

/** Short stadium text for UI */
function shortStadiumLine(row){
  if (!row) return 'Stadium: (generic)';
  const bits = [];
  bits.push(row.stadium_name || 'Unknown stadium');
  const loc = [row.city, row.state].filter(Boolean).join(', ');
  if (loc) bits.push(loc);
  const extras = [];
  if (row.surface_type) extras.push(row.surface_type);
  if (row.roof_type)    extras.push(row.roof_type);
  if (row.capacity)     extras.push(`${row.capacity} cap`);
  return 'Stadium: ' + bits.join(' — ') + (extras.length ? ' • ' + extras.join(' • ') : '');
}

/** Blend team strength with stadium home-field advantage into a prior WP */
function priorWithStadium(homeTeam, awayTeam){
  const base = priorFromTeams(homeTeam, awayTeam);
  if (!CURRENT_STADIUM) return base;

  const hfa = +CURRENT_STADIUM.hfa_all_time || +CURRENT_STADIUM.hfa_l80 || 0; // pts
  // Convert “extra points at home” into a small WP shift
  const shift = clamp(hfa / 7 / 3.5, -0.15, 0.15);
  return clamp(base + shift, 0.30, 0.70);
}

/** Use the current home/away labels to set CURRENT_STADIUM and crowd/env */
function applyStadiumFromTeams(){
  if (!STADIUM_ROWS || !sim || !sim.crowd) {
    stadiumLine.textContent = 'Stadium: (generic)';
    return;
  }

  const homeAbbr = guessTeamAbbr(homeLabel.value || homeTeamSel.value);
  const awayAbbr = guessTeamAbbr(awayLabel.value || awayTeamSel.value);

  // Usually: home team’s own stadium; fall back to away’s if needed.
  CURRENT_STADIUM = stadiumForAbbr(homeAbbr) || stadiumForAbbr(awayAbbr) || null;

  if (!CURRENT_STADIUM){
    stadiumLine.textContent = 'Stadium: (generic)';
    sim.crowd.cap = 72000;
    sim.crowd.present = Math.floor(0.85 * sim.crowd.cap);
    sim.crowd.mood = 0;
    renderCrowdMeter();
    return;
  }

  const row = CURRENT_STADIUM;
  stadiumLine.textContent = shortStadiumLine(row);

  // Crowd capacity + initial attendance
  const cap = +row.capacity || 72000;
  sim.crowd.cap = cap;
  sim.crowd.present = Math.round(cap * (0.88 + Math.random()*0.06)); // 88–94%
  sim.crowd.mood = ( (+row.hfa_all_time || 0) >= 0 ? 0.12 : -0.05 );

  // Weather presets based on roof & latitude
  const roof = String(row.roof_type || '').toLowerCase();
  const lat  = +row.lat || 38;

  if (roof.includes('dome')){
    precip.value = 'None';
    wind.value   = 0;
    temp.value   = 70;
  } else if (roof.includes('retractable')){
    // Mild outdoor effect
    wind.value = Math.round(4 + Math.random()*8);
    const base = lat > 42 ? 42 : lat < 33 ? 72 : 60;
    temp.value = Math.round(base + (Math.random()*8-4));
    const p = Math.random();
    if (p < 0.8)       precip.value = 'None';
    else if (p < 0.95) precip.value = 'Light Rain';
    else               precip.value = (lat>40 ? 'Snow' : 'Heavy Rain');
  } else {
    // Fully outdoors
    wind.value = Math.round(5 + Math.random()*12);
    const base = lat > 42 ? 36 : lat < 33 ? 78 : 60;
    temp.value = Math.round(base + (Math.random()*10-5));
    const p = Math.random();
    if (p < 0.72)       precip.value = 'None';
    else if (p < 0.9)   precip.value = 'Light Rain';
    else                precip.value = (lat>40 ? 'Snow' : 'Heavy Rain');
  }

  fansPill.textContent = `Fans: ${sim.crowd.present.toLocaleString()}`;
  renderCrowdMeter();
}

/** 0–1 crowd loudness, based on stadium + attendance + mood */
function crowdVolume(){
  if (!sim || !sim.crowd) return 0.5;

  const c = sim.crowd;
  const row = CURRENT_STADIUM || {};
  const cap = Math.max(c.cap || 0, 1);
  const present = Math.max(c.present || 0, 0);

  // How full is the building?
  const filled = clamp(present / cap, 0, 1);

  let vol = 0.35 + 0.55 * filled;   // base loudness from 0.35–0.90

  const roof = String(row.roof_type || '').toLowerCase();
  if (roof.includes('dome'))        vol += 0.08; // domes are louder
  else if (roof.includes('retract')) vol += 0.03;

  // Mood (your mood values are small, so clamp just in case)
  const mood = clamp(c.mood || 0, -1, 1);
  vol += mood * 0.15; // ±0.15 at extreme moods

  return clamp(vol, 0, 1);
}



// One compact grab that preserves your variable names
const {
  crowdPct, crowdBar, startBtn, pauseBtn, resetBtn, exportCsv, topEpa, rosterStatus, toggleAdv,
  field, wpChart, homeName, awayName, homeScore, awayScore, poss, qtr, clock, toHome, toAway,
  stadiumLine,
  wpVal, feed, lastPlay, boxWrap, leaders, tabPlays, tabScoring, tabDrives, tabAdvanced, fansPill,
  hud, homeTeamSel, awayTeamSel, homeLabel, awayLabel, seed, speed, feelVariance, feelRefs, feelCrowd,
  feelPace, precip, wind, temp, passEarly, passLate, aggr4th, twoPct, btnListCsvTeams, csvOut, btnForceLocalCsv
} = bind(
  'crowdPct','crowdBar','startBtn','pauseBtn','resetBtn','exportCsv','topEpa','rosterStatus','toggleAdv',
  'field','wpChart','homeName','awayName','homeScore','awayScore','poss','qtr','clock','toHome','toAway',
  'stadiumLine',
  'wpVal','feed','lastPlay','boxWrap','leaders','tabPlays','tabScoring','tabDrives','tabAdvanced','fansPill',
  'hud','homeTeamSel','awayTeamSel','homeLabel','awayLabel','seed','speed','feelVariance','feelRefs','feelCrowd',
  'feelPace','precip','wind','temp','passEarly','passLate','aggr4th','twoPct','btnListCsvTeams','csvOut','btnForceLocalCsv'
);


btnListCsvTeams.onclick = () => {
  let msg = '';
  if (!PLAYERS_CSV_ROWS) {
    msg = 'CSV not loaded yet.\n\nTip: If you opened this HTML via file:// most browsers block fetch(). Serve it via localhost (e.g., `python -m http.server`).';
  } else {
    msg = `Teams found (${TEAM_SHEETS.length}):\n` + TEAM_SHEETS.join(', ');
  }
  csvOut.textContent = msg;
  csvOut.style.display = 'block';
};

btnForceLocalCsv.onclick = async () => {
  rosterStatus.textContent = 'Forcing local CSV (players.csv / Players.csv)...';
  const ok = await tryLoadPlayersCsv(true); // forceLocal = true
  rosterStatus.textContent = ok
    ? `Loaded ${TEAM_SHEETS.length} teams from CSV (local)`
    : 'Failed to load local CSV — still using generated players.';
  // also dump list
  btnListCsvTeams.click();
};



/* ===== WP toggle (UI injected) ===== */
let showWP = true;
(function addWPToggle(){
  try{
    const btn = document.createElement('button');
    btn.id = 'toggleWP';
    btn.className = 'pill';
    btn.style.marginLeft = '8px';
    btn.textContent = 'WP: On';
    (toggleAdv?.parentElement || toggleAdv)?.insertBefore
      ? toggleAdv.parentElement.insertBefore(btn, toggleAdv.nextSibling)
      : (toggleAdv?.after ? toggleAdv.after(btn) : document.body.appendChild(btn));
    btn.addEventListener('click', () => {
      showWP = !showWP;
      btn.textContent = 'WP: ' + (showWP ? 'On' : 'Off');
      renderPlays(); // re-render with/without ΔWP
    });
  }catch(e){ console.warn('WP toggle mount failed', e); }
})();


// URL params
const PARAMS = new URLSearchParams(location.search);

// Support either explicit ?home=&away= OR a single ?matchup= like "Giants vs Falcons"
const URL_MATCHUP = (PARAMS.get('matchup') || '').trim();
let URL_HOME = (PARAMS.get('home') || '').trim();
let URL_AWAY = (PARAMS.get('away') || '').trim();

// Parse "A vs B", "A v. B", "A @ B", "A - B", or "A — B"
if (!URL_HOME && !URL_AWAY && URL_MATCHUP){
  const parts = URL_MATCHUP
    .replace(/\s+/g,' ')
    .trim()
    .split(/\s*(?:vs\.?|v\.?|@|-|—)\s*/i)
    .map(s => s.trim())
    .filter(Boolean);
  if (parts.length >= 2){
    [URL_HOME, URL_AWAY] = parts.slice(0,2);
  }
}

// If players param given, normalize possible refs/heads URL → raw
const RAW_PLAYERS_PARAM = (PARAMS.get('players') || '').replace('/refs/heads/', '/');

// Optional autostart support (?autostart=1)
const URL_AUTOSTART = PARAMS.has('autostart');

// Fallback CSV so the app works even with no ?players= in the URL
const FALLBACK_PLAYERS_URL = 'https://raw.githubusercontent.com/aaronwolk00/game_sim/main/players.csv';



function logPlay(tag, line, off, scoring=false, epa=null, wpd=null, driveEp=null){
  plays.push({ tag, line, off, scoring, epa, wpd, driveEp });

  if (activeTab === 'plays') renderPlays();
  lastPlay.textContent = 'Last Play: ' + line.replace(/^.* — /,''); // keep your suffix trim

  // Track EPA → Top EPA Plays
  if (epa !== null && Number.isFinite(epa)){
    const short = line.replace(/^Q\d+\s+\d+:\d+\s+\|\s+[^—]+—\s*/,'').trim();
    epaPlays.push({ epa, text: short });
    if (epaPlays.length > 800) epaPlays.shift();
    renderTopEpa();
  }
}



let showAdvanced=false; toggleAdv.onclick=()=>{showAdvanced=!showAdvanced; toggleAdv.textContent='PBP: '+(showAdvanced?'Advanced On':'Advanced Off'); renderPlays();};
function hash32(str){let h=1779033703^str.length;for(let i=0;i<str.length;i++){h=Math.imul(h^str.charCodeAt(i),3432918353);h=(h<<13)|(h>>>19);}return(h>>>0);}
function rngFromSeed(s){let a=hash32(s)||1;return()=>{a=(a+0x6D2B79F5)>>>0;let t=Math.imul(a^(a>>>15),1|a);t^=t+Math.imul(t^(t>>>7),61|t);return((t^(t>>>14))>>>0)/4294967296;};}
function randNorm(r,m=0,s=1){const u=Math.max(1e-12,r()), v=r();return m+Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v)*s;}
function clamp(x,a,b){return Math.max(a,Math.min(b,x));}
function yardText(y){return y>=50?`Opp ${100-y}`:`Own ${y}`;}
function dnTxt(d){return ['1st','2nd','3rd','4th'][d-1]}

// Map current/snapshot state to METRICS.estimate()
function metricsForSnap(snap){
    if (!window.METRICS || !METRICS.estimate) return null;
    // Prefer explicit values on the snap, fall back to sim.hud when needed
    const q   = Number(snap.qtr  ?? sim?.hud?.qtr  ?? 1);
    const sec = Number(snap.secs ?? sim?.hud?.secs ?? 900);
    const dwn = Number(snap.down ?? sim?.hud?.down ?? 1);
    const dst = Number(snap.dist ?? sim?.hud?.dist ?? 10);
    const yl  = Number(snap.yard ?? sim?.hud?.yard ?? 25);
    const possTeam = String(snap.poss ?? sim?.hud?.poss ?? 'Home');
    const posteam_is_home = (possTeam === 'Home') ? 1 : 0;
  
    const scoreDiff = posteam_is_home
      ? (sim?.score?.home - sim?.score?.away)
      : (sim?.score?.away - sim?.score?.home);
  
    try{
      return METRICS.estimate({
        qtr: q,
        game_seconds_remaining: Math.max(0, (5 - q) * 900 + sec),
        down: dwn,
        ydstogo: dst,
        yardline_100: yl,
        score_differential: scoreDiff,
        posteam_is_home
      });
    }catch(_){ return null; }
  }
  

/* ===== CSV / roster ===== */
// Robust CSV parsing with BOM handling and reliable header detection.
// Assumes the first REAL row is the header; tolerates a few junk/blank lines before it.

const TEAM_COL = 'Team';

function stripBOM(s){ return s.replace(/^\uFEFF/, ''); }

/** Basic CSV parser (RFC4180-ish): handles quotes, commas, and newlines inside quotes. */
function parseCSV(text){
  text = stripBOM(String(text || ''));
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++){
    const c = text[i];

    if (inQuotes){
      if (c === '"'){
        if (text[i+1] === '"'){ field += '"'; i++; }   // escaped quote
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"'){
        inQuotes = true;
      } else if (c === ','){
        row.push(field); field = '';
      } else if (c === '\n'){
        row.push(field); rows.push(row);
        row = []; field = '';
      } else if (c !== '\r'){
        field += c;
      }
    }
  }
  // push last field/row
  row.push(field); rows.push(row);

  // Trim trailing empty lines
  while (rows.length && rows[rows.length-1].every(x => String(x||'').trim()==='')) rows.pop();

  if (!rows.length) return [];

  // Header row → object array
  // Deduplicate header names if necessary (e.g., repeated "BLANK")
  const rawHeader = rows.shift().map(h => String(h||'').trim());
  const seen = new Map();
  const header = rawHeader.map(h => {
    if (!h) h = 'col';
    const base = h;
    let k = h, idx = 2;
    while (seen.has(k)) { k = `${base}_${idx++}`; }
    seen.set(k, true);
    return k;
  });

  return rows
    .filter(r => r && r.some(x => String(x||'').trim() !== ''))
    .map(r => {
      const obj = {};
      for (let i = 0; i < header.length; i++){
        obj[header[i]] = r[i] === undefined ? '' : r[i];
      }
      // Trim whitespace on all string fields
      for (const k in obj){
        if (typeof obj[k] === 'string') obj[k] = obj[k].trim();
      }
      return obj;
    });
}

/**
 * Smart wrapper: skips any leading junk/blank lines and starts at the first line
 * that looks like a real header (contains "Team" and "Position", or matches "^#,Team,Position").
 */
function parseCSVSmart(text){
  text = stripBOM(String(text || ''));
  const lines = text.split(/\r?\n/);

  let headerIdx = -1;
  for (let i = 0, seen = 0; i < lines.length && seen < 12; i++){
    const raw = lines[i];
    if (!raw.trim()) continue;
    seen++;

    const li = raw.toLowerCase();
    const looksLikeHeader =
      /^#\s*,\s*team\s*,\s*position/i.test(raw) ||
      (li.includes('team') && li.includes('position'));

    if (looksLikeHeader){
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) headerIdx = 0; // fallback: assume first line is header

  const sliced = lines.slice(headerIdx).join('\n');
  const rows = parseCSV(sliced);

  // Final sanity: ensure "Team" column exists (caller expects it).
  // If it's missing, leave as-is; the loader will warn and fall back.
  return rows;
}


function num(x,d=70){const v=Number(x);return Number.isFinite(v)?v:d;}
const OLp=new Set(['LT','LG','C','RG','RT','OL']), DLp=new Set(['DT','NT','DE','IDL']), EDGEp=new Set(['EDGE']), LBp=new Set(['LB','MLB','ILB','OLB']), DBp=new Set(['CB','NB','DB','S','FS','SS']);
function pOVR(p){if(p.OVR!==undefined&&p.OVR!=='') return num(p.OVR,70);const SPD=num(p.SPD,70),STR=num(p.STR,70),AGI=num(p.AGI,70),INT=num(p.INT,70),TEC=num(p.TEC,70),H=num(p.HANDS,70),T=num(p.TACK,70),B=num(p.BLOCK,70),C=num(p.COVER,70),PA=num(p.PASS_ACC,70),PP=num(p.PASS_PWR,70);const pos=(p.Position||'').toUpperCase();if(pos==='QB')return 0.55*PA+0.25*PP+0.2*INT;if(pos==='WR'||pos==='TE'||pos==='RB')return 0.4*SPD+0.2*AGI+0.2*H+0.2*INT;if(OLp.has(pos))return 0.5*B+0.2*STR+0.2*TEC+0.1*INT;if(DLp.has(pos)||EDGEp.has(pos))return 0.35*STR+0.25*TEC+0.2*AGI+0.2*T;if(LBp.has(pos))return 0.3*T+0.25*INT+0.25*AGI+0.2*STR;if(DBp.has(pos))return 0.35*C+0.25*AGI+0.2*INT+0.2*T;return (SPD+STR+AGI+INT+TEC+H+T+B+C+PA+PP)/11;}
function buildTeam(rows){
  const players=rows.map((r,i)=>({id:i,first:r['First Name'],last:r['Last Name'],pos:(r['Position']||'').toUpperCase(),
    OVR:pOVR(r), SPD:+r.SPD||70, STR:+r.STR||70, AGI:+r.AGI||70, INT:+r.INT||70, TEC:+r.TEC||70, HANDS:+r.HANDS||70, TACK:+r.TACK||70, BLOCK:+r.BLOCK||70, COVER:+r.COVER||70, PASS_ACC:+r.PASS_ACC||70, PASS_PWR:+r.PASS_PWR||70, KICK_POW:+r.KICK_POW||70, KICK_ACC:+r.KICK_ACC||70, DISC:+r.DISC||70,
    adv:{att:0,comp:0,yards:0,td:0,int:0,sacks:0,dropbacks:0,pressures:0,ttt:0,tttN:0,air:0,yac:0,targets:0,catches:0,drops:0,sep:0,sepN:0,fast:0,ayDepth:0,ayN:0,tkl:0,sk:0,pd:0,ints:0,ry:0,carries:0,recY:0}}));
  const by=new Map();players.forEach(p=>{if(!by.has(p.pos))by.set(p.pos,[]);by.get(p.pos).push(p);});for(const v of by.values()) v.sort((a,b)=>pOVR(b)-pOVR(a));
  const get=(pos,n)=>(by.get(pos)||[]).slice(0,n); const top=(set,n)=>players.filter(p=>set.has(p.pos)).sort((a,b)=>pOVR(b)-pOVR(a)).slice(0,n);
  const qb=get('QB',1)[0]; const wr=get('WR',5); const te=get('TE',3); const rb=get('RB',3); const k=get('K',1)[0]; const p=get('P',1)[0];
  const dl=top(new Set([...DLp,...EDGEp]),7), lb=top(LBp,5), db=top(DBp,6), ol=top(OLp,7);
  const offense=[qb&&{w:4,val:pOVR(qb)},...rb.slice(0,2).map(x=>({w:1,val:pOVR(x)})),...wr.slice(0,3).map(x=>({w:1.2,val:pOVR(x)})),...te.slice(0,1).map(x=>({w:1,val:pOVR(x)})),...ol.slice(0,5).map(x=>({w:0.6,val:pOVR(x)}))].filter(Boolean);
  const off=offense.reduce((a,b)=>a+b.w*b.val,0)/(offense.reduce((a,b)=>a+b.w,0)||1);
  const dparts=[]; dl.slice(0,4).forEach(x=>dparts.push({w:1.2,val:pOVR(x)})); lb.slice(0,3).forEach(x=>dparts.push({w:1,val:pOVR(x)})); db.slice(0,4).forEach(x=>dparts.push({w:1.1,val:pOVR(x)}));
  const def=dparts.reduce((a,b)=>a+b.w*b.val,0)/(dparts.reduce((a,b)=>a+b.w,0)||1);
  return {players,qb,wr,te,rb,k,p,dl,lb,db,offense:off,defense:def,special:(k&&p)?(0.5*(0.7*k.KICK_ACC+0.3*k.KICK_POW)+0.5*(0.7*p.KICK_POW+0.3*p.KICK_ACC)):70,
    stats:{team:{plays:0,yards:0,passYds:0,rushYds:0,punts:0,fgm:0,fga:0,td:0,ints:0,downs:0,pen:0,third:{c:0,a:0},fourth:{c:0,a:0},epa:0}},
    drives:[]};
}


/* ===== EP/WP ===== */
const sigmEP = z => 1/(1+Math.exp(-z));
const clamp01 = x => Math.max(0, Math.min(1, x));

// Base EP from yardline (own GL ≈ -1.40 → opp GL ≈ +6.00), slope at midfield ≈ 0.12
const EP_LLO   = -1.40;
const EP_LHI   =  6.00;
const EP_RANGE = (EP_LHI - EP_LLO);
const EP_SLOPE_MID = 0.12;
const EP_K     = EP_RANGE / (4*EP_SLOPE_MID); // ~15.42

function EP_base_from_y(y){
  const yy = clamp(Math.round(y), 1, 99);
  return EP_LLO + EP_RANGE * sigmEP((yy - 50)/EP_K);
}

// 1st-down probability by down & distance (smooth logistic, no tables)
function pFirstDown(down, dist){
  const d = Math.max(1, Math.min(25, Math.round(dist||10)));
  const cfg = {
    1: {a: -2.047, b: 0.12},  // p(10) ~0.70
    2: {a: -1.399, b: 0.16},  // p(10) ~0.45
    3: {a: -1.101, b: 0.22},  // p(10) ~0.25
    4: {a: -1.013, b: 0.35},  // p(1)  ~0.66, p(10)~0.08
  }[down] || {a:-1.399, b:0.16};
  const z = -(cfg.a + cfg.b * d);
  return clamp01(1/(1+Math.exp(-z)));
}

// Smooth net punt yards from LOS (coarse but monotone)
function netPuntFromLOS(y){
  const field = clamp(y, 1, 99);
  const base  = 42;
  const ownDepth = Math.max(0, 50 - field);
  const oppDepth = Math.max(0, field - 50);
  const adj = -0.08*ownDepth - 0.10*oppDepth;
  return clamp(Math.round(base + adj), 28, 50);
}

// Final EP(down,dist,y): blend success vs fail (fail ~ eventual punt)
function EP(down, dist, y){
  // base from yardline (your logistic)
  const base = EP_base_from_y(y);

  // Down/distance pressure; harsher when far from the end zone
  const fieldFrac = y/100;                    // 0 own GL → 1 opp GL
  const damp      = 0.55 + 0.45*(1 - fieldFrac); // more penalty far from EZ

  const d = clamp(Math.round(dist||10), 1, 50);

  // Stronger separation by down so 2nd < 1st (and 3rd/4th harsher)
  const downAdjBase = [0, -0.70, -1.45, -2.35][(down|0)-1] ?? -2.0;
  const downAdj = downAdjBase * damp;

  // Distance hurts more on 3rd/4th than 1st/2nd
  const distSlope = (down>=3 ? 0.055 : 0.035);
  const distAdj = -distSlope * d * damp;

  // Extra long-yardage malus on 3rd/4th (e.g., 3rd & 18)
  const longYds = Math.max(0, d - 10);
  const longAdj = (down>=3 ? -0.10 * Math.min(longYds, 20) * damp : 0);

  return clamp(base + downAdj + distAdj + longAdj, -2.5, 6.95);
}


/* ===== Pre-snap DriveEP (offense-only expected points for *this* drive) ===== */
const _fgProb = (dist, pow=70, acc=70) =>
  (typeof fgMakeProb === 'function')
    ? fgMakeProb(dist, pow, acc)
    : clamp(0.95 - 0.012*Math.max(0, dist-33), 0.05, 0.99); // simple fallback


function driveEPForState(snap, homeTeam, awayTeam){
      // If metrics are available, prefer their EP directly (kept non-negative for drive EP)
  const est0 = metricsForSnap(snap);
  if (est0 && Number.isFinite(est0.ep)) {
    return clamp(Math.max(0, est0.ep), 0, 6.95);
  }
  const { poss, down, dist, yard } = snap;
  const atk = (poss === 'Home') ? homeTeam : awayTeam;
  const def = (poss === 'Home') ? awayTeam  : homeTeam;

  // Evaluate a 4th-down choice from current spot
  function epFourth(dist4){
    const distGL = 100 - yard;
    const FGdist = Math.round(distGL + 17);
    const k = atk.k || { KICK_POW:70, KICK_ACC:70 };

    // FG expected value
    const ep_fg = (FGdist <= 68) ? (3 * fgMakeProb(FGdist, k.KICK_POW, k.KICK_ACC)) : -Infinity;

    // Go-for-it expected value (only if short)
    const goThresh = (yard >= 50 ? 4.0 : 2.0) - ((+aggr4th.value - 50)/25);
    let ep_go = -Infinity;
    if (dist4 <= goThresh){
      const pConv = clamp(0.48 + (atk.offense - def.defense)/220, 0.30, 0.70);
      const ep_after = EP(1, Math.min(10, 100 - yard), yard);
      ep_go = pConv * ep_after;     // fail → 0 for this drive
    }

    // Punt contributes ~0 to *this drive’s* points
    const ep_punt = 0;

    return clamp(Math.max(ep_fg, ep_go, ep_punt, 0), 0, 6.95);
  }

  // On actual 4th down, choose immediately
  if (down === 4){
    return epFourth(dist);
  }

  // 1st–3rd down: expected value of (convert the series) vs (fail → 4th-down choice)
  const pConv   = clamp(pFirstDown(down, dist), 0, 1); // your logistic
  const convEP  = clamp(EP(1, Math.min(10, 100 - yard), yard), 0, 6.95);

  // Assume fail yields 4th from (roughly) the same spot & distance (conservative)
  let fallback = epFourth(dist);

  // Small risk haircut for obvious pass on 3rd & long already in FG range
  if (down === 3 && dist >= 12 && yard >= 70) fallback = Math.max(0, fallback - 0.25);

  const mix = pConv * convEP + (1 - pConv) * fallback;
  return clamp(mix, 0, 6.95);
}




let wpSeries=[0.5], wpSmooth=0.5, wpPrior=0.5;
function priorFromTeams(h,a){const sH=(h.offense+h.defense)/2,sA=(a.offense+a.defense)/2;return clamp(1/(1+Math.exp(-(sH-sA)/8)),0.35,0.65);}
const logit = x => Math.log(x/(1-x));
const invlogit = z => 1/(1+Math.exp(-z));


// ===== WP endgame helpers (place ABOVE stateWP) =====
const ONSIDE_P = 0.08; // assumed onside success rate (used for multi-score cap)

/** How many 8-point possessions are needed to erase a deficit */
function _needScores(absLead){
  return Math.ceil(absLead / 8);
}

/** Extra clock the trailing team can realistically "buy" (timeouts + 2MW) */
function _stoppageCredit(q, s, trailingTO){
  // Add ~38s per timeout (stop the clock + runoff prevention); generous but realistic.
  let credit = 38 * Math.max(0, trailingTO|0);
  // If we're still before the 2:00 warning in Q4, add one more ~38s credit.
  const tLeft = (5 - q) * 900 + s;
  if (q === 4 && s > 120) credit += 38;
  // Cap total credit so it can’t exceed two full plays worth.
  return Math.min(120, credit);
}

/** Very fast possession lengths late (hurry-up/no huddle) */
function _secPerPoss(haveBall){
  // If you already have the ball, no kickoff/punt transition tax.
  return haveBall ? 52 : 64; // seconds
}

/** Upper bound for trailing WP when NP>=2 late (onside chains become tiny) */
function _multiScoreCap(np, tLeft){
  if (np <= 1) return 1;
  const chain = Math.pow(ONSIDE_P, np - 1);
  // A small ceiling that tightens as time dwindles
  if (tLeft <= 120) return 0.004 * chain;
  if (tLeft <= 300) return 0.010 * chain;
  if (tLeft <= 480) return 0.020 * chain;
  return 0.035 * chain;
}


function stateWP(hs, as, q, s, y, p, prior){
  const tLeft = (5 - q) * 900 + s;         // seconds left
  const tf    = clamp(1 - tLeft/3600, 0, 1);
  const lead  = hs - as;
  const possSign = (p === 'Home') ? 1 : -1;

  // Base logistic (field/score/prior + a modest EP nudge)
  const zPrior = logit(clamp(prior, 0.05, 0.95)) * (0.55 - 0.30*tf);
  const zLead  = (0.35 + 1.05*tf) * (lead/7);
  const zField = 0.20 * ((y - 50)/50) * possSign;
  const epNow  = EP(sim.hud.down, sim.hud.dist, y);
  const zEP    = 0.10 * ((p === 'Home') ? epNow : -epNow) / 6;
  let wp = clamp(invlogit(zPrior + zLead + zField + zEP), 0.001, 0.999);
// Blend in metrics-based WP (posteam WP → convert to Home WP), then continue with endgame logic
try{
    const posteam_is_home = (p === 'Home') ? 1 : 0;
    const scoreDiff = posteam_is_home ? (hs - as) : (as - hs);
    const est = METRICS?.estimate?.({
        qtr: q,
        game_seconds_remaining: s,
        down: sim?.hud?.down ?? 1,
        ydstogo: sim?.hud?.dist ?? 10,
        yardline_100: y,
        score_differential: scoreDiff,
        posteam_is_home
    });
    if (est && Number.isFinite(est.wp)) {
        const homeWP_from_metrics = posteam_is_home ? est.wp : (1 - est.wp);
        wp = clamp(0.70 * homeWP_from_metrics + 0.30 * wp, 0.0001, 0.9999); // 70% metrics / 30% model
    }
    }catch(_){}


  // Possession budget for the TRAILING side (fast end-game pace)
  const timeoutsHome = timeouts.Home || 0;
  const timeoutsAway = timeouts.Away || 0;
  const trailing = lead>0 ? 'Away' : (lead<0 ? 'Home' : null);
  const trailingTO = trailing ? (timeouts[trailing]||0) : 0;
  const trailingHasBall = trailing ? (p === trailing) : false;

  const hurry       = (tLeft <= 240);
  const secPerPoss  = hurry ? 55 : 70;     // faster pace late
  const onsideP     = 0.03;                // keep tiny unless you model real onside
  const bonusTO     = 28 * trailingTO;     // ~28s of saved clock per TO
  let possLeft      = Math.floor((tLeft + bonusTO)/secPerPoss) + (trailingHasBall ? 1 : 0);
  const needScores  = Math.ceil(Math.abs(lead)/8);   // allow 2-pt (8 each)

  // If they physically can’t get enough possessions → shove to leader
  if (trailing && needScores > possLeft){
    const scarcity = needScores - possLeft;       // 1+ => impossible without miracles
    const lock     = Math.pow(clamp(1 - tLeft/300, 0, 1), 2.2); // grows last 5:00
    const target   = clamp(0.96 + 0.02*scarcity, 0.96, 0.999);
    const homeTarget = (lead>0) ? target : (1 - target);
    wp = (1 - lock)*wp + lock*homeTarget;
  }

  // Kneel-out detection: leader with ball runs out clock (defense has TOs)
  const leader = lead>0 ? 'Home' : (lead<0 ? 'Away' : null);
  const leaderHasBall = leader && (p === leader);
  if (leader && leaderHasBall){
    const defTO        = (leader==='Home') ? timeoutsAway : timeoutsHome;
    const kneelBudget  = 3*40 + 40*defTO;  // three kneels + TO burn (very conservative)
    if (tLeft <= kneelBudget){
      const lock      = Math.pow(clamp(1 - (tLeft - 20)/kneelBudget, 0, 1), 1.8);
      const homeTarget= (leader==='Home') ? 0.999 : 0.001;
      wp = (1 - lock)*wp + lock*homeTarget;
    }
  }

  // Two-score late reinforcement: e.g., +14 with 1:21 and ball → ~99%+
  if (Math.abs(lead) >= 14 && tLeft <= 121){
    const lock      = Math.pow(clamp(1 - tLeft/121, 0, 1), 1.5);
    const homeTarget= (lead>0) ? 0.992 : 0.008;
    wp = (1 - lock)*wp + lock*homeTarget;
  }

  // Absolutely impossible in final seconds (prevents 12–16% nonsense)
  if (tLeft <= 30 && Math.abs(lead) >= 25){
    wp = lead>0 ? 0.9995 : 0.0005;
  }

  return clamp(wp, 0.0001, 0.9999);
}



// Add a helper for a time-aware ΔWP cap (small early, big late)
function wpCap(q, s){
  const tLeft = (5 - q) * 900 + s;
  const tf = clamp(1 - tLeft/3600, 0, 1);
  // A bit higher late so single plays can move WP more when they must
  return 0.03 + 0.70*Math.pow(tf, 2.25);
}

function drawWP(){const c=wpChart;const w=c.width=300,h=c.height=110,ctx=c.getContext('2d');ctx.clearRect(0,0,w,h);ctx.strokeStyle='#243055';ctx.beginPath();for(let y=0;y<=h;y+=h/4){ctx.moveTo(0,y);ctx.lineTo(w,y);}ctx.stroke();if(wpSeries.length>1){ctx.strokeStyle='#5eead4';ctx.lineWidth=2;ctx.beginPath();for(let i=0;i<wpSeries.length;i++){const x=i*(w/(wpSeries.length-1));const y=(1-wpSeries[i])*h;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}ctx.stroke();}}

/* ===== Field ===== */
const Field=(()=>{function base(ctx,w,h,qtr){const l=w*0.06,r=w*0.94,top=12,bot=h-12;const g=ctx.createLinearGradient(0,top,0,bot);g.addColorStop(0,'#0b5d49');g.addColorStop(1,'#0a4f3f');ctx.fillStyle=g;ctx.fillRect(l,top,r-l,bot-top);ctx.strokeStyle='#c7f9ec';ctx.strokeRect(l,top,r-l,bot-top);const flip=(qtr%2===0);ctx.fillStyle='rgba(15,40,60,.55)';ctx.fillRect(l,top,(r-l)/20,bot-top);ctx.fillStyle='rgba(60,25,25,.55)';ctx.fillRect(l+(r-l)*19/20,top,(r-l)/20,bot-top);ctx.fillStyle='#d1fae5';ctx.font='bold 14px system-ui';ctx.fillText(flip?'AWAY':'HOME',l+8,top+16);ctx.fillText(flip?'HOME':'AWAY',r-62,top+16);for(let i=0;i<=20;i++){const x=l+(r-l)*i/20;ctx.strokeStyle='#e2e8f0';ctx.lineWidth=(i%5===0?1.4:0.8);ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bot);ctx.stroke();if(i>0&&i<20&&i!==10){ctx.fillStyle='#d1fae5';ctx.font='11px system-ui';const n=(i<=10?i*5:(20-i)*5);ctx.fillText(n.toString(),x-7,top+12);ctx.save();ctx.translate(x+7,bot-4);ctx.rotate(Math.PI);ctx.fillText(n.toString(),0,0);ctx.restore();}}return {l,r,top,bot};}
function yardToX(y,w,l,r){return l+(r-l)*(y/100);}
return{render(state){const c=field,w=c.width,h=c.height,ctx=c.getContext('2d');const b=base(ctx,w,h,state.hud.qtr);const xLOS=yardToX(state.hud.yard,w,b.l,b.r);const x1D=yardToX(Math.min(100,state.hud.yard+state.hud.dist),w,b.l,b.r);ctx.strokeStyle='#93c5fd';ctx.setLineDash([5,7]);ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(xLOS,b.top);ctx.lineTo(xLOS,b.bot);ctx.stroke();ctx.setLineDash([]);if(state.hud.yard+state.hud.dist<100){ctx.strokeStyle='#facc15';ctx.setLineDash([6,8]);ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(x1D,b.top);ctx.lineTo(x1D,b.bot);ctx.stroke();ctx.setLineDash([]);}ctx.fillStyle='#f59e0b';ctx.beginPath();ctx.ellipse(xLOS+4,(b.top+b.bot)/2,6,4,0,0,Math.PI*2);ctx.fill();}}})();

/* ===== Sim state & UI ===== */
let HOME=null, AWAY=null, running=false, paused=false, sim=null, pendingKickoff=null, pendingPAT=null, pendingScoreIdx=-1;

// ---- Late-game / clock management flags ----
let twoMinUsed = { H1:false, H2:false };  // 2:00 warning fired once per half
let lastTimeoutCalledAt = { Home: 9999, Away: 9999 }; // "time-left" at last TO to avoid spamming
const TO_MIN_GAP = 14;  // don't burn timeouts on back-to-back snaps (seconds of game clock)

// For logging timeouts cleanly
function logTimeout(team, reason=''){
  timeouts[team] = Math.max(0, (timeouts[team]||0) - 1);
  if (team === 'Home') toHome.textContent = timeouts.Home;
  else toAway.textContent = timeouts.Away;
  logPlay('TIMEOUT', `Timeout — ${team}${reason?` (${reason})`:''}`, team, false, 0, 0, 0);
}

// Decide whether *defense* should stop the clock after an in-bounds play
function wantDefenseTO(teamOnDefense, tLeft, diff, h){
  // trailing and late => use TO to preserve time after in-bounds plays
  const trailing = (teamOnDefense === 'Home') ? (diff < 0) : (diff > 0);
  if (!trailing) return false;
  if (timeouts[teamOnDefense] <= 0) return false;
  // get stricter as time dwindles
  if (tLeft <= 180) return true;          // final 3:00
  if (tLeft <= 300 && Math.abs(diff) <= 8) return true; // <=5:00 in one-score game
  return false;
}

// Decide whether *offense* should stop the clock after an in-bounds play
function wantOffenseTO(teamOnOffense, tLeft, diff){
  const offenseIsHome = (teamOnOffense === 'Home');
  const trailing = offenseIsHome ? (diff < 0) : (diff > 0);
  if (!trailing) return false;
  if (timeouts[teamOnOffense] <= 0) return false;

  if (tLeft <= 140) return true;          // under 2:20, typical hurry
  if (tLeft <= 300 && Math.abs(diff) >= 9) return true; // two-possession chase under 5:00
  return false;
}

/**
 * Apply clock runoff for a play, but interpose:
 *  - Two-minute warning (2Q/4Q)
 *  - Timeouts by offense/defense when appropriate
 *
 * @param {number} runOffSec - seconds to take off if clock would run
 * @param {object} ctx - { inBounds:boolean, offense:'Home'|'Away', scored?:boolean, pat?:boolean }
 */
function applyClock(runOffSec, ctx){
  const h = sim.hud, s = sim.score;
  const offense = ctx.offense;
  const defense = (offense === 'Home') ? 'Away' : 'Home';

  // Calculate time before the play finishes
  let tLeftBefore = (5 - h.qtr) * 900 + h.secs;

  // If the play ends out-of-bounds/incomplete/score, the game clock is stopped.
  // In that case, we don't burn runOffSec (but still check 2MW if a running clock crossed it).
  let newSecs = h.secs;

  if (ctx.inBounds) {
    // Clock would have run → allow timeouts to shrink the effective runoff
    let useRunoff = runOffSec;

    // Late-game: defense first tries to stop it if trailing
    const diff = s.home - s.away; // + = Home leads
    const tLeftAfterPlay = Math.max(0, tLeftBefore - useRunoff);
    const sinceLastTO_Def = Math.abs((lastTimeoutCalledAt[defense]||9999) - tLeftBefore);

    let tookTO = false;

    if (wantDefenseTO(defense, tLeftBefore, diff, h) && sinceLastTO_Def >= TO_MIN_GAP){
      // Sim effect: shave ~10s of between-plays bleed
      useRunoff = Math.max(6, useRunoff - 10);
      lastTimeoutCalledAt[defense] = tLeftBefore;
      logTimeout(defense, 'defense');
      tookTO = true;
    }

    // If offense is the trailing side and defense didn't just take one, let offense take one
    const sinceLastTO_Off = Math.abs((lastTimeoutCalledAt[offense]||9999) - tLeftBefore);
    if (!tookTO && wantOffenseTO(offense, tLeftBefore, diff) && sinceLastTO_Off >= TO_MIN_GAP){
      useRunoff = Math.max(6, useRunoff - 10);
      lastTimeoutCalledAt[offense] = tLeftBefore;
      logTimeout(offense, 'offense');
      tookTO = true;
    }

    newSecs = Math.max(0, h.secs - useRunoff);
  } else {
    // Stoppage (incomplete, OOB, score, some penalties). Keep clock as-is.
    newSecs = h.secs;
  }

  // Two-minute warning: only fires once per half, when a *running* clock would cross 2:00.
  // It occurs at 2:00 of Q2 and Q4.
  const is2MWQuarter = (h.qtr === 2 || h.qtr === 4);
  const halfKey = (h.qtr <= 2) ? 'H1' : 'H2';
  const crossing2MW = (h.secs > 120 && newSecs < 120);

  if (ctx.inBounds && is2MWQuarter && !twoMinUsed[halfKey] && crossing2MW){
    // Stop exactly at 2:00 and mark used
    newSecs = 120;
    twoMinUsed[halfKey] = true;
    logPlay('TIME', 'Two-Minute Warning', h.poss, false, 0, 0, 0);
  }

  h.secs = newSecs;
}


let plays=[], scoring=[], drives=[]; let timeouts={Home:3,Away:3};
let epaPlays = [];
let TEAM_SHEETS = [];            // list of team names (from CSV "Team" column)
let PLAYERS_CSV_ROWS = null;     // parsed rows of players.csv

function updateHUD(){const h=sim.hud;hud.textContent=`Q${h.qtr} • ${Math.floor(h.secs/60)}:${String(h.secs%60).padStart(2,'0')} • ${dnTxt(h.down)} & ${Math.max(1,Math.round(h.dist))} @ ${yardText(h.yard)} • Poss: ${h.poss}`;}
function updateScore(){const s=sim.score;homeScore.textContent=s.home;awayScore.textContent=s.away;poss.textContent=sim.hud.poss;qtr.textContent=sim.hud.qtr;clock.textContent=`${Math.floor(sim.hud.secs/60)}:${String(sim.hud.secs%60).padStart(2,'0')}`;}
function renderPlays(){
  feed.innerHTML = '';
  const fmtAux = (p) => {
    const bits = [];
    if (Number.isFinite(p.epa))    bits.push(`EPA ${(p.epa>=0?'+':'')}${p.epa.toFixed(2)}`);
    if (showWP && Number.isFinite(p.wpd)) bits.push(`ΔWP ${(p.wpd>=0?'+':'')}${(p.wpd*100).toFixed(1)}%`);
    if (Number.isFinite(p.driveEp)) bits.push(`DriveEP ${p.driveEp.toFixed(2)}`);
    return bits.join(' | ');
  };
  plays.forEach(p => {
    const d = document.createElement('div');
    d.className = 'item ' + (p.scoring ? 'score' : (p.off === 'Home' ? 'home' : 'away'));
    const left  = `<span class="tag">${p.tag}</span>${p.line}`;
    const right = showAdvanced ? `<div class="aux">${fmtAux(p)}</div>` : '';
    d.innerHTML = `<div>${left}</div>${right}`;
    feed.prepend(d);
  });
}

function renderBox(){const H=HOME?.stats.team||{},A=AWAY?.stats.team||{};boxWrap.innerHTML=`<table class="table"><thead><tr><th></th><th>Plays</th><th>Yards</th><th>Pass</th><th>Rush</th><th>Punts</th><th>FG</th><th>TD</th><th>INT</th><th>Pen</th><th>3rd</th><th>4th</th><th>EPA</th></tr></thead><tbody>
<tr><th>${homeLabel.value}</th><td>${H.plays||0}</td><td>${H.yards||0}</td><td>${H.passYds||0}</td><td>${H.rushYds||0}</td><td>${H.punts||0}</td><td>${H.fgm||0}/${H.fga||0}</td><td>${H.td||0}</td><td>${H.ints||0}</td><td>${H.pen||0}</td><td>${(H.third?.c||0)}/${(H.third?.a||0)}</td><td>${(H.fourth?.c||0)}/${(H.fourth?.a||0)}</td><td>${(H.epa||0).toFixed?.(2)||'0.00'}</td></tr>
<tr><th>${awayLabel.value}</th><td>${A.plays||0}</td><td>${A.yards||0}</td><td>${A.passYds||0}</td><td>${A.rushYds||0}</td><td>${A.punts||0}</td><td>${A.fgm||0}/${A.fga||0}</td><td>${A.td||0}</td><td>${A.ints||0}</td><td>${A.pen||0}</td><td>${(A.third?.c||0)}/${(A.third?.a||0)}</td><td>${(A.fourth?.c||0)}/${(A.fourth?.a||0)}</td><td>${(A.epa||0).toFixed?.(2)||'0.00'}</td></tr></tbody></table>`;}

function renderLeaders(){
  function topBy(T, key){
    let best = null, bestVal = -Infinity;
    (T.players || []).forEach(p => {
      const v = +(p.adv?.[key] || 0);
      if (v > bestVal){ bestVal = v; best = p; }
    });
    return { p: best, v: Math.max(0, bestVal|0) };
  }
  function topPasser(T){
    // Prefer actual QBs, fallback to anyone with pass yards recorded
    const qbs = (T.players||[]).filter(p => p.pos === 'QB');
    let best = null, bestVal = -Infinity;
    (qbs.length ? qbs : (T.players||[])).forEach(p => {
      const v = +(p.adv?.yards || 0);
      if (v > bestVal){ bestVal = v; best = p; }
    });
    return { p: best, v: Math.max(0, bestVal|0), extra: best?.adv ? {
      c:best.adv.comp||0, a:best.adv.att||0, td:best.adv.td||0, ints:best.adv.int||0, sk:best.adv.sacks||0
    } : {} };
  }

  const Hpass = topPasser(HOME), Apass = topPasser(AWAY);
  const Hrush = topBy(HOME, 'ry'),   Arush = topBy(AWAY, 'ry');
  const Hrec  = topBy(HOME, 'recY'), Arec  = topBy(AWAY, 'recY');

  function linePass(teamName, X){
    if (!X.p) return `${teamName}: —`;
    const e = X.extra||{};
    return `${teamName}: ${X.p.first||''} ${X.p.last||''} — ${e.c||0}/${e.a||0}, ${X.v}y, TD ${e.td||0}, INT ${e.ints||0}, Sk ${e.sk||0}`;
  }
  function lineRush(teamName, X){
    if (!X.p) return `${teamName}: —`;
    const a = X.p.adv||{};
    return `${teamName}: ${X.p.first||''} ${X.p.last||''} — ${a.carries||0} rush, ${X.v}y, TD ${a.td||0}`;
  }
  function lineRec(teamName, X){
    if (!X.p) return `${teamName}: —`;
    const a = X.p.adv||{};
    return `${teamName}: ${X.p.first||''} ${X.p.last||''} — ${a.catches||0}/${a.targets||0}, ${X.v}y, TD ${a.td||0}`;
  }

  leaders.innerHTML = `
    <div class="small"><strong>Passing</strong></div>
    <div class="small">${linePass(homeLabel.value, Hpass)}</div>
    <div class="small">${linePass(awayLabel.value, Apass)}</div>
    <div class="small" style="margin-top:6px"><strong>Rushing</strong></div>
    <div class="small">${lineRush(homeLabel.value, Hrush)}</div>
    <div class="small">${lineRush(awayLabel.value, Arush)}</div>
    <div class="small" style="margin-top:6px"><strong>Receiving</strong></div>
    <div class="small">${lineRec(homeLabel.value, Hrec)}</div>
    <div class="small">${lineRec(awayLabel.value, Arec)}</div>
  `;
}


function renderTopEpa(){
  const el = document.getElementById('topEpa');
  if (!el) return;
  const items = epaPlays
    .slice()
    .sort((a,b)=> b.epa - a.epa)
    .slice(0,5);

  el.innerHTML = items.length
    ? items.map(p => `
        <div style="margin-bottom:6px">
          <span class="pill" style="margin-right:6px">PLAY</span>
          <span>${p.text}</span>
          <span class="small" style="display:block;color:#93a0b1">EPA ${(p.epa>=0?'+':'')}${(p.epa||0).toFixed(2)}</span>
        </div>`).join('')
    : '<span class="small" style="color:#93a0b1">— No plays yet —</span>';
}


function pushDriveStart(team,yard){
  const startEP = driveEPForState(
    { poss: team, down: 1, dist: 10, yard, qtr: (sim?.hud?.qtr||1), secs: (sim?.hud?.secs||900) },
    HOME, AWAY
  );

  drives.push({
    team,
    startY: yard,
    startEP,
    points: 0,
    driveEPA: 0,
    plays: 0,
    yards: 0,
    startQ: sim.hud.qtr,
    startT: sim.hud.secs,
    result: '',
    endY: null
  });
}

function closeDrive(result,endY){
  const d = drives.length ? drives[drives.length-1] : null;
  if(!d) return;
  d.result = result;
  d.endY   = endY;

  // elapsed time within drive
  d.time = d.startT - sim.hud.secs + (d.startQ!==sim.hud.qtr ? (15*60)*(sim.hud.qtr - d.startQ) : 0);

  // points credited to the offense on THIS drive (PAT excluded by design)
  const PTS = (result==='TD') ? 6 : (result==='FG' ? 3 : 0);
  d.points = PTS;

  // Drive EPA = points - StartEP
  d.driveEPA = +(PTS - (d.startEP||0)).toFixed(2);
}

function renderDrives(){
  feed.innerHTML = `<table class="table">
    <thead>
      <tr>
        <th>#</th><th>Team</th><th>Start</th><th>End</th>
        <th>Plays</th><th>Yards</th><th>Time</th><th>Result</th>
        <th>Start EP</th><th>Pts</th><th>Drive EPA</th>
      </tr>
    </thead>
    <tbody>
      ${drives.map((d,i)=>`
        <tr>
          <td>${i+1}</td>
          <td>${d.team}</td>
          <td>${yardText(d.startY)}</td>
          <td>${d.endY!==null?yardText(d.endY):'—'}</td>
          <td>${d.plays}</td>
          <td>${d.yards}</td>
          <td>${Math.floor((d.time||0)/60)}:${String((d.time||0)%60).padStart(2,'0')}</td>
          <td>${d.result||'—'}</td>
          <td>${(d.startEP??0).toFixed(2)}</td>
          <td>${d.points||0}</td>
          <td>${(d.driveEPA??0).toFixed(2)}</td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}


let activeTab='plays';
tabPlays.onclick=()=>{activeTab='plays';tabPlays.classList.add('active');[tabScoring,tabDrives,tabAdvanced].forEach(x=>x.classList.remove('active'));renderPlays();}
tabScoring.onclick=()=>{activeTab='scoring';tabScoring.classList.add('active');[tabPlays,tabDrives,tabAdvanced].forEach(x=>x.classList.remove('active'));feed.innerHTML='';scoring.forEach(s=>{const d=document.createElement('div');d.className='item score';d.innerHTML=`<div><span class="tag">SCORE</span>${s.text}</div><div class="aux">${s.score}</div>`;feed.appendChild(d);});}
tabDrives.onclick=()=>{activeTab='drives';tabDrives.classList.add('active');[tabPlays,tabScoring,tabAdvanced].forEach(x=>x.classList.remove('active'));renderDrives();}
tabAdvanced.onclick=()=>{activeTab='advanced';tabAdvanced.classList.add('active');[tabPlays,tabScoring,tabDrives].forEach(x=>x.classList.remove('active'));renderAdvanced();}


// === Stadium CSV loader (team_stadiums.csv in same folder as this HTML) ===
async function tryLoadStadiumCsv(){
    const tried = [];
    const withTimeout = (p, ms=2000) =>
      Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms))]);
  
    const urls = [];
    try { urls.push(new URL('team_stadiums.csv', location.href).href); }
    catch { urls.push('team_stadiums.csv'); }
  
    for (const url of urls){
      tried.push(url);
      try{
        const res = await withTimeout(fetch(url, { cache:'no-store', mode:'cors' }));
        if (!res.ok) { console.warn('[STADIUM] HTTP', res.status, url); continue; }
  
        const text = await res.text();
        const rows = parseCSV(text);       // header is first line in this file
        if (!rows.length){ console.warn('[STADIUM] empty parse', url); continue; }
  
        if (!('team' in rows[0]) && !('team_fastr' in rows[0])){
          console.warn('[STADIUM] missing "team" columns', Object.keys(rows[0]||{}));
          continue;
        }
  
        STADIUM_ROWS = rows;
        STADIUM_BY_ABBR = {};
  
        rows.forEach(r => {
          const a1 = String(r.team       || '').trim().toUpperCase();
          const a2 = String(r.team_fastr || '').trim().toUpperCase();
          if (a1) STADIUM_BY_ABBR[a1] = r;
          if (a2) STADIUM_BY_ABBR[a2] = r;
        });
  
        console.log('[STADIUM] loaded', Object.keys(STADIUM_BY_ABBR).length, 'teams');
        return true;
      }catch(e){
        console.warn('[STADIUM] failed', url, e.message || e);
      }
    }
    console.warn('[STADIUM] all sources failed. Tried:', tried);
    return false;
  }
  
  
  
  async function tryLoadPlayersCsv(forceLocal = true){
    const tried = [];
  
    // small per-URL timeout so a bad remote can't stall the sequence
    const withTimeout = (p, ms=2000) =>
      Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms))]);
  
    // ---- Build candidate URLs ----
    const tryUrls = [];
  
    // 1) LOCAL first (same folder as the HTML)
    try {
      tryUrls.push(new URL('players.csv', location.href).href);
      tryUrls.push(new URL('Players.csv', location.href).href);
    } catch { /* ignore */ }
  
    // 2) Optional URL param (?players=...) *after* local unless forceLocal === false
    if (!forceLocal && RAW_PLAYERS_PARAM) tryUrls.push(RAW_PLAYERS_PARAM);
  
    // 3) Optional GitHub fallback (only if you keep it enabled)
    if (!forceLocal && typeof CSV_USE_FALLBACK !== 'undefined' && CSV_USE_FALLBACK){
      tryUrls.push('https://raw.githubusercontent.com/aaronwolk00/game_sim/main/players.csv');
    }
  
    for (const url of tryUrls){
      tried.push(url);
      try{
        const res = await withTimeout(fetch(url, { cache:'no-store', mode:'cors' }));
        if (!res.ok) { console.warn('[CSV] HTTP', res.status, url); continue; }
  
        const text = await res.text();
        const rows = parseCSVSmart(text);
        if (!rows.length){ console.warn('[CSV] empty after parse', url); continue; }
        if (!('Team' in rows[0])){ console.warn('[CSV] missing "Team" col', Object.keys(rows[0]||{})); continue; }
  
        PLAYERS_CSV_ROWS = rows;
  
        const set = new Set();
        rows.forEach(r => { const t = String(r.Team||'').trim(); if (t) set.add(t); });
        TEAM_SHEETS = Array.from(set).sort();
  
        populateTeamsFromCsv();
        rosterStatus.textContent = `Loaded ${TEAM_SHEETS.length} teams from CSV`;
  
        // quick preview in the debug <pre> if present
        const out = document.getElementById('csvOut');
        if (out){
          out.textContent = `Teams found (${TEAM_SHEETS.length}):\n` + TEAM_SHEETS.join(', ');
          out.style.display = 'block';
        }
  
        // make available in console
        window.__CSV_ROWS = rows;
        window.__CSV_TEAMS = TEAM_SHEETS;
        return true;
      }catch(e){
        console.warn('[CSV] failed', url, e.message || e);
      }
    }
  
    rosterStatus.textContent = 'No players.csv found — using generated players.';
    console.warn('[CSV] all sources failed. Tried:', tried);
    return false;
  }
  
  
  
  /** Fill the dropdowns from TEAM_SHEETS (CSV teams) */
  function populateTeamsFromCsv(){
    const opts = TEAM_SHEETS.map(t => `<option value="${t}">${t}</option>`).join('');
    const keepHome = homeTeamSel.value;
    const keepAway = awayTeamSel.value;
  
    homeTeamSel.innerHTML = opts;
    awayTeamSel.innerHTML = opts;
  
    // Re-select previous choices if still available
    if (TEAM_SHEETS.includes(keepHome)) homeTeamSel.value = keepHome;
    if (TEAM_SHEETS.includes(keepAway)) awayTeamSel.value = keepAway;
  
    // If nothing selected, pick the first entry (if any)
    if (!homeTeamSel.value && TEAM_SHEETS.length) homeTeamSel.value = TEAM_SHEETS[0];
    if (!awayTeamSel.value && TEAM_SHEETS.length) {
      // choose a different team if possible
      awayTeamSel.value = TEAM_SHEETS.find(t => t !== homeTeamSel.value) || TEAM_SHEETS[0];
    }
  
    const disabled = TEAM_SHEETS.length === 0;
    homeTeamSel.disabled = disabled;
    awayTeamSel.disabled = disabled;
  }
  
  
  /** Map a CSV row → simulator rating object */
  function mapPlayersCsvRowToSim(r){
    const posRaw = String(r['Position']||'').toUpperCase().trim();
    const posMap = { HB:'RB', FB:'FB', RE:'DE', LE:'DE', SS:'S', FS:'S', LOLB:'OLB', ROLB:'OLB' };
    const pos = posMap[posRaw] || posRaw;
  
    const N = (x,d=70)=>Number.isFinite(+x)?+x:d;
    const avg = (...xs)=>Math.round(xs.reduce((a,b)=>a+N(b,0),0)/Math.max(1,xs.length));
  
    const first = r['First Name'] || '';
    const last  = r['Last Name']  || '';
  
    const Speed   = N(r['Speed']);           const Accel   = N(r['Acceleration']);
    const Agility = N(r['Agility']);         const Aware   = N(r['Awareness']);
    const Strength= N(r['Strength']);        const Catch   = N(r['Catching']);
    const Tackle  = N(r['Tackle']);          const PB      = N(r['Pass Block']);
    const PBP     = N(r['Pass Block Power']);const PBF     = N(r['Pass Block Finesse']);
    const RB      = N(r['Run Block']);       const RBP     = N(r['Run Block Power']);
    const RBF     = N(r['Run Block Finesse']);const Man    = N(r['Man Coverage']);
    const Zone    = N(r['Zone Coverage']);   const Press   = N(r['Press']);
    const PMoves  = N(r['Power Moves']);     const FMoves  = N(r['Finesse Moves']);
    const Shed    = N(r['Block Shedding']);  const TAS     = N(r['Throw Acc Short']);
    const TAM     = N(r['Throw Acc Mid']);   const TAD     = N(r['Throw Acc Deep']);
    const TUP     = N(r['Throw Under Pressure']);
    const TOR     = N(r['Throw On The Run']);const TPOW    = N(r['Throw Power']);
    const KPOW    = N(r['Kick Power']);      const KACC    = N(r['Kick Accuracy']);
    const Tough   = N(r['Toughness']);       const PR      = N(r['Play Recognition']);
  
    if (!(first||last) || !pos) return null;
  
    const PASS_ACC = (pos==='QB') ? avg(TAS,TAM,TAD,TUP,TOR) : 50;
    const PASS_PWR = (pos==='QB') ? TPOW : 50;
    const HANDS    = (pos==='WR'||pos==='TE'||pos==='RB') ? Catch : 50;
    const BLOCK    = (pos==='LT'||pos==='LG'||pos==='C'||pos==='RG'||pos==='RT'||pos==='OL')
                      ? avg(PB,PBP,PBF,RB,RBP,RBF) : avg(RB,PB);
    const COVER    = (pos==='CB'||pos==='S'||pos==='DB') ? avg(Man,Zone,Press) : avg(Man,Zone);
    const TEC      = avg(PB,RB,PMoves,FMoves,Shed,Press);
    const DISC     = avg(Tough,Aware,PR);
  
    return {
      "First Name":first, "Last Name":last, "Position":pos,
      OVR: N(r['Overall']),
      SPD:Speed, STR:Strength, AGI:Agility, INT:Aware, TEC,
      HANDS, TACK:Tackle, BLOCK, COVER, PASS_ACC, PASS_PWR,
      KICK_POW:KPOW, KICK_ACC:KACC, DISC
    };
  }
  
  /** Build a team from CSV by team name */
  function teamFromCsv(teamName){
    if (!PLAYERS_CSV_ROWS) return null;
    const rows = PLAYERS_CSV_ROWS
      .filter(r => String(r[TEAM_COL] || '').trim() === teamName)
      .map(mapPlayersCsvRowToSim)
      .filter(Boolean);
    if (!rows.length) return null;
    return buildTeam(rows);
  }
  
  /* ===== Team name helpers (for URL + label → dropdown) ===== */
  const normalizeTeam = (s) => String(s || '').toLowerCase().trim();
  
  function fuzzyFindTeam(name){
    if (!name || !TEAM_SHEETS.length) return null;
    const target = normalizeTeam(name);
  
    // Exact match first
    const exact = TEAM_SHEETS.find(t => normalizeTeam(t) === target);
    if (exact) return exact;
  
    // Then fuzzy “contains” match
    return TEAM_SHEETS.find(t => {
      const tNorm = normalizeTeam(t);
      return tNorm.includes(target) || target.includes(tNorm);
    }) || null;
  }
  
  
  
  /* ===== Kickoffs & PAT ===== */
  function beginKickoff(kicking, opts={}){
    // opts: { onside?: boolean }
    pendingKickoff = { kicking, onside: !!opts.onside };
  }
  
  function shouldOnsideNow(kicking){
    // Kicking team is usually the team that just scored.
    // Attempt if still trailing by ≥8 late, or ≥17 in 4Q, or under ~2:30 down ≥1 score.
    const s = sim.score, h = sim.hud;
    const kIsHome = (kicking === 'Home');
    const diff = (kIsHome ? (s.home - s.away) : (s.away - s.home));  // positive if kicking team leads
    const tLeft = (5 - h.qtr) * 900 + h.secs;
  
    const stillTrailing = diff < 0;
    if (!stillTrailing) return false;
  
    const deficit = -diff;
    if (tLeft <= 600 && deficit >= 17) return true;
    if (tLeft <= 120 && deficit >= 1) return true;
    if (tLeft <= 300 && deficit >= 9) return true;
  
    return false;
  }
  
  function onsideSuccessProb(){
    // Rough modern rates: 6–8% “expected”; 12–18% when truly telegraphed/late.
    return clamp(0.12 + 0.04 * Math.random(), 0.08, 0.18);
  }
  
  function doKickoff(){
    if(!pendingKickoff) return;
  
    const { kicking, onside: wantOnside } = pendingKickoff;
    const teamK = (kicking === 'Home' ? HOME : AWAY);
    const teamR = (kicking === 'Home' ? AWAY : HOME);
    const r = sim.rng;
    const k = teamK.k || { first:'K', last:'', KICK_POW:70, KICK_ACC:70 };
  
    let startY = 25, line = '', driveEPStart = 0;
  
    // Decide onside at runtime if not explicitly requested
    const onside = (wantOnside === true) || shouldOnsideNow(kicking);
  
    if (onside){
      // Simple onside mechanics
      const pRec = onsideSuccessProb();
      const recoveredByKicking = (Math.random() < pRec);
  
      if (recoveredByKicking){
        // Kicking team keeps it around midfield
        sim.hud.poss = kicking;
        sim.hud.down = 1; sim.hud.dist = 10; sim.hud.yard = 50 + Math.floor(4*sim.rng()); // ~50–54
        line = `${k.first} ${k.last} onside kick — RECOVERED by ${kicking} at ${yardText(sim.hud.yard)}`;
        driveEPStart = driveEPForState(
          { poss: sim.hud.poss, down:1, dist:10, yard: sim.hud.yard, qtr: sim.hud.qtr, secs: sim.hud.secs },
          HOME, AWAY
        );
        logPlay('KICKOFF', line, kicking, false, 0, 0, driveEPStart);
        pushDriveStart(sim.hud.poss, sim.hud.yard);
      } else {
        // Receiving team takes over around their 45–49
        sim.hud.poss = (kicking === 'Home' ? 'Away' : 'Home');
        sim.hud.down = 1; sim.hud.dist = 10; sim.hud.yard = 45 + Math.floor(5*sim.rng()); // 45–49
        line = `${k.first} ${k.last} onside kick — recovered by ${sim.hud.poss} at ${yardText(sim.hud.yard)}`;
        driveEPStart = driveEPForState(
          { poss: sim.hud.poss, down:1, dist:10, yard: sim.hud.yard, qtr: sim.hud.qtr, secs: sim.hud.secs },
          HOME, AWAY
        );
        logPlay('KICKOFF', line, kicking, false, 0, 0, driveEPStart);
        pushDriveStart(sim.hud.poss, sim.hud.yard);
      }
    } else {
      // Normal deep kick
      const gross = clamp(Math.round(60 + (k.KICK_POW-70)/2 + randNorm(r,0,5) - (+wind.value/5)), 50, 75);
      const touch = gross >= 65 || precip.value==='Heavy Rain' || precip.value==='Snow';
  
      if (touch){
        startY = 25;
        line = `${k.first} ${k.last} kicks ${gross} — touchback`;
      } else {
        const returner = (teamR.wr[0] || teamR.rb[0] || teamR.players[0]);
        const speedBoost = ((returner?.SPD||70) - 70)/6;
        const ret = clamp(Math.round(randNorm(r,24+speedBoost,6)), 10, 45);
        startY = ret;
        line = `${k.first} ${k.last} kicks ${gross} — ${returner.first} ${returner.last} returns to ${yardText(startY)}`;
      }
  
      // Receiving team starts a new drive
      sim.hud.poss = (kicking === 'Home' ? 'Away' : 'Home');
      sim.hud.down = 1; sim.hud.dist = 10; sim.hud.yard = startY;
  
      driveEPStart = driveEPForState(
        { poss: sim.hud.poss, down:1, dist:10, yard:startY, qtr: sim.hud.qtr, secs: sim.hud.secs },
        HOME, AWAY
      );
      logPlay('KICKOFF', line, kicking, false, 0, 0, driveEPStart);
      pushDriveStart(sim.hud.poss, sim.hud.yard);
    }
  
    pendingKickoff = null;
  }
  
  
  function decidePAT({ team } = {}){
    const h = sim.hud, s = sim.score;
    const forHome   = (team === 'Home');
    const us        = forHome ? s.home : s.away;   // score AFTER TD has been added
    const them      = forHome ? s.away : s.home;
    const leadAfter = us - them;                   // margin after TD, before try
    const tLeft     = (5 - h.qtr) * 900 + h.secs;
  
    // Default: kick
    let goForTwo = false;
  
    // Strong go-for-2 spots from charts
    if (leadAfter === -2) goForTwo = true;                 // tie game
    else if (leadAfter === -1) goForTwo = (tLeft <= 600);  // to take lead late
    else if (leadAfter ===  1) goForTwo = (tLeft <= 120);  // go up 3 very late
    else if (leadAfter ===  2) goForTwo = (tLeft <= 300);  // go up 4 late
  
    // One-score scramble in final 2:30 → lean 2
    if (!goForTwo && tLeft <= 150 && Math.abs(leadAfter) === 1) goForTwo = true;
  
    // Rare early-game aggressiveness if trailing (coach vibe)
    if (!goForTwo && tLeft > 600 && leadAfter < 0 && Math.random() < 0.015) goForTwo = true;
  
    return goForTwo ? 'two' : 'xp';
  }
  
  let preSnapStreak = 0;
  
  /* ===== Penalties ===== */
  function chancePenalty(ctx = {}){
    // Phase gating: pre-snap pass in the loop uses isPass:false BEFORE the play,
    // live-ball checks use isPass:true AFTER the snap (in pass logic).
    const isPre  = ctx.isPass === false;
    const isLive = ctx.isPass === true;
  
    const refsSlider  = (+feelRefs.value)/100;
    const crowdSlider = (+feelCrowd.value)/100;
    const varK        = (+feelVariance.value)/100;
  
    // Real stadium-driven loudness (0–1), if crowdVolume() is wired in
    let envNoise = 0.5;
    if (typeof crowdVolume === 'function'){
      envNoise = crowdVolume();           // 0–1 based on CURRENT_STADIUM + sim.crowd
    }
  
    // Blend slider with environment so both still matter
    const crowdFactor = clamp(0.5 * crowdSlider + 0.5 * envNoise, 0, 1);
  
    const down    = ctx.down|0;
    const isLong  = (ctx.dist||10) >= 8;
    const offenseIsAway = !!(sim && sim.hud && sim.hud.poss === 'Away');
  
    // --- Total penalty per snap (NFL-ish scale ~3–9%) ---
    const situ    = (down>=3? 0.012 : 0) + (isLong? 0.008 : 0);
    const pBase   = clamp(0.035 + 0.02*refsSlider + 0.005*varK, 0.015, 0.09);
    let   pTotal  = clamp(pBase + situ, 0.015, 0.11);
  
    // Slight extra juice on high-leverage downs with a loud house vs road offense
    if (isLive && offenseIsAway && down >= 3){
      pTotal = clamp(pTotal + crowdFactor * 0.015, 0.015, 0.13);
    }
  
    // If we’re only deciding *pre-snap*, don’t do a second roll for live-ball later.
    if (isPre){
      // Pre-snap share, with small “jitter” memory for realistic clusters
      let wPre = 0.40
               + 0.20*crowdFactor     // louder building → more flags pre-snap
               + 0.10*refsSlider
               + (down>=3?0.05:0);    // 3rd/4th-down nerves
  
      // Extra pre-snap chaos when the AWAY offense has the ball
      if (offenseIsAway){
        wPre += 0.08 * crowdFactor;
      }
  
      wPre = clamp(wPre * (1 + 0.5*preSnapStreak), 0.25, 0.90);
  
      if (Math.random() < pTotal * wPre){
        // we got a pre-snap flag; increase jitter a bit
        preSnapStreak = Math.min(1, preSnapStreak + 0.35);
  
        // Offense vs defense split (crowd + refs tilt toward false starts on noisy road snaps)
        let defSkew = 0.40 + 0.15*refsSlider - 0.10*crowdFactor; // base: ~25–55% on defense
  
        // If the offense is the AWAY team in a loud place, push flags toward the offense
        if (offenseIsAway){
          defSkew -= 0.12 * crowdFactor; // fewer defensive offsides, more false starts
        }
  
        const onDefense = Math.random() < clamp(defSkew, 0.20, 0.60);
  
        return onDefense
          ? { type:'Offside',     yards:+5, onDefense:true,  preSnap:true }
          : { type:'False start', yards:-5, onDefense:false, preSnap:true };
      } else {
        // no pre-snap this time; decay the jitter
        preSnapStreak = Math.max(0, preSnapStreak - 0.20);
        return null;
      }
    }
  
    // Live-ball only (in-play), no pre-snap output here.
    if (isLive){
      if (Math.random() >= pTotal) return null;
  
      if (ctx.isPass){
        // proportions sum to <=1; leftover → no flag
        const roll = Math.random();
        const pDH  = 0.25; // defensive holding
        const pDPI = 0.38; // DPI (spot)
        const pRTP = 0.10; // roughing passer
  
        if (roll < pDH){
          return { type:'Defensive holding', yards:+5,  onDefense:true,  autoFirst:true };
        }
        if (roll < pDH+pDPI){
          const yards = clamp(
            Math.round(randNorm(sim.rng, 12 + (ctx.airDepth||0)*0.6, 6)),
            8, 35
          );
          return { type:'DPI', yards, onDefense:true, spot:true, autoFirst:true };
        }
        if (roll < pDH+pDPI+pRTP){
          return { type:'Roughing the passer', yards:+15, onDefense:true, autoFirst:true };
        }
        if (Math.random() < 0.20){
          return { type:'Offensive holding', yards:-10, onDefense:false };
        }
        return null;
      } else {
        const roll = Math.random();
        if (roll < 0.45) return { type:'Offensive holding', yards:-10, onDefense:false };
        if (roll < 0.55) return { type:'Facemask', yards:+15, onDefense:true,  autoFirst:true };
        return null;
      }
    }
  
    // If phase not specified, be safe.
    return null;
  }
  
  
  function applyPenalty(p){
    const h = sim.hud;
  
    // Snapshot BEFORE
    const before = { qtr:h.qtr, secs:h.secs, down:h.down, dist:Math.max(1,Math.round(h.dist)), yard:h.yard, poss:h.poss };
    const epBefore = driveEPForState(before, HOME, AWAY);
    const wpBefore = stateWP(sim.score.home, sim.score.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
  
    // Count penalty
    const offenseTeam = (h.poss === 'Home' ? HOME : AWAY).stats.team;
    const defenseTeam = (h.poss === 'Home' ? AWAY : HOME).stats.team;
    (p.onDefense ? defenseTeam : offenseTeam).pen++;
  
    // ---------- Enforce ----------
    if (p.preSnap){
      if (p.onDefense){
        h.yard = clamp(h.yard + 5, 0, 99);
        h.dist = Math.max(0, h.dist - 5);
        if (h.dist <= 0){ h.down = 1; h.dist = Math.min(10, 100 - h.yard); }
      } else {
        const prevDist = h.dist;
        h.yard = Math.max(0, h.yard - 5);
        h.dist = prevDist + 5;
      }
    } else {
      if (p.onDefense){
        if (p.spot){
          const toGL = Math.min(100 - h.yard, p.yards);
          h.yard = Math.min(99, h.yard + toGL);
          h.down = 1; h.dist = Math.min(10, 100 - h.yard);
        } else {
          h.yard = Math.min(99, h.yard + Math.abs(p.yards));
          if (p.autoFirst){ h.down = 1; h.dist = Math.min(10, 100 - h.yard); }
          else { h.dist = Math.max(1, h.dist - Math.abs(p.yards)); }
        }
      } else {
        // Offensive penalty from previous spot; special-case holding HTD
        let applied = Math.abs(p.yards);
        if (p.type === 'Offensive holding'){
          const prev = h.yard;
          applied = (prev < 20) ? Math.floor(prev/2) : 10;
          h.yard = Math.max(0, prev - applied);
          h.dist += applied;
          p._applied = applied;
        } else {
          h.yard = Math.max(0, h.yard - Math.abs(p.yards));
          h.dist += Math.abs(p.yards);
        }
      }
    }
  
    // ---------- After-state & deltas ----------
    const after = { qtr:h.qtr, secs:h.secs, down:h.down, dist:Math.max(1,Math.round(h.dist)), yard:h.yard, poss:h.poss };
    const epAfter  = driveEPForState(after, HOME, AWAY);
    const wpAfter  = stateWP(sim.score.home, sim.score.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
    const epaPenalty = +(epAfter - epBefore).toFixed(2);
    const wpdPenalty = clamp(wpAfter - wpBefore, -wpCap(h.qtr, h.secs), wpCap(h.qtr, h.secs));
  
    // Text (show replay vs 1st)
    const firstNow = (h.down===1 && h.dist<=10);
    const txt = p.preSnap
      ? `${p.type} — ${p.onDefense?'+':'-'}5 ${firstNow ? '(1st down)' : '(replay down)'}`
      : `${p.type} — ${p.onDefense?'+':'-'}${(p._applied ?? Math.abs(p.yards))}${p.autoFirst?' (1st down)':' (replay down)'}`;
  
    // Log with DriveEP_before so add-up holds
    logPlay('PEN', txt, h.poss, false, epaPenalty, wpdPenalty, epBefore);
    return true;
  }
  
  
  /* ===== Start / Pause / Reset ===== */
  function seedRoster(seed){const r=rngFromSeed(seed),
      F=["James","Michael","David","John","Robert","Chris","Daniel","Joseph","William","Ryan","Ethan","Noah","Logan","Lucas","Owen","Mason","Liam","Aiden","Kai","Leo","Benjamin","Samuel","Nathan","Zachary","Aaron","Adrian","Caleb","Henry","Carter","Julian","Isaac","Nathaniel","Christian","Hunter","Jeremiah","Thomas","Andrew","Oliver","Gabriel","Eli"],
      L=["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Lee","Walker","Hall","Young","Allen","King","Wright","Scott","Green","Baker","Adams","Nelson","Carter","Mitchell","Perez","Roberts","Turner","Phillips","Campbell","Parker","Evans","Edwards","Collins","Stewart","Sanchez","Morris","Rogers","Reed","Cook","Morgan"];
      const name=()=>({first:F[Math.floor(r()*F.length)],last:L[Math.floor(r()*L.length)]});function mk(pos,b){const {first,last}=name();const z=d=>clamp(Math.round(60+d+randNorm(r,0,8)),40,99);return {"First Name":first,"Last Name":last,"Position":pos,SPD:z(b.spd),STR:z(b.str),AGI:z(b.agi),INT:z(b.int),TEC:z(b.tec),HANDS:z(b.hnd),TACK:z(b.tck),BLOCK:z(b.blk),COVER:z(b.cov),PASS_ACC:z(b.pac),PASS_PWR:z(b.ppw),KICK_POW:z(b.kpw),KICK_ACC:z(b.kac),DISC:clamp(Math.round(65+randNorm(r,0,12)),30,99)};}const B={QB:{spd:-5,str:0,agi:0,int:10,tec:8,hnd:0,tck:-10,blk:-10,cov:-10,pac:18,ppw:12,kpw:-20,kac:-20},RB:{spd:12,str:0,agi:12,int:0,tec:4,hnd:8,tck:-10,blk:-4,cov:-10,pac:-10,ppw:-10,kpw:-20,kac:-20},WR:{spd:16,str:-6,agi:14,int:0,tec:8,hnd:12,tck:-10,blk:-6,cov:-10,pac:-12,ppw:-12,kpw:-20,kac:-20},TE:{spd:2,str:6,agi:0,int:0,tec:4,hnd:8,tck:-6,blk:6,cov:-10,pac:-12,ppw:-12,kpw:-20,kac:-20},OL:{spd:-18,str:18,agi:-8,int:0,tec:10,hnd:-10,tck:-6,blk:16,cov:-10,pac:-20,ppw:-20,kpw:-20,kac:-20},DL:{spd:0,str:14,agi:0,int:0,tec:8,hnd:-6,tck:12,blk:0,cov:-6,pac:-20,ppw:-20,kpw:-20,kac:-20},LB:{spd:4,str:6,agi:2,int:2,tec:6,hnd:-6,tck:12,blk:0,cov:2,pac:-20,ppw:-20,kpw:-20,kac:-20},DB:{spd:12,str:-6,agi:10,int:2,tec:2,hnd:2,tck:2,blk:-8,cov:12,pac:-20,ppw:-20,kpw:-20,kac:-20},K:{spd:-8,str:-8,agi:-8,int:0,tec:0,hnd:0,tck:-10,blk:-10,cov:-10,pac:-20,ppw:-20,kpw:18,kac:18},P:{spd:-8,str:-8,agi:-8,int:0,tec:0,hnd:0,tck:-10,cov:-10,pac:-20,ppw:-20,kpw:18,kac:6}};const plan=[['QB',3],['RB',4],['WR',7],['TE',3],['OL',9],['DL',8],['LB',7],['DB',10],['K',1],['P',1]];const rows=[];plan.forEach(([p,c])=>{for(let i=0;i<c;i++)rows.push(mk(p,B[p]));});return rows;}
  
  function startGame(){
    running=true; paused=false; pauseBtn.disabled=false; exportCsv.disabled=false;
    plays=[]; scoring=[]; drives=[]; pendingPAT=null; pendingKickoff=null; pendingScoreIdx=-1;
    timeouts={Home:3,Away:3}; toHome.textContent=3; toAway.textContent=3;
  
    twoMinUsed = { H1:false, H2:false };
    lastTimeoutCalledAt = { Home: 9999, Away: 9999 };
  
    // if no picks yet, pick two distinct CSV teams
    if ((!homeTeamSel.value || !awayTeamSel.value) && TEAM_SHEETS.length >= 2){
      const i = Math.floor(Math.random()*TEAM_SHEETS.length);
      let j = Math.floor(Math.random()*TEAM_SHEETS.length);
      if (i===j) j = (i+1) % TEAM_SHEETS.length;
      homeTeamSel.value = TEAM_SHEETS[i];
      awayTeamSel.value = TEAM_SHEETS[j];
    }
  
    HOME = null; AWAY = null;
  
    // If labels were typed but dropdowns are empty, sync dropdowns from labels
    if (TEAM_SHEETS.length){
      if (!homeTeamSel.value && homeLabel.value){
        const t = fuzzyFindTeam(homeLabel.value);
        if (t) homeTeamSel.value = t;
      }
      if (!awayTeamSel.value && awayLabel.value){
        const t = fuzzyFindTeam(awayLabel.value);
        if (t) awayTeamSel.value = t;
      }
    }
  
  
    if (TEAM_SHEETS.length){
      if (homeTeamSel.value) {
        HOME = teamFromCsv(homeTeamSel.value) || HOME;
        homeLabel.value = homeTeamSel.value; homeName.textContent = homeLabel.value;
      }
      if (awayTeamSel.value) {
        AWAY = teamFromCsv(awayTeamSel.value) || AWAY;
        awayLabel.value = awayTeamSel.value; awayName.textContent = awayLabel.value;
      }
    }
  
    // final fallback: generated rosters
    if(!HOME) HOME = buildTeam(seedRoster((seed.value||'seed')+'-H'));
    if(!AWAY) AWAY = buildTeam(seedRoster((seed.value||'seed')+'-A'));
  
    HOME.stats.team={plays:0,yards:0,passYds:0,rushYds:0,punts:0,fgm:0,fga:0,td:0,ints:0,downs:0,pen:0,third:{c:0,a:0},fourth:{c:0,a:0},epa:0}; HOME.drives=[];
    AWAY.stats.team={plays:0,yards:0,passYds:0,rushYds:0,punts:0,fgm:0,fga:0,td:0,ints:0,downs:0,pen:0,third:{c:0,a:0},fourth:{c:0,a:0},epa:0}; AWAY.drives=[];
    renderBox(); renderLeaders(); renderTopEpa();
  
    const r = rngFromSeed(seed.value||'seed');
    const receive = r()<0.5 ? 'Home' : 'Away';
    
  
  
    // Basic sim; crowd/env will be overwritten by stadium data if available
    sim = {
      rng: r,
      score: { home:0, away:0 },
      hud:   { poss:receive, qtr:1, secs:900, down:1, dist:10, yard:25 },
      crowd: { cap:72000, present:Math.floor(0.85*72000), mood:0 }
    };
  
    // Stadium → capacity, weather, crowd, CURRENT_STADIUM
    applyStadiumFromTeams();
  
    sim.initReceive = receive;
    sim.kickAtHalf  = (receive === 'Home') ? 'Away' : 'Home';
  
  
  
    wpSeries = [0.5];
    wpSmooth = 0.5;
    wpPrior  = priorWithStadium(HOME, AWAY);
  
    fansPill.textContent = `Fans: ${sim.crowd.present.toLocaleString()}`;
  
  
    beginKickoff(receive==='Home'?'Away':'Home'); doKickoff();
    updateHUD(); updateScore(); drawWP(); renderPlays(); Field.render({hud:sim.hud});
    loop(+speed.value||0);
  }
  
  
  function pauseToggle(){if(!running)return;paused=!paused;pauseBtn.textContent=paused?'Resume':'Pause';if(!paused)loop(+speed.value||0);}
  function hardReset(){
    // stop sim & UI buttons
    running = false;
    paused  = false;
    pauseBtn.disabled = true;
    pauseBtn.textContent = 'Pause';
    exportCsv.disabled = true;
  
    // clear logs/state
    plays = [];
    scoring = [];
    drives = [];
    pendingPAT = null;
    pendingKickoff = null;
    pendingScoreIdx = -1;
  
    // reset timeouts & update UI
    timeouts = { Home: 3, Away: 3 };
    if (toHome) toHome.textContent = 3;
    if (toAway) toAway.textContent = 3;
  
    // reset WP series
    wpSeries = [0.5];
    wpSmooth = 0.5;
  
    // Top-EPA list clear
    epaPlays = [];
  
    // keep rosters as-is; rebuild team aggregates & clear player event stats
    if (HOME){
      HOME.stats.team = { plays:0, yards:0, passYds:0, rushYds:0, punts:0, fgm:0, fga:0, td:0, ints:0, downs:0, pen:0,
                          third:{c:0,a:0}, fourth:{c:0,a:0}, epa:0 };
      HOME.drives = [];
      HOME.players.forEach(p => p.adv = {});
    }
    if (AWAY){
      AWAY.stats.team = { plays:0, yards:0, passYds:0, rushYds:0, punts:0, fgm:0, fga:0, td:0, ints:0, downs:0, pen:0,
                          third:{c:0,a:0}, fourth:{c:0,a:0}, epa:0 };
      AWAY.drives = [];
      AWAY.players.forEach(p => p.adv = {});
    }
  
    // rebuild sim HUD at game start (no kickoff pending)
    const resetSeed = seed.value || 'seed';
    sim = {
      rng: rngFromSeed(resetSeed),
      score: { home:0, away:0 },
      hud:   { poss:'Home', qtr:1, secs:900, down:1, dist:10, yard:25 },
      // crowd will be set based on CURRENT_STADIUM below
      crowd: { cap:0, present:0, mood:0 }
    };
  
    // Re-apply stadium environment & prior using the real venue
    applyStadiumFromTeams();
    if (HOME && AWAY){
      wpPrior = priorWithStadium(HOME, AWAY);
    } else {
      wpPrior = 0.50;
    }
  
  
    // UI refresh
    feed.innerHTML = '';
    lastPlay.textContent = 'Last Play: —';
    updateHUD();
    updateScore();
    drawWP();
    renderBox();
    renderLeaders();
    renderTopEpa();
    Field.render({ hud: sim.hud });
  }
  
  
  startBtn.addEventListener('click',()=>{if(running)return;homeName.textContent=homeLabel.value||'Home';awayName.textContent=awayLabel.value||'Away';startGame();});
  
  /* ===== Headless simulation export (used by schedule.html) ===== */
window.runGameHeadless = async function(homeTeamName, awayTeamName, playersUrl = 'players.csv'){
    try{
      // Prepare teams from CSV
      if (!PLAYERS_CSV_ROWS) await tryLoadPlayersCsv(true);
      const home = teamFromCsv(homeTeamName) || buildTeam(seedRoster(homeTeamName + '-H'));
      const away = teamFromCsv(awayTeamName) || buildTeam(seedRoster(awayTeamName + '-A'));
  
      // Initialize minimal sim state (no UI)
      const r = rngFromSeed(homeTeamName + awayTeamName + Date.now());
      const simSilent = {
        rng: r,
        score: { home:0, away:0 },
        hud:   { poss: (r()<0.5?'Home':'Away'), qtr:1, secs:900, down:1, dist:10, yard:25 },
        crowd: { cap:72000, present:60000, mood:0 }
      };
  
      // Run a quick game by stepping the same play loop until final whistle
      // We reuse your loop logic but without any drawing or UI
      const speed = 0; // instant ticks
      HOME = home;
      AWAY = away;
      sim = simSilent;
      running = true; paused = false;
  
      // Use same kickoff and logic as startGame()
      beginKickoff(sim.hud.poss==='Home'?'Away':'Home');
      doKickoff();
  
      // Run the main simulation loop headlessly until final
      // We borrow your async loop but without the DOM animation delay.
      const maxTicks = 6000; // failsafe
      let ticks = 0;
      while (running && ticks < maxTicks){
        await new Promise(rs=>setTimeout(rs, 0));
        if (sim.hud.qtr > 4) break;
        ticks++;
        // advance one cycle of your engine’s tick logic manually
        // (simplified: let loop() handle normal progress)
        if (typeof loop === 'function') loop(0);
        if (!running) break;
      }
  
      const result = { homePts: sim.score.home, awayPts: sim.score.away };
      running = false;
      return result;
    }catch(err){
      console.error('[runGameHeadless] failed:', err);
      return { homePts: 0, awayPts: 0 };
    }
  };
  
  
  
  pauseBtn.addEventListener('click',pauseToggle);
  resetBtn.addEventListener('click',hardReset);
  document.addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();pauseToggle();}});
  
  ['change','input'].forEach(evt => {
    homeTeamSel.addEventListener(evt, () => applyStadiumFromTeams());
    awayTeamSel.addEventListener(evt, () => applyStadiumFromTeams());
    homeLabel.addEventListener(evt,   () => applyStadiumFromTeams());
    awayLabel.addEventListener(evt,   () => applyStadiumFromTeams());
  });
  
  /* ===== Helpers ===== */
  
  function handleQuarterEnd() {
    const h = sim.hud, s = sim.score;
    if (h.secs > 0) return;
  
    h.qtr++;
    if (h.qtr <= 4) {
      h.secs = 900;
      // Only at halftime do we kickoff to start Q3
      if (h.qtr === 3) beginKickoff(sim.kickAtHalf);
    } else {
      running = false;
      pauseBtn.disabled = true;
      logPlay('FINAL', `FINAL: ${homeLabel.value} ${s.home} – ${awayLabel.value} ${s.away}`, 'Home', true, 0, 0);
    }
  }
  
  
  // === Clock helpers ===
  function clockDrainFor(outcome, pace){
    // outcome: 'run' | 'comp' | 'incomp' | 'sack' | 'st'
    const p = clamp((pace-0.5), -0.5, 0.5); // -0.5..0.5
    switch(outcome){
      case 'run':    return clamp(Math.round(32 - 6*p), 24, 40);
      case 'comp':   return clamp(Math.round(27 - 5*p), 20, 35);
      case 'incomp': return clamp(Math.round(7  - 4*p),  4, 12);
      case 'sack':   return clamp(Math.round(18 - 3*p), 12, 25);
      case 'st':     return clamp(Math.round(18 - 2*p), 12, 24); // special teams
      default:       return 24;
    }
  }
  
  // Decide if the last play kept the clock running and what kind of runoff to use
  function classifyClockContext(playText, kind, scored){
    // scored → stoppage
    if (scored) return { inBounds:false, outcome:'st' };
  
    const txt = String(playText || '').toLowerCase();
  
    if (kind === 'pass'){
      if (txt.includes('sacked'))  return { inBounds:true,  outcome:'sack' };
      if (txt.includes('incomplete')) return { inBounds:false, outcome:'incomp' };
      // NOTE: if you ever add explicit "out of bounds" text, set inBounds=false there.
      return { inBounds:true, outcome:'comp' };
    }
  
    if (kind === 'rush'){
      // If you ever tag OOB rushes in playText, switch inBounds to false.
      return { inBounds:true, outcome:'run' };
    }
  
    // Fallback
    return { inBounds:true, outcome:'run' };
  }
  
  
  
  function setFirstDownOrAdvance(yds){const h=sim.hud;if(yds>=0)h.dist-=yds;else h.dist+=(-yds);if(h.dist<=0){h.down=1;h.dist=Math.min(10,100-h.yard);}else{h.down++;}}
  function kickerLeg(pow){return 45+0.7*(pow-70);}
  function fgMakeProb(dist, pow, acc){
    dist = Math.min(dist, 68);
    let z = (kickerLeg(pow)-dist)/4 + (acc-70)/18;
    z -= (+wind.value/20)*0.4;
    if (+temp.value<25) z -= 0.3;
    if (precip.value==='Heavy Rain' || precip.value==='Snow') z -= 0.1;
  
    let p = 1/(1+Math.exp(-z));
  
    // Cap only true long kicks; don't suppress 30–40 yarders
    const cap = dist>=60 ? 0.20 : dist>=55 ? 0.55 : dist>=50 ? 0.70 : 1.00;
    if (dist>=50) p = Math.min(p, cap + 0.08*(acc-70)/30);
  
    return clamp(p, 0.02, 0.995);
  }
  
  // Yardline you need to reach to have ≥ pTarget make prob (defaults ~60%)
  function fgTargetYardForProb(team, pTarget = 0.60){
    const k = team?.k || { KICK_POW:70, KICK_ACC:70 };
    let yardReq = 99; // worst case
    for (let dist = 30; dist <= 65; dist++){
      const p = fgMakeProb(dist, k.KICK_POW, k.KICK_ACC);
      if (p >= pTarget){
        const y = clamp(100 - (dist - 17), 1, 99); // dist = (100 - y) + 17
        yardReq = Math.min(yardReq, y);
      }
    }
    return yardReq;
  }
  
  // Returns +1 if HOME offense (trailing) can drain & kick last,
  // -1 if AWAY offense (trailing) can do so, 0 otherwise.
  function clockKillLeverage(){
    const h = sim.hud, s = sim.score;
    const tLeft = (5 - h.qtr) * 900 + h.secs;
    if (tLeft > 240) return 0;                       // only care inside 4:00
  
    const lead = s.home - s.away;                    // + if Home leads
    const trailingSide = lead > 0 ? 'Away' : (lead < 0 ? 'Home' : null);
    if (!trailingSide) return 0;
  
    // Must be the trailing team on offense and within FG deficit (≤ 2 pts)
    if (h.poss !== trailingSide || Math.abs(lead) > 2) return 0;
  
    const offense   = (h.poss === 'Home') ? HOME : AWAY;
    const defenseTO = timeouts[(h.poss === 'Home') ? 'Away' : 'Home'] || 0;
  
    // Field-goal “target line” for ~60% make in current weather/wind
    const needY = fgTargetYardForProb(offense, 0.60);
    const yardsToTarget = Math.max(0, needY - h.yard);
  
    // How many safe run plays until kick (rough): if 1st/2nd → ~3 plays, else ~2
    const playsToKick = (h.down <= 2 ? 3 : 2);
  
    // Realistic drain per run including setup/runoff (decreased by TOs)
    const burn = playsToKick * 36 - defenseTO * 18;  // ~36s each; TO ≈ 18s swing
  
    const canMilk  = (burn >= tLeft - 8);            // can kick with <8s remaining
    const canReach = (h.yard >= needY) || (yardsToTarget <= (h.down <= 2 ? 12 : 6));
  
    if (canMilk && canReach){
      return (h.poss === 'Home') ? +1 : -1;
    }
    return 0;
  }
  
  
  function fgEPA(FGdist,epBefore,yard){const k=(sim.hud.poss==='Home'?HOME:AWAY).k||{KICK_POW:70,KICK_ACC:70};const p=fgMakeProb(FGdist,k.KICK_POW,k.KICK_ACC);const epAfterMiss=-EP(1,10,clamp(100-yard,1,99));return 3*p+epAfterMiss*(1-p)-epBefore;}
  function pickDefender(def,role){const pool= role==='sack'?(def.dl.concat(def.lb)) : role==='int'?def.db.concat(def.lb): role==='tacklePass'?def.db.concat(def.lb): def.dl.concat(def.lb); return pool[Math.floor(sim.rng()*pool.length)]||{first:'Def',last:'ender',adv:{}};}
  
  // ---- Play snapshot & header helpers ----
  function snapshotHUD(){
    const h = sim.hud;
    return {
      qtr: h.qtr,
      secs: h.secs,
      down: h.down,
      dist: Math.max(1, Math.round(h.dist)),
      yard: h.yard,
      poss: h.poss
    };
  }
  function headerFrom(snap){
    return `Q${snap.qtr} ${Math.floor(snap.secs/60)}:${String(snap.secs%60).padStart(2,'0')} | ${dnTxt(snap.down)} & ${snap.dist} @ ${yardText(snap.yard)}`;
  }
  function chooseReceiver(atk){const r=sim.rng(); let group=null;if(r<0.65&&atk.wr.length)group=atk.wr;else if(r<0.85&&atk.te.length)group=atk.te;else group=atk.rb.length?atk.rb:atk.wr;return group[Math.floor(sim.rng()*group.length)]||atk.qb;}
  
  function pickRusher(atk, h){
    const pool = [];
    const rb1 = atk.rb?.[0], rb2 = atk.rb?.[1], rb3 = atk.rb?.[2];
    const qb  = atk.qb;
    const wr  = (atk.wr && atk.wr.length) ? atk.wr[Math.floor(sim.rng()*atk.wr.length)] : null;
    const fb  = (atk.players||[]).find(p => p.pos === 'FB') || null;
    const short = h.dist <= 2;
  
    const fatigueDrop = p => (p && (p.adv?.carries||0) > 22) ? 0.6 : 1.0;
  
    if (rb1) pool.push([rb1, 0.55 * fatigueDrop(rb1)]);
    if (rb2) pool.push([rb2, 0.30 * fatigueDrop(rb2)]);
    if (rb3) pool.push([rb3, 0.12 * fatigueDrop(rb3)]);
  
    // WR jet/end-around ~3%
    if (wr) pool.push([wr, 0.03]);
  
    // FB dive very occasional
    if (fb) pool.push([fb, 0.03]);
  
    // QB sneak/keeper weight: bigger on short yardage and for mobile QBs
    if (qb){
      const mobile = (qb.SPD||70) >= 82;
      let w = mobile ? 0.06 : 0.03;
      if (short) w += mobile ? 0.12 : 0.06;
      pool.push([qb, w]);
    }
  
    const total = pool.reduce((a,[,w]) => a+w, 0) || 1;
    let x = sim.rng()*total;
    for (const [p,w] of pool){
      x -= w; if (x <= 0) return p;
    }
    return rb1 || qb || wr || (atk.players?.[0]); // ultimate fallback
  }
  
  
  // ===== Crowd helpers (GLOBAL) =====
  function computeCrowdIntensity(){
    const c = sim?.crowd || {present:0, cap:1, mood:0};
    const h = sim?.hud || {down:1, dist:10, yard:25, qtr:1, secs:900};
    const att = clamp(c.present / (c.cap || 1), 0, 1);
    const mood = clamp(c.mood || 0, -1, 1); // -1..1
  
    // Baseline + situational boosts (so it's not 0 unless stadium empty)
    let ctx = 0.15;                                                // baseline hum
    if ((h.down===3 && h.dist<=5) || h.down===4) ctx += 0.25;      // big down
    if (h.yard>=80) ctx += 0.15;                                   // red zone
    if (h.qtr===2 && h.secs<=120) ctx += 0.08;                     // late 1H
    if (h.qtr===4){ ctx += 0.10; if (h.secs<=300) ctx += 0.10; }   // late 4Q
    if (Math.abs(sim.score.home - sim.score.away) <= 8) ctx += 0.10; // one-score
    ctx = clamp(ctx, 0, 1);
  
    const base = att * (0.7 + 0.3 * mood);
    return clamp(base * ctx, 0, 1); // 0..1
  }
  
  function renderCrowdMeter(){
    const x = computeCrowdIntensity();     // 0..1
    const pct = (x*100);
    crowdPct.textContent = pct.toFixed(1) + '%';
    crowdBar.style.width = pct + '%';
  }
  
  function updateCrowd(){
    const h = sim.hud, c = sim.crowd; if(!c) return;
    const cap = c.cap || 72000;
  
    // Arrivals: 85% at kick, remaining 15% over first 12 min of Q1
    let target = c.present;
    if (h.qtr === 1) {
      const elapsed = 900 - h.secs;
      const arrivals = Math.round(0.15 * cap * Math.min(1, elapsed / 720));
      target = Math.floor(0.85 * cap + arrivals);
    }
  
    // Departures by score/weather/time
    const diff = Math.abs(sim.score.home - sim.score.away);
    const homeTrailing = (sim.score.home < sim.score.away);
    let leaveRate = 0;
    if (h.qtr >= 3 && diff >= 17) leaveRate += 0.005 * (diff - 16);
    if (precip.value === 'Heavy Rain' || precip.value === 'Snow') leaveRate += 0.004;
    if (+temp.value <= 20) leaveRate += 0.003;
    if (homeTrailing && h.qtr === 4 && h.secs < 600 && diff >= 10) leaveRate += 0.006;
  
    // Late, close games → hype
    if (h.qtr === 4 && diff <= 3) {
      leaveRate = Math.max(0, leaveRate - 0.004);
      c.mood = Math.min(1, (c.mood || 0) + 0.02);
    } else {
      c.mood = Math.max(-1, (c.mood || 0) - 0.005);
    }
  
    const desired = Math.max(0, Math.min(cap, target - Math.floor(cap * leaveRate)));
    c.present = Math.round(0.9 * c.present + 0.1 * desired);
    fansPill.textContent = `Fans: ${c.present.toLocaleString()}`;
    renderCrowdMeter();
  }
  
  function calcPlayTime(isScored){
    const h = sim.hud;
    const s = sim.score;
    const tf = clamp(1 - ((5 - h.qtr)*900 + h.secs)/3600, 0, 1);
  
    // get pace here (it was causing a ReferenceError before)
    const pace = (+feelPace.value)/100;
  
    // baseline
    let t = clamp(
      Math.round(
        randNorm(
          sim.rng,
          26 + (precip.value!=='None'?2:0) - 4*(pace-0.5),
          4
        )
      ),
      18, 35
    );
  
    // hurry-up if trailing late
    const homeTrail = (s.home < s.away);
    const trailTeam = homeTrail ? 'Home' : ((s.away < s.home) ? 'Away' : null);
    const trailingLate = (!!trailTeam) && (tf > 0.72);
  
    if (trailingLate){
      t = Math.max(16, Math.round(t * 0.78)); // ~22% faster
    }
  
    // after a score keep it compact; PAT/kickoff timing handled elsewhere
    if (isScored) t = Math.max(18, Math.min(28, t));
  
    return t;
  }
  
  
  // Global: prevent immediate back-to-back pre-snap flags
  let _preSnapPenaltyCooldown = 0;
  
  
  /* ===== Main loop ===== */
  function loop(ms){
    const r = (typeof sim.rng === 'function') ? sim.rng : Math.random;
    const h=sim.hud, s=sim.score;
  
    (async function tick(){
      while (running && !paused){
  
        if (pendingKickoff){
          doKickoff(); updateHUD(); updateScore(); Field.render({hud:h});
          const t=stateWP(s.home,s.away,h.qtr,h.secs,h.yard,h.poss,wpPrior);
          wpSmooth=0.97*wpSmooth+0.03*t; wpSeries.push(wpSmooth);
          wpVal.textContent=(wpSmooth*100).toFixed(1)+'%'; drawWP();
          updateCrowd();
          if (ms>0) await new Promise(rs=>setTimeout(rs,ms));
          continue;
        }
  
        if (pendingPAT){
          const {team, type} = pendingPAT;
          const atk = (team==='Home'?HOME:AWAY);
          const def = (team==='Home'?AWAY:HOME);
          const k   = atk.k || {first:'K',last:'',KICK_ACC:70};
  
          // WP *before* attempting the PAT (after TD but pre-PAT)
          const wpBeforePAT = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
  
          let text = '', realizedPts = 0, expectedPts = 0;
  
          if (type==='xp'){
            const xpP = clamp(0.93 + (k.KICK_ACC-70)/250 - (+wind.value/20)*0.08 - ((precip.value==='Heavy Rain'||precip.value==='Snow')?0.04:0), 0.85, 0.99);
            const make = r() < xpP;
            realizedPts = make ? 1 : 0; expectedPts = xpP;
  
            if (make){ if(team==='Home') s.home += 1; else s.away += 1; }
            text = `XP — ${k.first} ${k.last} ${make?'GOOD':'NO GOOD'}`;
          } else {
            const twoP = clamp(0.48 + (atk.offense - def.defense)/220, 0.35, 0.63);
            const make = r() < twoP;
            realizedPts = make ? 2 : 0; expectedPts = 2*twoP;
  
            if (make){ if(team==='Home') s.home += 2; else s.away += 2; }
            text = `2-pt Try — ${make?'GOOD':'FAIL'}`;
          }
  
          const epaPAT = realizedPts - expectedPts;
  
          // WP after PAT result (score now updated)
          const wpAfterPAT = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
          const wpdPAT = clamp(wpAfterPAT - wpBeforePAT, -0.12, 0.12);
  
          if (pendingScoreIdx>=0){
            const e = scoring[pendingScoreIdx];
            e.text += (type==='xp' ? ` (XP ${realizedPts? 'good':'no good'})` : ` (2-pt ${realizedPts? 'good':'fail'})`);
            e.score = `${s.home}-${s.away}`;
          }
  
          logPlay('PLAY', text, team, true, epaPAT, wpdPAT, 0);
  
          applyClock(0, { inBounds:false, offense: team, pat:true });
          pendingPAT = null;
          beginKickoff(team, { onside: shouldOnsideNow(team) });
  
          updateHUD(); updateScore(); Field.render({hud:h});
          const t = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
          wpSmooth = 0.97*wpSmooth + 0.03*t; wpSeries.push(wpSmooth);
          wpVal.textContent = (wpSmooth*100).toFixed(1)+'%'; drawWP();
          updateCrowd();
          if (ms>0) await new Promise(rs=>setTimeout(rs,ms));
          continue;
        }
  
        // --- Pre-snap penalty check (with 1-tick cooldown) ---
        if (_preSnapPenaltyCooldown > 0) {
          _preSnapPenaltyCooldown--;
        } else {
          const pre = chancePenalty({ down: h.down, isPass: false, airDepth: 0 });
          if (pre && pre.preSnap) {
            _preSnapPenaltyCooldown = 1; // block immediate repeats
            applyPenalty(pre);
            updateHUD(); Field.render({ hud:h });
            if (ms > 0) await new Promise(rs => setTimeout(rs, ms));
            continue; // replay the down from the new spot
          }
        }
  
        // Snapshot AFTER pre-snap penalties cleared
        const snap = snapshotHUD();
        const ep0  = driveEPForState(snap, HOME, AWAY); // decision-aware EP_before
        const wp0  = stateWP(s.home, s.away, snap.qtr, snap.secs, snap.yard, snap.poss, wpPrior);
        const startPoss = snap.poss;
        const driveEP0  = driveEPForState(snap, HOME, AWAY);
  
        /* >>> Early 4th-down decision: if not going for it, do FG/Punt here and stop <<< */
        if (h.down === 4) {
          const distGL = 100 - h.yard;
          const FGdist = Math.round(distGL + 17);
          const aggr = (+aggr4th.value);
          const goThresh = (h.yard >= 50 ? 4.0 : 2.0) - (aggr - 50)/25 - (h.qtr === 4 ? 0.6 : 0);
  
          if (h.dist > goThresh) {
            // Not going for it → choose FG if reasonable, else punt. Log ONLY that play.
            const teamObj = (h.poss === 'Home' ? HOME : AWAY).stats.team;
            const k = (h.poss === 'Home' ? HOME : AWAY).k;
  
            if (k && FGdist <= 68 && h.dist > 1) {
              // ΔWP: snapshot before we mutate score/possession
              const wpBefore = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
  
              teamObj.fga++;
              const make = r() < fgMakeProb(FGdist, k.KICK_POW, k.KICK_ACC);
  
              if (make) {
                teamObj.fgm++;
                if (h.poss === 'Home') s.home += 3; else s.away += 3;
  
                const epaFG = 3 - ep0;
  
                // WP after: scoring updated, possession unchanged (kickoff is pending)
                const wpAfter = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
                const wpdFG   = clamp(wpAfter - wpBefore, -wpCap(h.qtr, h.secs), wpCap(h.qtr, h.secs));
  
                scoring.push({ text: `${h.poss} FG (${FGdist})`, score: `${s.home}-${s.away}` });
                logPlay('PLAY', `${headerFrom(snap)} — FG — ${k.first} ${k.last} GOOD from ${FGdist}`, h.poss, true, epaFG, wpdFG, driveEP0);
  
                closeDrive('FG', h.yard);
                beginKickoff(h.poss, { onside: shouldOnsideNow(h.poss) });
              } else {
                // Miss → opponent ball at 100 - yard
                const newForDef = clamp(100 - h.yard, 1, 99);
                const epaFG = 0 - ep0;
  
                // Mutate to the missed-FG state BEFORE computing wpAfter
                closeDrive('Missed FG', h.yard);
                h.poss = (h.poss === 'Home' ? 'Away' : 'Home'); h.down = 1; h.dist = 10; h.yard = newForDef;
                pushDriveStart(h.poss, h.yard);
  
                const wpAfter = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
                const wpdFG   = clamp(wpAfter - wpBefore, -wpCap(h.qtr, h.secs), wpCap(h.qtr, h.secs));
  
                logPlay('PLAY', `${headerFrom(snap)} — FG — ${k.first} ${k.last} NO GOOD from ${FGdist}`, snap.poss, false, epaFG, wpdFG, driveEP0);
              }
            } else {
              // Punt (early 4th-down block)
              const wpBefore = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
  
              const punter = (h.poss === 'Home' ? HOME : AWAY).p || { first:'P', last:'', KICK_POW:70 };
              const gross = clamp(Math.round(46 + (punter.KICK_POW - 70)/2 + randNorm(sim.rng,0,7)), 35, 70);
              const land  = h.yard + gross;
  
              let text = '';
              if (land >= 100) {
                text = `${headerFrom(snap)} — Punt ${gross} by ${punter.first} ${punter.last} — touchback`;
                (h.poss==='Home'?HOME:AWAY).stats.team.punts++;
                closeDrive('Punt (TB)', h.yard);
  
                // flip
                h.poss = (h.poss === 'Home' ? 'Away' : 'Home'); h.down = 1; h.dist = 10; h.yard = 20;
                pushDriveStart(h.poss, h.yard);
              } else {
                const retMan = ((h.poss === 'Home' ? AWAY : HOME).wr[0] || (h.poss === 'Home' ? AWAY : HOME).rb[0] || (h.poss === 'Home' ? AWAY : HOME).players[0]);
                const recvAt = 100 - land;
                const ret    = clamp(Math.round(randNorm(sim.rng,10,8)), 0, 40);
                const end    = clamp(recvAt + ret, 1, 99);
                text = `${headerFrom(snap)} — Punt ${gross} by ${punter.first} ${punter.last}, ${retMan.first} ${retMan.last} returns ${ret} to ${yardText(end)}`;
  
                (h.poss==='Home'?HOME:AWAY).stats.team.punts++;
                closeDrive('Punt', h.yard);
  
                // flip
                h.poss = (h.poss === 'Home' ? 'Away' : 'Home'); h.down = 1; h.dist = 10; h.yard = end;
                pushDriveStart(h.poss, h.yard);
              }
  
              const wpAfter = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
              const wpdPunt = clamp(wpAfter - wpBefore, -wpCap(h.qtr, h.secs), wpCap(h.qtr, h.secs));
  
              logPlay('PLAY', text, snap.poss, false, -ep0, wpdPunt, driveEP0);
            }
  
            // consume a bit of clock for special teams, render, and skip normal play
            applyClock(clockDrainFor('st', (+feelPace.value)/100), { inBounds:true, offense: snap.poss });
  
            updateHUD(); updateScore(); Field.render({ hud:h });
            const t = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
            wpSmooth = 0.97*wpSmooth + 0.03*t; wpSeries.push(wpSmooth);
            wpVal.textContent = (wpSmooth*100).toFixed(1) + '%'; if (wpSeries.length>600) wpSeries.shift();
            drawWP(); renderBox(); renderLeaders(); renderTopEpa(); updateCrowd();
  
            if (h.secs <= 0) handleQuarterEnd();
            if (ms>0) await new Promise(rs=>setTimeout(rs,ms));
            continue; // prevents a run/pass from also occurring on 4th down
          }
        }
  
        const atk=(h.poss==='Home'?HOME:AWAY), def=(h.poss==='Home'?AWAY:HOME);
  
        // Offense vs defense advantage and sliders for this snap
        const offAdv = (atk.offense - def.defense);
        const varK   = (+feelVariance.value)/100;
  
        // Blend early/late pass preference based on game clock
        const tf = clamp(1 - ((5 - h.qtr) * 900 + h.secs) / 3600, 0, 1);
        const earlyPref = (+passEarly.value) / 100;
        const latePref  = (+passLate.value) / 100;
        const passPref  = earlyPref * (1 - tf) + latePref * tf;
  
        // ---- Situational pass/run blend (offense-aware, symmetric) ----
        const offenseIsHome   = (h.poss === 'Home');
        const scoreDiff       = s.home - s.away; // + means Home leads
        const offenseTrailing = offenseIsHome ? (scoreDiff < 0) : (scoreDiff > 0);
        const offenseLeading  = offenseIsHome ? (scoreDiff > 0) : (scoreDiff < 0);
  
        let passRate = 0.54 + (passPref - 0.55) * 0.50;  // anchor near NFL avg, respect slider
        if (h.down >= 3) passRate += 0.10;
        if (h.dist >= 7) passRate += 0.06;
        if (offenseTrailing) passRate += 0.05;
        if (!offenseTrailing && offenseLeading && h.qtr >= 4) passRate -= 0.08;
        passRate = clamp(passRate, 0.40, 0.65);
  
        const runRate = 1 - passRate;
  
        let deltaY=0, kind='', scored=false, playText='';
        const playTime = calcPlayTime(scored); // (kept for consistency)
  
        if (r() < runRate){
          const runner = pickRusher(atk, h);
  
          let ppen = chancePenalty({ down: h.down, isPass: false, airDepth: 0 });
          // No DPI on runs — convert to defensive holding 5y, auto 1st
          if (ppen && !ppen.preSnap && ppen.type === 'DPI') {
            ppen = { type:'Defensive holding', yards:+5, onDefense:true, autoFirst:true };
          }
          if (ppen) {
            applyPenalty(ppen);
            updateHUD(); Field.render({ hud:h });
            if (ms > 0) await new Promise(rs => setTimeout(rs, ms));
            continue;
          }
  
          const isQB = (runner === atk.qb);
          // NFL-ish yard distributions
          let mean   = 3.9 + offAdv*0.025;
          let spread = 3.2*(1 + 0.6*varK);
          if (isQB && h.dist <= 2){ mean = 2.3; spread = 1.4; }
          else if (isQB){ mean = 5.2 + (runner.SPD-78)/18; spread = 2.8; }
  
          const yRaw = clamp(Math.round(randNorm(r, mean, spread)), -4, 35);
          const yds  = Math.min(yRaw, 100 - h.yard);
          const tack = pickDefender(def,'tackleRun');
  
          if (h.yard + yds >= 100){
            if (h.poss === 'Home') s.home += 6; else s.away += 6;
            scored = true; kind = 'rush';
            playText = `${runner.first} ${runner.last} rushes for ${yds} yards, TOUCHDOWN`;
            atk.stats.team.td++;
  
            // TD logging (pre-PAT), then set pendingPAT
            const kAcc = ((h.poss==='Home'?HOME:AWAY).k?.KICK_ACC ?? 70);
            const xpP  = clamp(0.93 + (kAcc-70)/250 - (+wind.value/20)*0.08 - ((precip.value==='Heavy Rain'||precip.value==='Snow')?0.04:0), 0.85, 0.99);
            const tdEPA = 6 - ep0;
            const wpAfterTD = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
            const wpdTD = clamp(wpAfterTD - wp0, -0.30, 0.30);
            logPlay('PLAY', `${headerFrom(snap)} — ${playText}`, snap.poss, true, tdEPA, wpdTD, 0);
  
            const twoP = clamp(0.48 + (atk.offense - def.defense)/220, 0.35, 0.63);
            const patType = decidePAT({ team: h.poss });
            pendingPAT = { team: h.poss, type: patType, exp: (patType==='xp' ? xpP : 2*twoP) };
            pendingScoreIdx = scoring.push({ text: `${h.poss} TD run`, score: `${s.home}-${s.away}` }) - 1;
            closeDrive('TD', 100);
          } else {
            h.yard = clamp(h.yard + yds, 0, 99);
            deltaY = yds; kind = 'rush';
            setFirstDownOrAdvance(yds);
            tack.adv.tkl = (tack.adv.tkl||0) + (h.yard+yds>=100?0:1);
            playText = `${runner.first} ${runner.last} rushes for ${yds} yards, tackled by ${tack.first} ${tack.last} at ${yardText(h.yard)}`;
          }
  
          // Stats
          runner.adv.carries = (runner.adv.carries||0)+1;
          runner.adv.ry      = (runner.adv.ry||0) + Math.max(0, yds);
          const mph = clamp(13 + (runner.SPD-70)/3 + randNorm(r,0,1.5), 11, 22);
          runner.adv.fast = Math.max(runner.adv.fast||0, mph);
  
          atk.stats.team.rushYds += Math.max(0, deltaY);
        } else {
          // PASS
          const qb=atk.qb ? atk.qb : {first:'QB',last:'',PASS_ACC:70,INT:70,adv:{att:0,comp:0,yards:0,td:0,int:0,sacks:0,dropbacks:0,pressures:0,ttt:0,tttN:0,air:0,yac:0}};
          if(!qb.adv) qb.adv={};
          qb.adv.dropbacks=(qb.adv.dropbacks||0)+1;
  
          // Air yards for the throw
          const air = clamp(Math.round(randNorm(r, 6 + offAdv*0.008, 5*(1+0.5*varK))), -1, 26);
  
          // Live-ball penalty check (pre-snap handled earlier)
          const pen = chancePenalty({ down: h.down, isPass: true, airDepth: air });
          if (pen) {
            applyPenalty(pen);
            updateHUD();
            Field.render({ hud: h });
            if (ms > 0) await new Promise(rs => setTimeout(rs, ms));
            continue; // never run the play when a flag occurs
          }
  
          // Pressure → possible scramble → else resolve (sack / complete / incomplete)
          let pressureP = clamp(0.24 + (def.defense - atk.offense) / 180, 0.12, 0.45);
  
          // Loud home crowds make life tougher on the road QB
          const offenseIsAway = (h.poss === 'Away');
          if (offenseIsAway && typeof crowdVolume === 'function') {
            const noise = crowdVolume(); // 0–1
            pressureP = clamp(pressureP * (1 + 0.25 * noise), 0.12, 0.55);
          }
  
          const pressured  = (r() < pressureP);
          if (pressured) qb.adv.pressures = (qb.adv.pressures || 0) + 1;
  
          // ---- QB SCRAMBLE (when pressured) ----
          const scrambleP = clamp(
            0.08 + (qb.SPD - 78) / 120 + (pressured ? 0.10 : 0) + (h.dist >= 8 ? 0.03 : 0),
            0.02, 0.28
          );
  
          if (pressured && r() < scrambleP) {
            // Treat as a run: do NOT count as a pass attempt
            const y = Math.min(
              clamp(Math.round(randNorm(r, 7 + (qb.SPD - 80) / 8, 4.5)), -2, 35),
              100 - h.yard
            );
  
            if (h.yard + y >= 100) {
              if (h.poss === 'Home') s.home += 6; else s.away += 6;
              scored = true; kind = 'rush';
              playText = `${qb.first} ${qb.last} scrambles ${y} yards for a TOUCHDOWN`;
              atk.stats.team.td++;
  
              // Log TD pre-PAT and set pendingPAT
              const kAcc = ((h.poss==='Home'?HOME:AWAY).k?.KICK_ACC ?? 70);
              const xpP  = clamp(0.93 + (kAcc-70)/250 - (+wind.value/20)*0.08 - ((precip.value==='Heavy Rain'||precip.value==='Snow')?0.04:0), 0.85, 0.99);
              const tdEPA = 6 - ep0;
              const wpAfterTD = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
              const wpdTD = clamp(wpAfterTD - wp0, -0.30, 0.30);
              logPlay('PLAY', `${headerFrom(snap)} — ${playText}`, snap.poss, true, tdEPA, wpdTD, 0);
  
              const twoP = clamp(0.48 + (atk.offense - def.defense)/220, 0.35, 0.63);
              const patType = decidePAT({ team: h.poss });
              pendingPAT = { team: h.poss, type: patType, exp: (patType==='xp' ? xpP : 2*twoP) };
              pendingScoreIdx = scoring.push({ text: `${h.poss} TD run (QB scramble)`, score: `${s.home}-${s.away}` }) - 1;
              closeDrive('TD', 100);
            } else {
              h.yard = clamp(h.yard + y, 0, 99);
              deltaY = y; kind = 'rush';
              setFirstDownOrAdvance(y);
              const tack = pickDefender(def, 'tackleRun'); tack.adv.tkl = (tack.adv.tkl||0) + 1;
              playText = `${qb.first} ${qb.last} scrambles for ${y} yards, tackled by ${tack.first} ${tack.last} at ${yardText(h.yard)}`;
              qb.adv.carries = (qb.adv.carries||0) + 1;
              qb.adv.ry      = (qb.adv.ry||0) + Math.max(0, y);
              atk.stats.team.rushYds += Math.max(0, y);
            }
  
          } else {
            // ---- Pure pass resolution (no scramble) ----
            const sackP = pressured ? 0.18 : 0.06;
            let wxPenalty = 0;
            if (precip.value === 'Light Rain') wxPenalty += 0.03;
            if (precip.value === 'Heavy Rain' || precip.value === 'Snow') wxPenalty += 0.07;
            if (+wind.value >= 18) wxPenalty += 0.03;
  
            const expComp = clamp(
              0.58 + (qb.PASS_ACC - 80) / 220
                  - (def.defense - 70) / 300
                  - (air > 12 ? 0.09 : 0)
                  - (pressured ? 0.08 : 0)
                  - wxPenalty,
              0.30, 0.72
            );
  
            qb.adv.expSum = (qb.adv.expSum || 0) + expComp;
            qb.adv.expN   = (qb.adv.expN   || 0) + 1;
  
            const ttt = clamp(randNorm(r, 2.65 + (pressured ? -0.3 : 0), 0.35), 1.3, 4.5);
            qb.adv.ttt  = (qb.adv.ttt  || 0) + ttt;
            qb.adv.tttN = (qb.adv.tttN || 0) + 1;
  
            const x = r();
            if (x < sackP) {
              const loss = clamp(Math.round(randNorm(r, 6, 3)), 3, 13);
              const sacker = pickDefender(def, 'sack');
              sacker.adv.sk = (sacker.adv.sk || 0) + 1;
              h.yard = Math.max(0, h.yard - loss);
              deltaY = -loss; kind = 'pass';
              setFirstDownOrAdvance(-loss);
              playText = `${qb.first} ${qb.last} sacked by ${sacker.first} ${sacker.last} for -${loss} at ${yardText(h.yard)}`;
              qb.adv.sacks = (qb.adv.sacks || 0) + 1;
  
            } else {
              if (r() < expComp) {
                const wr  = chooseReceiver(atk);
                const yac = Math.max(0, Math.round(randNorm(r, 3.0 + (atk.offense - def.defense)/140, 2.2*(1+0.5*varK))));
                // Cap total gain by yards-to-goal
                const gain = Math.min(Math.max(0, air) + yac, 100 - h.yard);
  
                if (h.yard + gain >= 100) {
                  if (h.poss === 'Home') s.home += 6; else s.away += 6;
                  scored = true; kind = 'pass';
                  playText = `${qb.first} ${qb.last} completes to ${wr.first} ${wr.last} for ${gain} yards, TOUCHDOWN`;
                  atk.stats.team.td++;
  
                  // TD logging (pre-PAT)
                  const kAcc = ((h.poss==='Home'?HOME:AWAY).k?.KICK_ACC ?? 70);
                  const xpP  = clamp(0.93 + (kAcc-70)/250 - (+wind.value/20)*0.08 - ((precip.value==='Heavy Rain'||precip.value==='Snow')?0.04:0), 0.85, 0.99);
                  const tdEPA = 6 - ep0;
                  const wpAfterTD = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
                  const wpdTD = clamp(wpAfterTD - wp0, -0.30, 0.30);
                  logPlay('PLAY', `${headerFrom(snap)} — ${playText}`, snap.poss, true, tdEPA, wpdTD, 0);
  
                  const twoP = clamp(0.48 + (atk.offense - def.defense)/220, 0.35, 0.63);
                  const patType = decidePAT({ team: h.poss });
                  pendingPAT = { team: h.poss, type: patType, exp: (patType==='xp' ? xpP : 2*twoP) };
                  pendingScoreIdx = scoring.push({ text: `${h.poss} TD pass`, score: `${s.home}-${s.away}` }) - 1;
                  closeDrive('TD', 100);
  
                  // Stats
                  qb.adv.td    = (qb.adv.td||0) + 1;
                  qb.adv.comp  = (qb.adv.comp||0) + 1; qb.adv.att = (qb.adv.att||0) + 1;
                  qb.adv.yards = (qb.adv.yards||0) + gain; qb.adv.air += Math.max(0, air); qb.adv.yac += yac;
                  wr.adv.catches = (wr.adv.catches||0) + 1; wr.adv.targets = (wr.adv.targets||0) + 1;
                  wr.adv.recY = (wr.adv.recY||0) + gain; wr.adv.air = (wr.adv.air||0) + Math.max(0, air);
                  wr.adv.yac = (wr.adv.yac||0) + yac; wr.adv.td = (wr.adv.td||0) + 1;
  
                } else {
                  h.yard = clamp(h.yard + gain, 0, 99);
                  deltaY = gain; kind = 'pass';
                  setFirstDownOrAdvance(gain);
                  const tack = pickDefender(def, 'tacklePass'); tack.adv.tkl = (tack.adv.tkl||0) + 1;
                  playText = `${qb.first} ${qb.last} completes to ${wr.first} ${wr.last} for ${gain} yards, tackled by ${tack.first} ${tack.last} at ${yardText(h.yard)}`;
  
                  wr.adv.targets = (wr.adv.targets||0) + 1; wr.adv.catches = (wr.adv.catches||0) + 1;
                  wr.adv.recY = (wr.adv.recY||0) + gain; wr.adv.air = (wr.adv.air||0) + Math.max(0, air);
                  wr.adv.yac = (wr.adv.yac||0) + yac; wr.adv.ayDepth = (wr.adv.ayDepth||0) + Math.max(0, air);
                  wr.adv.ayN = (wr.adv.ayN||0) + 1;
                  const sep = clamp(2.7 + (wr.SPD - 70) / 25 - (def.defense - 70) / 120 + randNorm(r, 0, 0.6), 0.5, 4.5);
                  wr.adv.sep = (wr.adv.sep||0) + sep; wr.adv.sepN = (wr.adv.sepN||0) + 1;
  
                  qb.adv.comp  = (qb.adv.comp||0) + 1; qb.adv.att = (qb.adv.att||0) + 1;
                  qb.adv.yards = (qb.adv.yards||0) + gain; qb.adv.air += Math.max(0, air); qb.adv.yac += yac;
                }
  
              } else {
                // incomplete or INT chance
                if (r() < 0.04) {
                  const pick = pickDefender(def, 'int'); pick.adv.ints = (pick.adv.ints||0) + 1;
                  const ret  = clamp(Math.round(randNorm(r, 10, 7)), 0, 60);
                  const newForDef = clamp(100 - (h.yard + ret), 1, 99);
                  playText = `${qb.first} ${qb.last} pass is INTERCEPTED by ${pick.first} ${pick.last}, return to ${yardText(newForDef)}`;
                  (h.poss==='Home'?HOME:AWAY).stats.team.ints++;
                  closeDrive('INT', h.yard);
                  h.poss = (h.poss === 'Home' ? 'Away' : 'Home'); h.down = 1; h.dist = 10; h.yard = newForDef;
                  pushDriveStart(h.poss, h.yard);
                } else {
                  setFirstDownOrAdvance(0);
                  const db = pickDefender(def, 'tacklePass'); db.adv.pd = (db.adv.pd||0) + 1;
                  playText = `${qb.first} ${qb.last} pass incomplete`;
                  qb.adv.att = (qb.adv.att||0) + 1;
                  const wrMiss = chooseReceiver(atk); wrMiss.adv.targets = (wrMiss.adv.targets||0) + 1;
                  if (r() < clamp(0.03 + (70 - (wrMiss.HANDS||70)) / 400, 0.01, 0.08)) {
                    wrMiss.adv.drops = (wrMiss.adv.drops||0) + 1; playText += ' (drop)';
                  }
                }
              }
            }
  
            // Only passes contribute to team.passYds
            if (kind === 'pass') {
              atk.stats.team.passYds += Math.max(0, deltaY);
            }
          }
        }
  
        // Update team/drives
        const teamObj=(startPoss==='Home'?HOME:AWAY).stats.team;
        if(startPoss===h.poss){ teamObj.plays++; teamObj.yards+=deltaY; }
        const D=drives.length?drives[drives.length-1]:null;
        if(D && startPoss===h.poss){ D.plays++; D.yards+=deltaY; }
  
        if (startPoss === h.poss && snap.down === 3) {
          teamObj.third.a++;
          if (h.down === 1) {
            teamObj.third.c++;
          }
        }
  
        // clock — outcome-aware drain (run/comp/incomp/sack) + late OOB bias
        {
          const pace = (+feelPace.value)/100;
          const ctx = classifyClockContext(playText, kind, scored);
  
          // late-game sideline bias: occasionally force clock to stop on in-bounds gains
          if (!scored) {
            const offenseIsHome = (startPoss === 'Home');
            const lead = sim.score.home - sim.score.away;
            const offenseTrailing = offenseIsHome ? (lead < 0) : (lead > 0);
            const tLeft = (5 - h.qtr) * 900 + h.secs;
            const late = (h.qtr === 4) && (tLeft <= 300);
            const oobBias = late && offenseTrailing ? 0.18 : 0.06;
            const wentOOB = (kind !== 'sack') && (r() < oobBias);
            if (wentOOB) ctx.inBounds = false;
          }
  
          applyClock(clockDrainFor(ctx.outcome, pace), { inBounds: ctx.inBounds, offense: startPoss });
        }
  
        // 4th down decisions (go-for-it resolution only; FG/punts handled earlier)
        if (!scored && h.down === 5) {
          const distGL  = 100 - h.yard;
          const FGdist  = Math.round(distGL + 17); // kept for potential future use
          const aggr    = (+aggr4th.value);
          const goThresh = (h.yard >= 50 ? 4.0 : 2.0) - (aggr - 50)/25 - (h.qtr === 4 ? 0.6 : 0);
  
          // Only handle true "go for it" situations here.
          if (h.dist <= goThresh) {
            teamObj.fourth.a++;
            const wpBefore = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
  
            const atkTeam  = (h.poss === 'Home' ? HOME : AWAY);
            const defTeam  = (h.poss === 'Home' ? AWAY : HOME);
            const success  = r() < clamp(
              0.48 + (atkTeam.offense - defTeam.defense)/220,
              0.30,
              0.70
            );
  
            if (success) {
              teamObj.fourth.c++;
              h.down = 1;
              h.dist = Math.min(10, 100 - h.yard);
  
              const wpAfter = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
              const wpdGo   = clamp(wpAfter - wpBefore, -wpCap(h.qtr, h.secs), wpCap(h.qtr, h.secs));
              logPlay('PLAY','4th-down conversion — chains move', h.poss, false, 0, wpdGo);
            } else {
              teamObj.downs++;
              closeDrive('Downs', h.yard);
  
              // Flip on downs at spot
              const newForDef = clamp(100 - h.yard, 1, 99);
              const prevPoss  = h.poss;
  
              h.poss = (h.poss === 'Home' ? 'Away' : 'Home');
              h.down = 1;
              h.dist = 10;
              h.yard = newForDef;
              pushDriveStart(h.poss, h.yard);
  
              const wpAfter = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
              const wpdFail = clamp(wpAfter - wpBefore, -wpCap(h.qtr, h.secs), wpCap(h.qtr, h.secs));
              logPlay('PLAY','4th-down failed — turnover on downs', prevPoss, false, -ep0, wpdFail);
            }
          }
        }
  
        // EPA/WP annotate and log with the PRE-PLAY header (drive-EP consistent)
        const wp1 = stateWP(s.home, s.away, h.qtr, h.secs, h.yard, h.poss, wpPrior);
  
        // decision-aware EP_after for current offense state
        const ep1Drive = driveEPForState(
          { poss:h.poss, down:h.down, dist:h.dist, yard:h.yard, qtr:h.qtr, secs:h.secs },
          HOME, AWAY
        );
  
        // If the play scored, realized drive points are 6 (TD) or 3 (FG); else ΔEP
        const realizedPts = scored ? 6 : 0; // (FG/Punt handled in special-teams blocks)
        const epa = scored ? (realizedPts - ep0) : (ep1Drive - ep0);
  
        // ΔWP cap by time
        const wpd = clamp(wp1 - wp0, -wpCap(h.qtr, h.secs), wpCap(h.qtr, h.secs));
  
        // DriveEP for logger
        let driveEpForLog = null;
        if (scored && pendingPAT && typeof pendingPAT.exp === 'number') {
          driveEpForLog = pendingPAT.exp;
        } else if (!scored) {
          driveEpForLog = clamp(EP(h.down, h.dist, h.yard), 0, 6.99);
        }
  
        // Log once
        if (!pendingKickoff && !pendingPAT) {
          logPlay('PLAY', `${headerFrom(snap)} — ${playText}`, startPoss, scored, epa, wpd, driveEP0);
        }
  
        (h.poss==='Home'?HOME:AWAY).stats.team.epa += (epa||0);
  
        // visuals
        updateHUD(); updateScore(); Field.render({hud:h});
        wpSmooth=0.97*wpSmooth+0.03*wp1; wpSeries.push(wpSmooth);
        wpVal.textContent=(wpSmooth*100).toFixed(1)+'%';
        if (wpSeries.length>600) wpSeries.shift();
        drawWP(); renderBox(); renderLeaders(); renderTopEpa(); updateCrowd();
  
        // Quarter/end handling (use your helper)
        if (h.secs <= 0) {
          handleQuarterEnd();
          if (!running) break; // game ended inside handleQuarterEnd
        }
  
        if (ms > 0) await new Promise(rs => setTimeout(rs, ms));
      } // ← END while(running && !paused)
    })(); // ← END async tick()
  } // ← END function loop