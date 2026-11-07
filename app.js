/* Amirnet vocabulary trainer — spaced repetition, offline, syncs a log to a Google Sheet. */
(() => {
const KEY = 'amirnet.v1';
const DAY = 86400000;
const INTERVALS = [0, 1, 2, 4, 7, 14, 30, 60];   // days per box
const MASTERED_BOX = 4;
const SESSION_SIZE = 12;
const LEVEL_NAMES = ['מילות קישור · בישיבות', 'אקדמי', 'מתקדם'];
const POS_NAMES = {c:'מילת קישור', n:'שם עצם', v:'פועל', a:'תואר', d:'תואר הפועל'};

const W = WORDS.map(([en, he, lvl, pos], i) => ({id: en, en, he, lvl, pos, i}));
const byId = Object.fromEntries(W.map(w => [w.id, w]));

/* ---------- state ---------- */
const today = () => new Date().toLocaleDateString('en-CA');
function load(){
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.cards) return s; } catch(e){}
  return {cards:{}, queue:[], days:{}, settings:{dailyNew:20, syncUrl:''}, created:Date.now(), device: Math.random().toString(36).slice(2,10)};
}
let S = load();
function save(){ try { localStorage.setItem(KEY, JSON.stringify(S)); } catch(e){} }
function dayRec(d = today()){ return S.days[d] ||= {reviews:0, correct:0, newWords:0, ms:0}; }

/* ---------- scheduling ---------- */
function dueCards(now = Date.now()){
  return Object.entries(S.cards).filter(([id,c]) => byId[id] && c.due <= now).map(([id]) => id)
    .sort((a,b) => S.cards[a].due - S.cards[b].due);
}
const FAMILY_OF = {};
Object.entries(typeof FAMILIES === 'undefined' ? {} : FAMILIES).forEach(([f, ws]) => ws.forEach(w => FAMILY_OF[w] = f));
const NOTE = typeof NOTES === 'undefined' ? {} : NOTES;
const NEAR = {};
(typeof SIMILAR === 'undefined' ? [] : SIMILAR).forEach(g => g.forEach(x => { (NEAR[x] ||= new Set()); g.forEach(y => { if (y !== x) NEAR[x].add(y); }); }));
// New words are interleaved: about one connector for every two academic words.
// Words from the same meaning family are never introduced on the same day (they interfere).
// connectors are taught in the live sessions, so the app no longer introduces new ones
const MIX = [1, 1, 1, 1, 1, 2];
function newCandidates(){
  const usedFam = new Set(dayRec().fams || []);
  const left = {0: [], 1: [], 2: []};
  // academic words come in a fixed scrambled order, so related words written next to each other in the list are spread apart
  const h = str => { let x = 2166136261; for (const ch of str){ x ^= ch.charCodeAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
  W.filter(w => !S.cards[w.id]).sort((a,b) => a.lvl === 0 ? a.i - b.i : h(a.id) - h(b.id)).forEach(w => left[w.lvl].push(w));
  const out = [];
  let k = 0, guard = 0;
  while (guard++ < 2000 && (left[1].length || left[2].length)){
    let lvl = MIX[k++ % MIX.length];
    if (lvl === 1 && !left[1].length) lvl = 2;
    if (!left[lvl].length) lvl = [1,2].find(l => left[l].length);
    if (lvl === undefined) break;
    if (lvl === 0){
      const idx = left[0].findIndex(w => !usedFam.has(FAMILY_OF[w.id]));
      if (idx < 0){ left[0] = []; continue; }
      const w = left[0].splice(idx, 1)[0]; usedFam.add(FAMILY_OF[w.id]); out.push(w.id);
    } else out.push(left[lvl].shift().id);
  }
  return out;
}
function newLeftToday(){ return Math.max(0, S.settings.dailyNew - dayRec().newWords); }
function buildSession(){
  const due = dueCards();
  const fresh = newCandidates().slice(0, newLeftToday());
  const ids = [];
  // mix: up to SESSION_SIZE, reviews first priority, new words interleaved (1 new per 2 reviews)
  let di = 0, ni = 0;
  while (ids.length < SESSION_SIZE && (di < due.length || ni < fresh.length)){
    if (di < due.length) ids.push({id: due[di++], isNew:false});
    if (ids.length < SESSION_SIZE && di < due.length) ids.push({id: due[di++], isNew:false});
    if (ids.length < SESSION_SIZE && ni < fresh.length) ids.push({id: fresh[ni++], isNew:true});
  }
  return ids;
}
function grade(id, ok, ms, mode){
  if (!S.cards[id]){ const d = dayRec(); d.newWords++; if (FAMILY_OF[id]) (d.fams ||= []).push(FAMILY_OF[id]); }
  const c = S.cards[id] ||= {box:0, due:0, seen:0, right:0, wrong:0, first:Date.now()};
  c.seen++; c.lastMs = ms;
  const SLOW_MS = mode === 'type' ? 15000 : 8000;
  if (ok){
    c.right++;
    // a slow correct answer is treated as shaky: the word stays at its level instead of moving up
    if (ms < SLOW_MS || c.box === 0) c.box = Math.min(c.box + 1, INTERVALS.length - 1);
    c.due = Date.now() + Math.max(INTERVALS[c.box], ms < SLOW_MS ? 0 : 1)*DAY - 3600000;
  }
  else { c.wrong++; c.box = 1; c.due = Date.now() + 10*60000; }
  const d = dayRec(); d.reviews++; if (ok) d.correct++; d.ms += ms;
  touchStreak();
  S.queue.push({t:new Date().toISOString(), word:id, ok:ok?1:0, ms, mode, box:c.box, lvl:byId[id].lvl, dev:S.device});
  save();
}
function touchStreak(){ S.lastStudy = today(); }
function streak(){
  let n = 0; const d = new Date();
  if (!S.days[today()]?.reviews) d.setDate(d.getDate() - 1);
  while (S.days[d.toLocaleDateString('en-CA')]?.reviews){ n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------- stats ---------- */
function stats(){
  const cards = Object.entries(S.cards).filter(([id]) => byId[id]);
  const mastered = cards.filter(([,c]) => c.box >= MASTERED_BOX).length;
  const learning = cards.length - mastered;
  let r = 0, ok = 0, ms = 0;
  for (let k = 0; k < 7; k++){ const d = new Date(Date.now() - k*DAY).toLocaleDateString('en-CA'); const x = S.days[d]; if (x){ r += x.reviews; ok += x.correct; ms += x.ms; } }
  const levels = [0,1,2].map(l => {
    const total = W.filter(w => w.lvl === l).length;
    const cs = cards.filter(([id]) => byId[id].lvl === l);
    return {total, mastered: cs.filter(([,c]) => c.box >= MASTERED_BOX).length, started: cs.length,
            acc: (() => { const s = cs.reduce((a,[,c]) => [a[0]+c.right, a[1]+c.seen], [0,0]); return s[1] ? Math.round(100*s[0]/s[1]) : null; })()};
  });
  return {mastered, learning, total: W.length, acc7: r ? Math.round(100*ok/r) : null, avgMs: r ? Math.round(ms/r) : null, due: dueCards().length, streak: streak(), levels};
}

/* ---------- sync to Google Sheet (Apps Script web app) ---------- */
let syncState = '';
async function sync(){
  const url = S.settings.syncUrl;
  if (!url || !S.queue.length || !navigator.onLine) return;
  const batch = S.queue.slice(0, 200);
  const st = stats();
  const payload = {events: batch, summary: {t: new Date().toISOString(), dev: S.device, mastered: st.mastered, learning: st.learning, total: st.total, acc7: st.acc7, avgMs: st.avgMs, streak: st.streak, due: st.due,
    levels: st.levels.map(l => `${l.mastered}/${l.total}`).join(' · ')}};
  try{
    await fetch(url, {method:'POST', mode:'no-cors', headers:{'Content-Type':'text/plain'}, body: JSON.stringify(payload)});
    S.queue.splice(0, batch.length); S.lastSync = Date.now(); save(); syncState = 'ok';
  }catch(e){ syncState = 'err'; }
}
window.addEventListener('online', () => sync());

/* ---------- views ---------- */
const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtPct = v => v == null ? '–' : v + '%';
function shuffle(a){ for (let i = a.length-1; i > 0; i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]] = [a[j],a[i]]; } return a; }

function home(){
  const st = stats();
  const ses = buildSession();
  const examDays = Math.ceil((new Date('2026-12-20T08:00:00+02:00') - Date.now()) / DAY);
  const syncLine = !S.settings.syncUrl ? '<span class="sync muted">הסנכרון עוד לא מוגדר</span>'
    : S.queue.length ? `<span class="sync">${S.queue.length} תשובות ממתינות לסנכרון</span>`
    : `<span class="sync ok">מסונכרן${S.lastSync ? ' · ' + new Date(S.lastSync).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}) : ''}</span>`;
  app.innerHTML = `
    <div class="top"><h1>אמירנט</h1><button class="icon-btn" id="setBtn">הגדרות</button></div>
    <p class="muted">${examDays > 0 ? `עוד ${examDays} ימים לבחינה` : 'יום הבחינה'} · רצף של ${st.streak} ${st.streak === 1 ? 'יום' : 'ימים'}</p>
    <button class="big-btn" id="go" ${ses.length ? '' : 'disabled'}>${ses.length ? `התחל · ${ses.length} כרטיסים` : 'אין כרגע מה לחזור, כל הכבוד'}</button>
    <section class="panel">
      <div class="stats">
        <div class="stat"><span class="n">${st.mastered}</span><span class="l">מילים שננעלו</span></div>
        <div class="stat"><span class="n">${st.learning}</span><span class="l">בתהליך</span></div>
        <div class="stat"><span class="n">${fmtPct(st.acc7)}</span><span class="l">דיוק, 7 ימים</span></div>
        <div class="stat"><span class="n">${st.avgMs ? (st.avgMs/1000).toFixed(1) : '–'}</span><span class="l">שניות לתשובה</span></div>
      </div>
      <p class="muted" style="font-size:14px">לחזרה עכשיו: ${st.due} · מילים חדשות שנשארו היום: ${newLeftToday()}</p>
    </section>
    <section class="panel">
      <h2>התקדמות לפי רמה</h2>
      <div class="levels">${st.levels.map((l,i) => `
        <div class="lv"><div class="head"><span>${LEVEL_NAMES[i]}</span><span class="muted">${l.mastered}/${l.total}${l.acc != null ? ' · דיוק ' + l.acc + '%' : ''}</span></div>
        <div class="bar"><span class="m" style="width:${100*l.mastered/l.total}%"></span><span class="s" style="width:${100*(l.started-l.mastered)/l.total}%"></span></div></div>`).join('')}
      </div>
      <button class="btn" id="listBtn">כל המילים</button>
    </section>
    <div class="row" style="justify-content:space-between">${syncLine}<span class="sync muted">גרסה ${APP_VERSION}</span></div>`;
  document.getElementById('go').onclick = () => session(ses);
  document.getElementById('setBtn').onclick = settings;
  document.getElementById('listBtn').onclick = wordList;
}

function session(items){
  const results = [];
  let i = 0;
  const show = () => {
    if (i >= items.length) return finish();
    const {id, isNew} = items[i];
    const w = byId[id];
    const c = S.cards[id];
    // new and weak words: English to Hebrew; stronger words: also Hebrew to English
    // well-known words: produce the English yourself (recall beats recognition)
    const mode = (isNew || !c || c.box < 2) ? 'en2he' : (c.box >= 3 && Math.random() < 0.5) ? 'type' : (Math.random() < 0.5 ? 'en2he' : 'he2en');
    if (mode === 'type') return typeCard(w);
    // distractors must not share a meaning word with the answer (e.g. "למרות" vs "למרות ש")
    const toks = s => s.split(/[\s,;]+/).filter(t => t.length >= 3);
    const wt = new Set(toks(w.he));
    const pool = W.filter(x => x.id !== id && x.pos === w.pos && !toks(x.he).some(t => wt.has(t)));
    // wrong options mirror the exam: same part of speech, unrelated meanings.
    // connectors never get options from their own meaning family.
    const far = pool.filter(x => (!FAMILY_OF[w.id] || FAMILY_OF[x.id] !== FAMILY_OF[w.id]) && !(NEAR[w.id] && NEAR[w.id].has(x.id)));
    const distract = shuffle(far.length >= 3 ? far : pool).slice(0, 3);
    const opts = shuffle([w, ...distract]);
    const t0 = performance.now();
    app.innerHTML = `
      <div class="top"><button class="icon-btn" id="quit">יציאה</button><span class="muted">${i+1}/${items.length}</span></div>
      <div class="progress">${items.map((_,k) => `<i class="${k < i ? (results[k] ? 'ok' : 'no') : k === i ? 'cur' : ''}"></i>`).join('')}</div>
      <div class="card">
        ${isNew ? '<span class="pill" style="justify-self:center">מילה חדשה</span>' : ''}
        ${mode === 'en2he' ? `<div class="prompt-en">${esc(w.en)}</div>` : `<div class="prompt-he">${esc(w.he)}</div>`}
        <div class="hint">${POS_NAMES[w.pos]}</div>
      </div>
      <div class="opts">${opts.map((o,k) => `<button class="opt ${mode === 'he2en' ? 'en' : ''}" data-id="${esc(o.id)}"><span class="k">${k+1}</span><span>${esc(mode === 'en2he' ? o.he : o.en)}</span></button>`).join('')}
        <button class="opt idk" data-id="__idk__"><span class="k">?</span><span>לא יודע</span></button></div>
      <div class="feedback" id="fb"></div>`;
    document.getElementById('quit').onclick = () => { sync(); home(); };
    app.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const ms = Math.round(performance.now() - t0);
      const ok = b.dataset.id === id;   // "לא יודע" counts as a miss, so a lucky guess never locks a word
      app.querySelectorAll('.opt').forEach(x => { x.disabled = true; if (x.dataset.id === id) x.classList.add('right'); });
      if (!ok && b.dataset.id !== '__idk__') b.classList.add('wrong');
      grade(id, ok, ms, mode);
      results.push(ok);
      if (!ok) items.push({id, isNew:false});   // see it again before the session ends
      after(w, ok);
    });
  };
  // shared feedback: correct answers move on quickly unless there is a usage note worth reading
  const after = (w, ok) => {
    const fb = document.getElementById('fb');
    const note = NOTE[w.id] ? `<p class="note">${esc(NOTE[w.id])}</p>` : '';
    if (ok && !note){ setTimeout(() => { i++; show(); }, 650); return; }
    fb.innerHTML = `<div style="display:grid;gap:8px;width:100%">${note}<button class="btn primary" id="next">${ok ? 'המשך' : `${esc(w.en)} = ${esc(w.he)} · המשך`}</button></div>`;
    const nx = document.getElementById('next'); nx.focus(); nx.onclick = () => { i++; show(); };
  };
  const typeCard = (w) => {
    const t0 = performance.now();
    const len = w.en.replace(/[^a-z]/gi, '').length;
    app.innerHTML = `
      <div class="top"><button class="icon-btn" id="quit">יציאה</button><span class="muted">${i+1}/${items.length}</span></div>
      <div class="progress">${items.map((_,k) => `<i class="${k < i ? (results[k] ? 'ok' : 'no') : k === i ? 'cur' : ''}"></i>`).join('')}</div>
      <div class="card">
        <span class="pill" style="justify-self:center">כתוב באנגלית</span>
        <div class="prompt-he">${esc(w.he)}</div>
        <div class="hint">מתחילה ב־<b dir="ltr">${esc(w.en[0])}</b> · ${len} אותיות</div>
      </div>
      <form id="tf" class="opts" autocomplete="off">
        <input id="ans" dir="ltr" class="type-in" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="התשובה באנגלית">
        <button class="btn primary" type="submit">בדוק</button>
      </form>
      <div class="feedback" id="fb"></div>`;
    document.getElementById('quit').onclick = () => { sync(); home(); };
    const inp = document.getElementById('ans'); inp.focus();
    document.getElementById('tf').onsubmit = (e) => {
      e.preventDefault();
      if (inp.disabled) return;
      const norm = s => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
      const ok = norm(inp.value) === norm(w.en);
      const ms = Math.round(performance.now() - t0);
      inp.disabled = true; inp.classList.add(ok ? 'right' : 'wrong');
      grade(w.id, ok, ms, 'type'); results.push(ok);
      if (!ok) items.push({id: w.id, isNew: false});
      after(w, ok);
    };
  };
  const finish = () => {
    const ok = results.filter(Boolean).length;
    sync();
    app.innerHTML = `
      <div class="panel done">
        <h2>סשן הושלם</h2>
        <div class="n">${ok}/${results.length}</div>
        <p class="muted">${ok === results.length ? 'בלי טעויות. הזיכרון שלך עובד.' : 'כל טעות כאן היא מילה שתחזור אליך בזמן הנכון. ככה הן ננעלות.'}</p>
      </div>
      <button class="big-btn" id="again">עוד סשן</button>
      <button class="btn" id="back">למסך הבית</button>`;
    const next = buildSession();
    const again = document.getElementById('again');
    if (!next.length){ again.disabled = true; again.textContent = 'סיימת את כל מה שמתוכנן להיום'; }
    else again.onclick = () => session(next);
    document.getElementById('back').onclick = home;
  };
  show();
}

function wordList(){
  const rows = W.slice().sort((a,b) => a.lvl - b.lvl || a.i - b.i).map(w => {
    const c = S.cards[w.id];
    const tag = !c ? '' : c.box >= MASTERED_BOX ? '<span class="pill" style="color:var(--good);border-color:var(--good)">ננעלה</span>' : `<span class="pill">${c.right}/${c.seen}</span>`;
    return `<div class="w"><span>${esc(w.en)}</span><span>${esc(w.he)} ${tag}</span></div>`;
  }).join('');
  app.innerHTML = `<div class="top"><h1>המילים</h1><button class="icon-btn" id="back">חזרה</button></div>
    <section class="panel"><p class="muted">${W.length} מילים במאגר. המאגר גדל מדי שבוע.</p><div class="list">${rows}</div></section>`;
  document.getElementById('back').onclick = home;
}

function settings(){
  app.innerHTML = `<div class="top"><h1>הגדרות</h1><button class="icon-btn" id="back">חזרה</button></div>
    <section class="panel">
      <label for="dn">מילים חדשות ביום</label>
      <select id="dn">${[10,15,20,25,30,40].map(n => `<option ${n === S.settings.dailyNew ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <label for="su">כתובת הסנכרון לגיליון</label>
      <input id="su" dir="ltr" placeholder="https://script.google.com/macros/s/.../exec" value="${esc(S.settings.syncUrl)}">
      <div class="row"><button class="btn primary" id="saveS">שמור</button><button class="btn" id="syncNow">סנכרן עכשיו</button></div>
      <p class="muted sync" id="msg"></p>
    </section>
    <section class="panel">
      <h2>גיבוי</h2>
      <p class="muted">אם הסנכרון לא עובד, אפשר להעתיק את כל הנתונים ולהדביק בשיחה.</p>
      <button class="btn" id="copy">העתק נתונים</button>
    </section>`;
  document.getElementById('back').onclick = home;
  document.getElementById('saveS').onclick = () => {
    S.settings.dailyNew = +document.getElementById('dn').value;
    S.settings.syncUrl = document.getElementById('su').value.trim();
    save(); document.getElementById('msg').textContent = 'נשמר';
  };
  document.getElementById('syncNow').onclick = async () => {
    const m = document.getElementById('msg');
    if (!S.settings.syncUrl){ m.textContent = 'קודם צריך להדביק את כתובת הסנכרון'; return; }
    // send everything again so the sheet has the full history
    if (!S.queue.length) S.queue.push({t:new Date().toISOString(), word:'__ping__', ok:1, ms:0, mode:'ping', box:0, lvl:-1, dev:S.device});
    await sync(); m.textContent = syncState === 'ok' ? 'נשלח לגיליון' : 'השליחה נכשלה. בדוק את הכתובת והחיבור לרשת';
  };
  document.getElementById('copy').onclick = async () => {
    const txt = JSON.stringify({cards:S.cards, days:S.days});
    try { await navigator.clipboard.writeText(txt); document.getElementById('copy').textContent = 'הועתק'; }
    catch(e){ const t = document.createElement('textarea'); t.value = txt; t.style.height = '120px'; document.getElementById('copy').after(t); t.select(); }
  };
}

const APP_VERSION = 4;
if ('serviceWorker' in navigator){
  // check for a new version on every open; when it takes over, reload once so the new files are used
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(r => r.update()).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && !app.querySelector('.card')){ reloaded = true; location.reload(); } });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible'){ sync(); if (!app.querySelector('.card')) home(); } });
home();
sync();
})();
