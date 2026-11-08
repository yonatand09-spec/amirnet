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
  // connectors are taught only in the live sessions: they never come up in the app, not even for review
  const sweep = now >= SWEEP_START;
  return Object.entries(S.cards).filter(([id,c]) => byId[id] && byId[id].lvl !== 0 && (c.due <= now || (sweep && !(c.learn > 0) && (c.last || 0) < SWEEP_START))).map(([id]) => id)
    .sort((a,b) => S.cards[a].due - S.cards[b].due);
}
const FAMILY_OF = {};
Object.entries(typeof FAMILIES === 'undefined' ? {} : FAMILIES).forEach(([f, ws]) => ws.forEach(w => FAMILY_OF[w] = f));
const NOTE = typeof NOTES === 'undefined' ? {} : NOTES;
const CLOZES = typeof CLOZE === 'undefined' ? {} : CLOZE;
const NEAR = {};
(typeof SIMILAR === 'undefined' ? [] : SIMILAR).forEach(g => g.forEach(x => { (NEAR[x] ||= new Set()); g.forEach(y => { if (y !== x) NEAR[x].add(y); }); }));
// New words follow ORDER: question language and words that recur in past exams first, then mid-frequency academic words, rare words last.
// Two words from the same close-meaning group are never introduced on the same day (they interfere).
const GROUP_OF = {};
(typeof SIMILAR === 'undefined' ? [] : SIMILAR).forEach((g, gi) => g.forEach(x => { (GROUP_OF[x] ||= []).push(gi); }));
const ORDERED = (typeof ORDER === 'undefined' ? W.map(w => w.id) : ORDER).filter(id => byId[id] && byId[id].lvl !== 0);
// next words from ORDER that are in no unit yet; never two words of one close-meaning group in the same unit
function newCandidates(n, unitWords = []){
  const taken = new Set(S.units.flatMap(u => u.words));
  const used = new Set(unitWords.flatMap(id => GROUP_OF[id] || []));
  const out = [];
  for (const id of ORDERED){
    if (out.length >= n) break;
    if (S.cards[id] || taken.has(id)) continue;
    const gs = GROUP_OF[id] || [];
    if (gs.some(g => used.has(g))) continue;
    gs.forEach(g => used.add(g));
    out.push(id);
  }
  return out;
}

/* ---------- units: a new pack opens every day at noon (learn afternoon and evening, sleep, practice in the morning) ---------- */
const UNIT_START = '2026-11-08';
const TEST_EVERY = 3, BRAKE_ACC = 80, BRAKE_SIZE = 25, TEST_CHUNK = 20;
// the cycle a moment belongs to is named by the date of the noon that opened it
const cycleKey = (t = Date.now()) => new Date(t - 12*3600000).toLocaleDateString('en-CA');
function quotaFor(key){
  if (key <= '2026-12-12') return 30;
  if (key <= '2026-12-16') return 15;
  return 0;                                   // 17–19.12: reviews only
}
const nextNoon = () => { const d = new Date(); d.setHours(12,0,0,0); if (d <= new Date()) d.setDate(d.getDate()+1); return d; };
function curUnit(){ return S.units[S.units.length - 1]; }
const unitLeft = u => u ? u.words.filter(id => !S.cards[id]) : [];
function rollUnits(){
  if (!S.units){
    // unit 0: every word learned before units existed
    S.units = [{n:0, key:'start', words: Object.keys(S.cards).filter(id => byId[id] && byId[id].lvl !== 0)}];
    S.tests = [];
  }
  const key = cycleKey();
  if (key < UNIT_START) return;
  const last = curUnit();
  if (last.key === key) return;
  // words of the last unit not started yet carry over to the new one, then new words fill it up to the day's size
  const carry = last.n > 0 ? unitLeft(last) : [];
  last.words = last.words.filter(id => S.cards[id]);
  let size = quotaFor(key);
  if (S.brake && size) size = Math.min(size, BRAKE_SIZE);
  const words = carry.concat(newCandidates(Math.max(0, size - carry.length), carry));
  const n = last.n + 1;
  // a cumulative test opens together with units 4, 7, 10…: it covers every unit before it
  if (n > 1 && (n - 1) % TEST_EVERY === 0) makeTest(n - 1);
  S.units.push({n, key, opened: Date.now(), words, carry: carry.length});
  save();
}
// words that passed 3 cumulative tests in a row are only sampled (about a third), so the tests stay a manageable size
function makeTest(upTo){
  if (S.tests.some(t => t.upTo === upTo)) return;
  const ids = S.units.filter(u => u.n <= upTo).flatMap(u => u.words).filter(id => S.cards[id]);
  const items = shuffle(ids.filter(id => (S.cards[id].tp || 0) < 3 || Math.random() < 1/3));
  S.tests.push({upTo, opened: Date.now(), items, ans:{}});
}
const openTest = () => S.tests.find(t => !t.done);
function testChunk(t){ return t.items.filter(id => !(id in t.ans)).slice(0, TEST_CHUNK).map(id => ({id, isNew:false})); }
function finishTestIfDone(t){
  if (t.done || t.items.some(id => !(id in t.ans))) return;
  const v = Object.values(t.ans); t.done = Date.now();
  t.acc = Math.round(100 * v.filter(Boolean).length / v.length);
  S.brake = t.acc < BRAKE_ACC;               // below 80%: the next units shrink to 25 words until a test is back above it
  save();
}
function newLeftToday(){ return unitLeft(curUnit()).length; }
function buildSession(){
  const due = dueCards();
  const fresh = unitLeft(curUnit());
  const ids = [];
  // reviews first, new words interleaved (1 new per 2 reviews)
  let di = 0, ni = 0;
  while (ids.length < SESSION_SIZE && (di < due.length || ni < fresh.length)){
    if (di < due.length) ids.push({id: due[di++], isNew:false});
    if (ids.length < SESSION_SIZE && di < due.length) ids.push({id: due[di++], isNew:false});
    if (ids.length < SESSION_SIZE && ni < Math.min(fresh.length, NEW_PER_SESSION)) ids.push({id: fresh[ni++], isNew:true});
    if (di >= due.length && ni >= Math.min(fresh.length, NEW_PER_SESSION)) break;
  }
  return ids;
}
// Successive relearning: a word counts as learned only after several correct recalls spread through the session.
// New word: 3 correct answers. After a miss: 2 more correct answers, and the word drops back to the start of the schedule.
// Exam-aware schedule: no review is pushed past 17.12, and from 13.12 every word gets one last review.
const CAP = new Date('2026-12-17T20:00:00+02:00').getTime();
const SWEEP_START = new Date('2026-12-13T00:00:00+02:00').getTime();
const LEARN_NEW = 3, LEARN_AFTER_MISS = 2, NEW_PER_SESSION = 5;
// Formats a word must pass before it can lock: recognition (English to Hebrew), production (Hebrew to English or typing),
// and context (inside a sentence). Context is required only for words that have a sentence.
const FMT_OF = m => m.startsWith('en2he') ? 'rec' : (m.startsWith('he2en') || m.startsWith('type')) ? 'prod' : (m.startsWith('cloze') || m.startsWith('ctx')) ? 'ctx' : null;
function needFmts(id){ return CLOZES[id] ? ['rec','prod','ctx'] : ['rec','prod']; }
function missingFmts(id, c){ return needFmts(id).filter(f => !(c.fmt && c.fmt[f])); }
function isLocked(id, c){ return c.box >= MASTERED_BOX && missingFmts(id, c).length === 0; }
const MAX_TIMED_MS = 60000;   // an answer over a minute (app left open) is not counted in speed
// kind: 'normal' | 'practice' | 'check'. guessed: answered right but marked "ניחשתי".
function grade(id, ok, ms, mode, kind = 'normal', guessed = false){
  const practice = kind === 'practice';
  const tObj = kind === 'test' ? openTest() : null;
  if (!S.cards[id]){ const d = dayRec(); d.newWords++; (d.grps ||= []).push(...(GROUP_OF[id] || [])); }
  const c = S.cards[id] ||= {box:0, due:0, seen:0, right:0, wrong:0, learn:LEARN_NEW, first:Date.now()};
  c.learn ||= 0; c.fmt ||= {};
  const reviewing = c.learn === 0 && c.box >= 1;   // formats count only in reviews on later days, not in the first learning round
  c.seen++; c.lastMs = ms;
  const SLOW_MS = mode.startsWith('type') ? 15000 : mode.startsWith('cloze') ? 20000 : 8000;
  if (ok && !guessed){ c.right++; const f = FMT_OF(mode); if (f && reviewing && !practice) c.fmt[f] = 1; } else if (!ok) c.wrong++;
  if (guessed){
    // a guess never moves a word forward: in learning it needs the same number of correct answers again, in review it stays where it is
    if (c.learn > 0 || practice) c.due = Date.now();
    else c.due = Date.now() + 1*DAY - 3600000;
  } else if (kind === 'check' || kind === 'test'){
    // spot check of locked words: a miss sends the word back to learning, a correct answer leaves the schedule as is
    if (!ok){ c.box = 1; c.learn = LEARN_AFTER_MISS; c.due = Date.now(); }
  } else if (practice){
    // free practice never moves a word up; a miss sends it back to learning
    if (!ok){ c.box = Math.min(c.box, 1); c.learn = Math.max(c.learn, LEARN_AFTER_MISS); c.due = Date.now(); }
  } else if (c.learn > 0){
    if (ok){
      c.learn--;
      if (c.learn === 0){ c.box = 1; c.due = Date.now() + INTERVALS[1]*DAY - 3600000; }   // learned: next check tomorrow
      else c.due = Date.now();                                                         // still learning: comes back in this session
    } else { c.learn = Math.max(c.learn, LEARN_AFTER_MISS); c.due = Date.now(); }
  } else {
    if (ok){
      // a slow correct answer is treated as shaky: the word stays at its level instead of moving up
      if (ms < SLOW_MS) c.box = Math.min(c.box + 1, INTERVALS.length - 1);
      // a word cannot lock until it has passed every format: it waits one step below and the missing format is asked next
      if (c.box >= MASTERED_BOX && missingFmts(id, c).length) c.box = MASTERED_BOX - 1;
      c.due = Date.now() + Math.max(INTERVALS[c.box], 1)*DAY - 3600000;
    } else { c.box = 1; c.learn = LEARN_AFTER_MISS; c.due = Date.now(); }
  }
  if (kind === 'test'){
    // cumulative test: every answer is kept; 3 passes in a row and the word is only sampled in later tests
    const t = tObj;
    if (t && !(id in t.ans)){ t.ans[id] = (ok && !guessed) ? 1 : 0; finishTestIfDone(t); }
    c.tp = (ok && !guessed) ? (c.tp || 0) + 1 : 0;
  }
  c.last = Date.now();
  if (Date.now() < CAP && c.due > CAP) c.due = CAP;
  const d = dayRec(); d.reviews++; if (ok && !guessed) d.correct++;
  if (ms <= MAX_TIMED_MS){ d.ms += ms; d.timed = (d.timed ?? 0) + 1; }
  touchStreak();
  const tag = kind === 'normal' ? '' : kind === 'test' ? `test${tObj ? tObj.upTo : ''}-` : kind + '-';
  S.queue.push({t:new Date().toISOString(), word:id, ok:(ok && !guessed)?1:0, ms, mode: tag + mode + (guessed ? '>guess' : ''), box:c.box, lvl:byId[id].lvl, dev:S.device});
  save();
  return kind !== 'check' && kind !== 'test' && (c.learn > 0 || guessed);   // true: show it again later in this session
}
function practiceSet(){
  // words still settling (learned in the last days or not yet locked), weakest first
  return shuffle(Object.entries(S.cards).filter(([id,c]) => byId[id] && byId[id].lvl !== 0 && !isLocked(id, c))
    .sort((a,b) => (a[1].right/a[1].seen) - (b[1].right/b[1].seen)).slice(0, 30)).slice(0, SESSION_SIZE).map(([id]) => ({id, isNew:false}));
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
  const mastered = cards.filter(([id,c]) => isLocked(id, c)).length;
  const learning = cards.length - mastered;
  let r = 0, ok = 0, ms = 0;
  let tn = 0;
  for (let k = 0; k < 7; k++){ const d = new Date(Date.now() - k*DAY).toLocaleDateString('en-CA'); const x = S.days[d]; if (x){ r += x.reviews; ok += x.correct; ms += x.ms; tn += (x.timed ?? x.reviews); } }
  const levels = [0,1,2].map(l => {
    const total = W.filter(w => w.lvl === l).length;
    const cs = cards.filter(([id]) => byId[id].lvl === l);
    return {total, mastered: cs.filter(([id,c]) => isLocked(id, c)).length, started: cs.length,
            acc: (() => { const s = cs.reduce((a,[,c]) => [a[0]+c.right, a[1]+c.seen], [0,0]); return s[1] ? Math.round(100*s[0]/s[1]) : null; })()};
  });
  return {mastered, learning, total: W.length, acc7: r ? Math.round(100*ok/r) : null, avgMs: tn ? Math.round(ms/tn) : null, due: dueCards().length, streak: streak(), levels};
}

/* ---------- sync to Google Sheet (Apps Script web app) ---------- */
let syncState = '';
async function sync(force = false){
  const url = S.settings.syncUrl;
  if (!url || !navigator.onLine || (!S.queue.length && !force)) return;
  const batch = S.queue.slice(0, 200);
  const st = stats();
  const payload = {events: batch, summary: {t: new Date().toISOString(), dev: S.device, mastered: st.mastered, learning: st.learning, total: st.total, acc7: st.acc7, avgMs: st.avgMs, streak: st.streak, due: st.due,
    levels: st.levels.map(l => `${l.mastered}/${l.total}`).join(' · ') + ` · unit ${curUnit()?.n ?? 0} left ${newLeftToday()}` + (S.tests?.length ? ` · tests ${S.tests.filter(x => x.done).map(x => x.upTo + ':' + x.acc + '%').join(',')}` : '')}};
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
  rollUnits();
  const st = stats();
  const u = curUnit(), left = newLeftToday(), t = openTest();
  const hrs = Math.max(1, Math.round((nextNoon() - Date.now()) / 3600000));
  const unitLine = u.n === 0 ? `היחידה הראשונה נפתחת היום ב־12:00`
    : !u.words.length ? `היום רק חזרות, בלי מילים חדשות · מתחזקים את מה שכבר יש`
    : left ? `נשארו <b>${left}</b> מתוך ${u.words.length} מילים חדשות${u.carry ? ` (${u.carry} עברו מהיחידה הקודמת)` : ''} · יחידה חדשה בעוד ${hrs} ${hrs === 1 ? 'שעה' : 'שעות'}`
    : `סיימת את כל ${u.words.length} המילים של היחידה · יחידה חדשה בעוד ${hrs} ${hrs === 1 ? 'שעה' : 'שעות'}`;
  const tDone = t ? Object.keys(t.ans).length : 0;
  const lastT = S.tests.filter(x => x.done).slice(-1)[0];
  const ses = buildSession();
  const examDays = Math.ceil((new Date('2026-12-20T08:00:00+02:00') - Date.now()) / DAY);
  const syncLine = !S.settings.syncUrl ? '<span class="sync muted">הסנכרון עוד לא מוגדר</span>'
    : S.queue.length ? `<span class="sync">${S.queue.length} תשובות ממתינות לסנכרון</span>`
    : `<span class="sync ok">מסונכרן${S.lastSync ? ' · ' + new Date(S.lastSync).toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}) : ''}</span>`;
  app.innerHTML = `
    <div class="top"><h1>אמירנט</h1><button class="icon-btn" id="setBtn">הגדרות</button></div>
    <p class="muted">${examDays > 0 ? `עוד ${examDays} ימים לבחינה` : 'יום הבחינה'} · רצף של ${st.streak} ${st.streak === 1 ? 'יום' : 'ימים'}</p>
    <section class="panel unit">
      <div class="row" style="justify-content:space-between"><h2>${u.n === 0 ? 'יחידה 0' : 'יחידה ' + u.n}</h2>${S.brake ? '<span class="pill">25 מילים ביחידה · עד שהמבחן הבא יעבור 80%</span>' : ''}</div>
      <p>${unitLine}</p>
      ${u.words.length ? `<div class="bar"><span class="m" style="width:${100*(u.words.length-left)/u.words.length}%"></span></div>` : ''}
      ${lastT ? `<p class="muted" style="font-size:14px">מבחן מצטבר אחרון (יחידות 0–${lastT.upTo}): ${lastT.acc}%</p>` : ''}
    </section>
    ${t ? `<button class="big-btn" id="testBtn" style="background:var(--ink);color:var(--paper)">מבחן מצטבר · יחידות 0–${t.upTo} · ${tDone}/${t.items.length}</button>
      <p class="muted" style="font-size:14px;margin-top:-8px">אפשר לחלק ליומיים. כל פעם ${TEST_CHUNK} מילים, ההתקדמות נשמרת.</p>` : ''}
    ${checkDue() && !t ? '<button class="btn primary" id="checkBtn">בדיקת פתע שבועית · מילים נעולות</button>' : ''}
    ${ses.length ? `<button class="big-btn" id="go">התחל · ${ses.length} מילים</button>` : '<p class="muted" id="doneNote">סיימת את מה שמתוכנן להיום. אפשר להמשיך:</p>'}
    <section class="panel">
      <div class="stats">
        <div class="stat"><span class="n">${st.mastered}</span><span class="l">מילים שננעלו</span></div>
        <div class="stat"><span class="n">${st.learning}</span><span class="l">בתהליך</span></div>
        <div class="stat"><span class="n">${fmtPct(st.acc7)}</span><span class="l">דיוק, 7 ימים</span></div>
        <div class="stat"><span class="n">${st.avgMs ? (st.avgMs/1000).toFixed(1) : '–'}</span><span class="l">שניות לתשובה</span></div>
      </div>
      <p class="muted" style="font-size:14px">לחזרה עכשיו: ${st.due}</p>
    </section>
    <section class="panel">
      <h2>התקדמות לפי רמה</h2>
      <div class="levels">${st.levels.map((l,i) => i === 0 ? '' : `
        <div class="lv"><div class="head"><span>${LEVEL_NAMES[i]}</span><span class="muted">${l.mastered}/${l.total}${l.acc != null ? ' · דיוק ' + l.acc + '%' : ''}</span></div>
        <div class="bar"><span class="m" style="width:${100*l.mastered/l.total}%"></span><span class="s" style="width:${100*(l.started-l.mastered)/l.total}%"></span></div></div>`).join('')}
      </div>
      <div class="row">${stubborn().length ? `<button class="btn" id="stubBtn">מילים עקשניות · ${stubborn().length}</button>` : ''}<button class="btn" id="listBtn">כל המילים</button></div>
    </section>
    <div class="row" style="justify-content:space-between">${syncLine}<span class="sync muted">גרסה ${APP_VERSION}</span></div>`;
  if (ses.length) document.getElementById('go').onclick = () => session(ses);
  else moreButtons(document.getElementById('doneNote'));
  document.getElementById('setBtn').onclick = settings;
  document.getElementById('listBtn').onclick = wordList;
  const sb = document.getElementById('stubBtn'); if (sb) sb.onclick = stubbornList;
  const cb = document.getElementById('checkBtn'); if (cb) cb.onclick = () => session(checkSet(), 'check');
  const tb = document.getElementById('testBtn'); if (tb) tb.onclick = () => session(testChunk(t), 'test');
}

function session(items, kind = 'normal'){
  if (kind === true) kind = 'practice';
  const practice = kind === 'practice';
  const results = [];
  let i = 0, alive = true;   // alive turns false when the user leaves, so a pending timer never draws a card over the home screen
  const show = () => {
    if (i >= items.length) return finish();
    const {id, isNew} = items[i];
    const w = byId[id];
    const c = S.cards[id];
    // new and weak words: English to Hebrew; stronger words: also Hebrew to English
    // well-known words: produce the English yourself (recall beats recognition)
    // a word still being learned alternates direction on its repeat appearances
    const pick = a => a[Math.floor(Math.random() * a.length)];
    const missing = c ? missingFmts(id, c) : [];
    const ctxMode = () => pick(['cloze', 'ctx']);
    const mode = (kind === 'check' || kind === 'test') ? (CLOZES[id] ? ctxMode() : pick(kind === 'test' ? ['en2he', 'he2en', 'type'] : ['he2en', 'type']))
      : (isNew || !c) ? 'en2he'
      : (c.learn > 0 || c.box < 2) ? (c.seen % 2 ? 'he2en' : 'en2he')
      // from the second review on, a format the word has not passed yet is asked first
      : missing.length ? ({rec:'en2he', prod: c.box >= 3 ? pick(['he2en','type']) : 'he2en', ctx: ctxMode()})[pick(missing)]
      : (CLOZES[id] && Math.random() < 0.6) ? ctxMode()
      : (c.box >= 3 && Math.random() < 0.5) ? 'type' : (Math.random() < 0.5 ? 'en2he' : 'he2en');
    if (mode === 'type') return typeCard(w, kind === 'check' || kind === 'test');
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
        ${kind === 'check' ? '<span class="pill" style="justify-self:center">בדיקת פתע</span>' : ''}
        ${kind === 'test' ? '<span class="pill" style="justify-self:center">מבחן מצטבר</span>' : ''}
        ${mode === 'cloze' ? `<span class="pill" style="justify-self:center">השלמת משפט</span><div class="prompt-cloze">${esc(CLOZES[id]).replace('____', '<span class="blank">______</span>')}</div>`
          : mode === 'ctx' ? `<span class="pill" style="justify-self:center">מה המילה המודגשת אומרת כאן?</span><div class="prompt-cloze">${esc(CLOZES[id]).replace('____', '<b class="hl">' + esc(w.en) + '</b>')}</div>`
          : mode === 'en2he' ? `<div class="prompt-en">${esc(w.en)}</div>` : `<div class="prompt-he">${esc(w.he)}</div>`}
        ${(mode === 'cloze' || mode === 'ctx' || kind === 'check' || kind === 'test') ? '' : `<div class="hint">${POS_NAMES[w.pos]}</div>`}
      </div>
      <div class="opts">${opts.map((o,k) => `<button class="opt ${(mode === 'en2he' || mode === 'ctx') ? '' : 'en'}" data-id="${esc(o.id)}"><span class="k">${k+1}</span><span>${esc((mode === 'en2he' || mode === 'ctx') ? o.he : o.en)}</span></button>`).join('')}
        <button class="opt idk" data-id="__idk__"><span class="k">?</span><span>לא יודע</span></button></div>
      <div class="feedback" id="fb"></div>`;
    document.getElementById('quit').onclick = () => { alive = false; sync(); home(); };
    app.querySelectorAll('.opt').forEach(b => b.onclick = () => {
      const ms = Math.round(performance.now() - t0);
      const ok = b.dataset.id === id;   // "לא יודע" counts as a miss, so a lucky guess never locks a word
      app.querySelectorAll('.opt').forEach(x => { x.disabled = true; if (x.dataset.id === id) x.classList.add('right'); });
      if (!ok && b.dataset.id !== '__idk__') b.classList.add('wrong');
      // a wrong pick is logged with the word it was confused with
      const picked = ok ? mode : mode + '>' + (b.dataset.id === '__idk__' ? 'idk' : b.dataset.id);
      if (!ok){ requeue(id, grade(id, false, ms, picked, kind), false); results.push(false); after(w, false); return; }
      // a correct answer is graded when the card moves on, so "ניחשתי" can still change it
      after(w, true, guessed => { requeue(id, grade(id, true, ms, picked, kind, guessed), !guessed); results.push(!guessed); });
    });
  };
  // a word that still needs correct answers comes back a few cards later (sooner after a miss)
  const requeue = (id, again, ok) => {
    if (!again) return;
    // free practice shows a word at most twice, so it never loops
    if (practice && items.filter(x => x.id === id).length >= 2) return;
    const pos = Math.min(i + 1 + (ok ? 4 : 2), items.length);
    items.splice(pos, 0, {id, isNew:false});
  };
  // shared feedback: correct answers move on quickly unless there is a usage note worth reading
  // after a correct answer there is a short window to mark it as a guess; the card moves on by itself
  const after = (w, ok, commit) => {
    const fb = document.getElementById('fb');
    const note = NOTE[w.id] ? `<p class="note">${esc(NOTE[w.id])}</p>` : '';
    const trans = `<p class="note" dir="auto">${esc(w.en)} = ${esc(w.he)}</p>`;
    let done = false;
    const go = (guessed = false) => { if (done) return; done = true; if (commit) commit(guessed); if (!alive) return; i++; show(); };
    if (ok && commit){
      fb.innerHTML = `<div class="row" style="width:100%;justify-content:space-between">${note || trans}<button class="btn" id="guess">ניחשתי</button></div>`;
      document.getElementById('guess').onclick = () => go(true);
      setTimeout(() => go(false), note ? 3500 : 1600);
      return;
    }
    if (ok){ setTimeout(() => go(false), 650); return; }
    fb.innerHTML = `<div style="display:grid;gap:8px;width:100%">${note}<button class="btn primary" id="next">${esc(w.en)} = ${esc(w.he)} · המשך</button></div>`;
    const nx = document.getElementById('next'); nx.focus(); nx.onclick = () => go(false);
  };
  const typeCard = (w, noHint = false) => {
    const t0 = performance.now();
    const len = w.en.replace(/[^a-z]/gi, '').length;
    app.innerHTML = `
      <div class="top"><button class="icon-btn" id="quit">יציאה</button><span class="muted">${i+1}/${items.length}</span></div>
      <div class="progress">${items.map((_,k) => `<i class="${k < i ? (results[k] ? 'ok' : 'no') : k === i ? 'cur' : ''}"></i>`).join('')}</div>
      <div class="card">
        <span class="pill" style="justify-self:center">כתוב באנגלית</span>
        <div class="prompt-he">${esc(w.he)}</div>
        ${noHint ? '' : `<div class="hint">מתחילה ב־<b dir="ltr">${esc(w.en[0])}</b> · ${len} אותיות</div>`}
      </div>
      <form id="tf" class="opts" autocomplete="off">
        <input id="ans" dir="ltr" class="type-in" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="התשובה באנגלית">
        <button class="btn primary" type="submit">בדוק</button>
      </form>
      <div class="feedback" id="fb"></div>`;
    document.getElementById('quit').onclick = () => { alive = false; sync(); home(); };
    const inp = document.getElementById('ans'); inp.focus();
    document.getElementById('tf').onsubmit = (e) => {
      e.preventDefault();
      if (inp.disabled) return;
      const norm = s => s.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
      const ok = norm(inp.value) === norm(w.en);
      const ms = Math.round(performance.now() - t0);
      inp.disabled = true; inp.classList.add(ok ? 'right' : 'wrong');
      requeue(w.id, grade(w.id, ok, ms, 'type', kind), ok); results.push(ok);
      after(w, ok);
    };
  };
  const finish = () => {
    const ok = results.filter(Boolean).length;
    if (kind === 'check'){ S.lastCheck = Date.now(); save(); }
    sync();
    if (kind === 'test') return testFinish(ok, results.length);
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
    if (!next.length){ again.remove(); moreButtons(document.getElementById('back')); }
    else again.onclick = () => session(next);
    document.getElementById('back').onclick = home;
  };
  show();
}

function testFinish(ok, n){
  const t = S.tests.slice().reverse().find(x => x.items.length && Object.keys(x.ans).length) || {};
  const answered = Object.keys(t.ans || {}).length;
  const missed = Object.entries(t.ans || {}).filter(([,v]) => !v).map(([id]) => id);
  const fin = !!t.done;
  app.innerHTML = `
    <div class="panel done">
      <h2>${fin ? 'המבחן המצטבר הושלם' : 'חלק מהמבחן הושלם'}</h2>
      <div class="n">${fin ? t.acc + '%' : ok + '/' + n}</div>
      <p class="muted">${fin ? (t.acc >= BRAKE_ACC ? 'עברת את רף ה־80%. ממשיכים במלוא הקצב.' : 'מתחת ל־80%. היחידות הבאות יהיו של 25 מילים עד שהמבחן הבא יעבור את הרף. זה לא צעד אחורה, זה מה שמחזיק את הקצב לאורך זמן.')
        : `ענית על ${answered} מתוך ${t.items.length}. אפשר להמשיך עכשיו או מחר.`}</p>
    </div>
    ${missed.length ? `<section class="panel"><h2>מילים שטעית בהן · חוזרות ללמידה</h2><div class="list">${missed.map(id => `<div class="w"><span>${esc(byId[id].en)}</span><span>${esc(byId[id].he)}</span></div>`).join('')}</div></section>` : ''}
    ${!fin ? '<button class="big-btn" id="more">עוד ' + TEST_CHUNK + ' מילים מהמבחן</button>' : ''}
    <button class="btn" id="back">למסך הבית</button>`;
  if (!fin) document.getElementById('more').onclick = () => session(testChunk(t), 'test');
  document.getElementById('back').onclick = home;
}

// after the planned work: learn more new words, or practice words that are not locked yet
function moreButtons(anchor){
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid;gap:10px';
  const hasNew = curUnit().n > 0 && quotaFor(cycleKey()) > 0 && newCandidates(1).length > 0;
  const prac = practiceSet();
  wrap.innerHTML = `${hasNew ? '<button class="big-btn" id="moreNew">עוד 10 מילים · מקדימים את היחידה הבאה</button>' : ''}
    ${prac.length ? `<button class="btn" id="freePrac">תרגול חופשי · ${prac.length} מילים שעוד לא ננעלו</button>` : ''}`;
  anchor.after(wrap);
  if (hasNew) wrap.querySelector('#moreNew').onclick = () => { const u = curUnit(); u.words.push(...newCandidates(10, u.words)); save(); session(buildSession()); };
  if (prac.length) wrap.querySelector('#freePrac').onclick = () => session(prac, 'practice');
}

// words missed 3 times or more: we build a memory image for them together in the sessions
// weekly spot check: 10 random locked words, inside a sentence where possible, no hints
function checkSet(){ return shuffle(Object.entries(S.cards).filter(([id,c]) => byId[id] && byId[id].lvl !== 0 && isLocked(id, c)).map(([id]) => id)).slice(0, 10).map(id => ({id, isNew:false})); }
function checkDue(){ return checkSet().length >= 5 && Date.now() - (S.lastCheck || 0) >= 7*DAY; }
function stubborn(){ return Object.entries(S.cards).filter(([id,c]) => byId[id] && byId[id].lvl !== 0 && c.wrong >= 3 && !isLocked(id, c)).sort((a,b) => b[1].wrong - a[1].wrong); }
function stubbornList(){
  const rows = stubborn().map(([id,c]) => `<div class="w"><span>${esc(byId[id].en)}</span><span>${esc(byId[id].he)} <span class="pill">${c.wrong} טעויות</span></span></div>`).join('');
  app.innerHTML = `<div class="top"><h1>מילים עקשניות</h1><button class="icon-btn" id="back">חזרה</button></div>
    <section class="panel"><p class="muted">מילים שטעית בהן 3 פעמים ומעלה. בישיבה נבנה לכל אחת תמונת זיכרון.</p><div class="list">${rows}</div></section>`;
  document.getElementById('back').onclick = home;
}

function wordList(){
  const rows = W.slice().sort((a,b) => a.lvl - b.lvl || a.i - b.i).map(w => {
    const c = S.cards[w.id];
    const tag = !c ? '' : isLocked(w.id, c) ? '<span class="pill" style="color:var(--good);border-color:var(--good)">ננעלה</span>' : `<span class="pill">${c.right}/${c.seen}</span>`;
    return `<div class="w"><span>${esc(w.en)}</span><span>${esc(w.he)} ${tag}</span></div>`;
  }).join('');
  app.innerHTML = `<div class="top"><h1>המילים</h1><button class="icon-btn" id="back">חזרה</button></div>
    <section class="panel"><p class="muted">${W.length} מילים במאגר. המאגר גדל מדי שבוע.</p><div class="list">${rows}</div></section>`;
  document.getElementById('back').onclick = home;
}

function settings(){
  app.innerHTML = `<div class="top"><h1>הגדרות</h1><button class="icon-btn" id="back">חזרה</button></div>
    <section class="panel">
      <p class="muted">גודל היחידה נקבע לפי לוח הזמנים: 30 מילים עד 12.12, 15 עד 16.12, ומ־17.12 רק חזרות.</p>
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
    S.settings.syncUrl = document.getElementById('su').value.trim();
    save(); document.getElementById('msg').textContent = 'נשמר';
  };
  document.getElementById('syncNow').onclick = async () => {
    const m = document.getElementById('msg');
    if (!S.settings.syncUrl){ m.textContent = 'קודם צריך להדביק את כתובת הסנכרון'; return; }
    // sends pending answers and a summary row; no empty test rows
    await sync(true); m.textContent = syncState === 'ok' ? 'נשלח לגיליון' : 'השליחה נכשלה. בדוק את הכתובת והחיבור לרשת';
  };
  document.getElementById('copy').onclick = async () => {
    const txt = JSON.stringify({cards:S.cards, days:S.days, units:S.units, tests:S.tests});
    try { await navigator.clipboard.writeText(txt); document.getElementById('copy').textContent = 'הועתק'; }
    catch(e){ const t = document.createElement('textarea'); t.value = txt; t.style.height = '120px'; document.getElementById('copy').after(t); t.select(); }
  };
}

const APP_VERSION = 8;
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
