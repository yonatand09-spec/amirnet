/* Amirnet vocabulary trainer — spaced repetition, offline, syncs a log to a Google Sheet. */
(() => {
const KEY = 'amirnet.v1';
const DAY = 86400000;
const INTERVALS = [0, 1, 2, 4, 7, 14, 30, 60];   // days per box
const MASTERED_BOX = 4;
const SESSION_SIZE = 12;
const LEVEL_NAMES = ['מילות קישור', 'אקדמי', 'מתקדם'];
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
function newCandidates(){
  // connectors first, then core, then advanced; inside a level keep list order
  return W.filter(w => !S.cards[w.id]).sort((a,b) => a.lvl - b.lvl || a.i - b.i).map(w => w.id);
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
  if (!S.cards[id]) dayRec().newWords++;
  const c = S.cards[id] ||= {box:0, due:0, seen:0, right:0, wrong:0, first:Date.now()};
  c.seen++; c.lastMs = ms;
  if (ok){ c.right++; c.box = Math.min(c.box + 1, INTERVALS.length - 1); c.due = Date.now() + INTERVALS[c.box]*DAY - 3600000; }
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
    <div class="row">${syncLine}</div>`;
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
    const mode = (isNew || !c || c.box < 2 || Math.random() < 0.5) ? 'en2he' : 'he2en';
    // distractors must not share a meaning word with the answer (e.g. "למרות" vs "למרות ש")
    const toks = s => s.split(/[\s,;]+/).filter(t => t.length >= 3);
    const wt = new Set(toks(w.he));
    const pool = W.filter(x => x.id !== id && x.pos === w.pos && !toks(x.he).some(t => wt.has(t)));
    const near = shuffle(pool.filter(x => x.lvl === w.lvl)).slice(0, 3);
    const distract = near.length >= 3 ? near : shuffle(pool).slice(0, 3);
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
      <div class="opts">${opts.map((o,k) => `<button class="opt ${mode === 'he2en' ? 'en' : ''}" data-id="${esc(o.id)}"><span class="k">${k+1}</span><span>${esc(mode === 'en2he' ? o.he : o.en)}</span></button>`).join('')}</div>
      <div class="feedback" id="fb"></div>`;
    document.getElementById('quit').onclick = () => { sync(); home(); };
    app.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const ms = Math.round(performance.now() - t0);
      const ok = b.dataset.id === id;
      app.querySelectorAll('.opt').forEach(x => { x.disabled = true; if (x.dataset.id === id) x.classList.add('right'); });
      if (!ok) b.classList.add('wrong');
      grade(id, ok, ms, mode);
      results.push(ok);
      if (!ok) items.push({id, isNew:false});   // see it again before the session ends
      const fb = document.getElementById('fb');
      if (ok){ setTimeout(() => { i++; show(); }, 650); }
      else {
        fb.innerHTML = `<button class="btn primary" id="next">${esc(w.en)} = ${esc(w.he)} · המשך</button>`;
        document.getElementById('next').onclick = () => { i++; show(); };
      }
    });
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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible'){ sync(); if (!app.querySelector('.card')) home(); } });
home();
sync();
})();
