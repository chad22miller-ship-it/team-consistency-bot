/**
 * Consistency Compounds - TEAM Accountability Bot (free, GitHub Actions edition)
 * -----------------------------------------------------------------------------
 * One bot, your whole team. Free on GitHub Actions, 24/7, no computer.
 *
 * CONTROL IS PIN-GATED:
 *   - Anyone who messages the bot can ONLY check in (reply "yes"). They cannot change anything.
 *   - To control the bot (see roster, remove people) you must unlock with the PIN:
 *       send:  /admin <PIN>
 *   - Reps without the PIN have zero ability to alter settings or the roster.
 *
 * - Auto-registers each rep the first time they message (tap Start + say hi).
 * - Daily: asks every rep, nudges hourly if quiet, gives up after 12h.
 * - "yes" -> personalized team-culture win.
 * - Admins get an instant alert when someone new joins.
 *
 * Messaging is TEAM culture/values only - no personal info about anyone.
 * Coach lines: Gemini (free) -> Anthropic (if set) -> built-in templates. Never silent.
 * Zero dependencies (Node built-in fetch/fs).
 */

const fs = require('fs');
const path = require('path');

// ---------- Config ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MANAGER_CHAT_ID = String(process.env.MANAGER_CHAT_ID || '');   // owner: always an admin
const ADMIN_PIN = String(process.env.ADMIN_PIN || '');               // unlocks admin for anyone who sends it
const CHECKIN_URL = process.env.CHECKIN_URL || 'https://consistencycompounds.vercel.app/';
const TEAM_NAME = process.env.TEAM_NAME || 'Consistency Compounds';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';
const ASK_HOUR = parseInt(process.env.ASK_HOUR || '9', 10);
const ASK_MINUTE = parseInt(process.env.ASK_MINUTE || '0', 10);
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const SMOKE_TEST = process.env.SMOKE_TEST === '1';

const NAG_INTERVAL_MS = 60 * 60 * 1000;
const GIVE_UP_MS = 12 * 60 * 60 * 1000;
const API = `https://api.telegram.org/bot${TOKEN}`;
const pad = (n) => String(n).padStart(2, '0');

// ---------- State ----------
const DEFAULT_STATE = { reps: {}, admins: [], tgOffset: 0, recent: [] };
let state = { ...DEFAULT_STATE };
function newRep(name) { return { name, joinedAt: Date.now(), phase: 'idle', askedAt: null, lastNagAt: null, lastAskedDate: null, lastConfirmedDate: null }; }
function loadState() {
  try { if (fs.existsSync(STATE_FILE)) state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; }
  catch (e) { console.error('state load failed, using defaults:', e.message); }
  if (!state.reps) state.reps = {};
  if (!state.admins) state.admins = [];
  if (!state.recent) state.recent = [];
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n'); }
  catch (e) { console.error('state save failed:', e.message); }
}
function nowParts() {
  const d = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const [h, m] = hm.split(':').map((n) => parseInt(n, 10));
  return { date, h: h % 24, m };
}
function isAdmin(id) { return (MANAGER_CHAT_ID && id === MANAGER_CHAT_ID) || state.admins.includes(id); }

// ---------- Team-culture voice (NO personal data about anyone) ----------
function coachSystem() {
  return `You are the coach voice for a sales team called ${TEAM_NAME} (Tony Robbins energy: direct, motivating, zero fluff). Team values ONLY: No excuses. Take 100% responsibility. Simplify to multiply. Do what's best for people. The point: every rep shows up daily and keeps their word to the team. NEVER reference anyone's family, kids, money, or personal life. Keep it to ONE or TWO sentences, plain text, no markdown. Do not repeat any of these recent lines: ${JSON.stringify(state.recent)}.`;
}
const PROMPTS = {
  ask: (name) => `Greet ${name} by first name and ask, with warm but direct coach energy, whether they've done their daily check-in yet. You MUST include this exact link: ${CHECKIN_URL} and tell them to reply yes or no.`,
  nudge: (name) => `Nudge ${name} by first name (they haven't confirmed yet) to do their daily check-in. Direct coach energy, a little fire, no guilt-tripping. You MUST include this exact link: ${CHECKIN_URL} and tell them to reply yes or no.`,
  win: (name) => `${name} just confirmed their check-in. Write a 1-2 sentence celebration that MUST start with exactly "This is why you win:" then tie it to a ${TEAM_NAME} team value (consistency, no excuses, 100% responsibility, showing up for the team). Fresh angle.`
};
const TEMPLATES = {
  ask: (name) => [
    `${name}, did you log your check-in yet today? No excuses, no exceptions: ${CHECKIN_URL} - reply yes or no.`,
    `${name}, the team that shows up daily wins daily. Check-in done? ${CHECKIN_URL} - yes or no.`,
    `New day, ${name}. Have you done your check-in at ${CHECKIN_URL}? Reply yes or no.`
  ],
  nudge: (name) => [
    `Still waiting on you, ${name}. Knock out your check-in: ${CHECKIN_URL}. Yes or no?`,
    `${name}, 100% responsibility means no skipping. Check-in at ${CHECKIN_URL} - yes or no?`,
    `Two minutes, ${name} - don't let the streak break. ${CHECKIN_URL}. Reply yes or no.`
  ],
  win: (name) => [
    `This is why you win: you took 100% responsibility and showed up - that's the standard that compounds into a team that can't be beat.`,
    `This is why you win: no excuses, just execution. Keep stacking days like this, ${name}.`,
    `This is why you win: ${name}, you kept your word to the team today - that's how ${TEAM_NAME} is built.`
  ]
};
function pickTemplate(kind, name) {
  const pool = TEMPLATES[kind](name);
  const unused = pool.filter((m) => !state.recent.includes(m));
  const arr = unused.length ? unused : pool;
  return arr[Math.floor(Math.random() * arr.length)];
}
async function generateGemini(kind, name) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system_instruction: { parts: [{ text: coachSystem() }] }, contents: [{ role: 'user', parts: [{ text: PROMPTS[kind](name) }] }], generationConfig: { maxOutputTokens: 300, temperature: 1.0, thinkingConfig: { thinkingBudget: 0 } } }) });
  const j = await r.json();
  const cand = (j.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('gemini empty: ' + JSON.stringify(j).slice(0, 160));
  return text;
}
async function generateAnthropic(kind, name) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: coachSystem(), messages: [{ role: 'user', content: PROMPTS[kind](name) }] }) });
  const j = await r.json();
  const text = (j.content || []).map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('anthropic empty');
  return text;
}
async function generate(kind, name) {
  try {
    if (GEMINI_API_KEY) return await generateGemini(kind, name);
    if (ANTHROPIC_API_KEY) return await generateAnthropic(kind, name);
  } catch (e) { console.error('AI failed, template:', e.message); }
  return pickTemplate(kind, name);
}

// ---------- Telegram ----------
async function tgRaw(chatId, text) {
  try {
    const r = await fetch(`${API}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
    const j = await r.json();
    if (!j.ok) throw new Error(JSON.stringify(j));
    return true;
  } catch (e) { console.error('send failed to', chatId, ':', e.message); return false; }
}
async function tgSend(chatId, kind, name) {
  const text = await generate(kind, name);
  const ok = await tgRaw(chatId, text);
  if (ok) { state.recent = [text, ...state.recent].slice(0, 20); console.log(`sent ${kind} -> ${name} (${chatId})`); }
}
async function notifyAdmins(text) {
  const ids = new Set();
  if (MANAGER_CHAT_ID) ids.add(MANAGER_CHAT_ID);
  for (const a of state.admins) ids.add(a);
  for (const i of ids) await tgRaw(i, text);
}

async function handleUpdate(u) {
  const msg = u.message || u.edited_message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;
  const id = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const low = text.toLowerCase();
  const first = (msg.from && (msg.from.first_name || msg.from.username)) || 'there';
  const { date } = nowParts();

  // --- PIN unlock (anyone can attempt; only correct PIN grants control) ---
  if (low.startsWith('/admin')) {
    const given = text.split(/\s+/)[1] || '';
    if (ADMIN_PIN && given === ADMIN_PIN) {
      if (!state.admins.includes(id)) state.admins.push(id);
      if (state.reps[id]) delete state.reps[id]; // admins aren't check-in reps
      await tgRaw(id, `\u{1F513} Admin unlocked. Commands: /roster (see team), /remove <name>, /logout.`);
    } else {
      await tgRaw(id, `\u{274C} Wrong PIN.`);
    }
    return;
  }

  // --- Admins only: control commands ---
  if (isAdmin(id)) {
    if (low === '/roster') {
      const list = Object.values(state.reps).map((r) => `• ${r.name}${r.lastConfirmedDate === date ? ' ✅' : ''}`).join('\n') || '(no reps yet)';
      await tgRaw(id, `${TEAM_NAME} roster (${Object.keys(state.reps).length}):\n${list}`);
    } else if (low.startsWith('/remove')) {
      const q = text.split(/\s+/).slice(1).join(' ').toLowerCase();
      const match = Object.entries(state.reps).find(([rid, r]) => r.name.toLowerCase() === q || rid === q);
      if (match) { delete state.reps[match[0]]; await tgRaw(id, `Removed ${match[1].name}.`); }
      else await tgRaw(id, `No rep matching "${q}". Use /roster for names.`);
    } else if (low === '/logout') {
      state.admins = state.admins.filter((a) => a !== id);
      await tgRaw(id, id === MANAGER_CHAT_ID ? 'You are the owner - you keep control.' : 'Logged out of admin.');
    } else if (['/start', '/ping', 'ping', '/help', '/test'].includes(low)) {
      await tgRaw(id, `You're an admin of ${TEAM_NAME}. Commands: /roster, /remove <name>, /logout.`);
    }
    return;
  }

  // --- Everyone else = a rep. They can ONLY check in. ---
  if (low.startsWith('/roster') || low.startsWith('/remove') || low === '/logout') {
    await tgRaw(id, `\u{1F512} That's admin-only. You're all set to just reply "yes" to your daily check-in.`);
    return;
  }
  if (!state.reps[id]) {
    state.reps[id] = newRep(first);
    await tgRaw(id, `You're in, ${first}! ${TEAM_NAME} runs a daily check-in - I'll ask each morning, you reply "yes" when it's done. No excuses, we win together.`);
    await notifyAdmins(`\u{1F195} New rep joined ${TEAM_NAME}: ${first}${msg.from && msg.from.username ? ` (@${msg.from.username})` : ''}. Team size: ${Object.keys(state.reps).length}.`);
    return;
  }
  const rep = state.reps[id];
  if (rep.name !== first && first !== 'there') rep.name = first;
  if (['/ping', 'ping', '/test', '/start'].includes(low)) { await tgRaw(id, `Online, ${rep.name}. Daily check-in lands at ${pad(ASK_HOUR)}:${pad(ASK_MINUTE)} ${TIMEZONE}. Reply "yes" when it's done.`); return; }
  if (rep.phase === 'awaiting' && (!rep.askedAt || msg.date * 1000 >= rep.askedAt) && low.includes('yes') && rep.lastConfirmedDate !== date) {
    rep.phase = 'idle'; rep.askedAt = null; rep.lastNagAt = null; rep.lastConfirmedDate = date;
    await tgSend(id, 'win', rep.name);
  }
}

async function runOnce() {
  loadState();
  const { date, h, m } = nowParts();
  const now = Date.now();
  try {
    const r = await fetch(`${API}/getUpdates?timeout=0&offset=${state.tgOffset || 0}`);
    const j = await r.json();
    if (j.ok && Array.isArray(j.result)) for (const u of j.result) { state.tgOffset = u.update_id + 1; await handleUpdate(u); }
  } catch (e) { console.error('getUpdates failed:', e.message); }

  const pastAsk = h > ASK_HOUR || (h === ASK_HOUR && m >= ASK_MINUTE);
  for (const [id, rep] of Object.entries(state.reps)) {
    if (rep.phase !== 'awaiting') {
      if (rep.lastAskedDate !== date && rep.lastConfirmedDate !== date && pastAsk) {
        rep.lastAskedDate = date; rep.phase = 'awaiting'; rep.askedAt = now; rep.lastNagAt = now;
        await tgSend(id, 'ask', rep.name);
      }
    } else {
      const sinceAsk = now - (rep.askedAt || now);
      const sinceNag = now - (rep.lastNagAt || now);
      if (sinceAsk > GIVE_UP_MS) { rep.phase = 'idle'; rep.askedAt = null; rep.lastNagAt = null; }
      else if (sinceNag >= NAG_INTERVAL_MS) { rep.lastNagAt = now; await tgSend(id, 'nudge', rep.name); }
    }
  }

  saveState();
  console.log(`run complete @ ${date} ${pad(h)}:${pad(m)} ${TIMEZONE} | reps=${Object.keys(state.reps).length} admins=${state.admins.length} | ai=${GEMINI_API_KEY ? 'gemini' : (ANTHROPIC_API_KEY ? 'anthropic' : 'templates')}`);
}

if (SMOKE_TEST) {
  loadState();
  console.log('SMOKE -', JSON.stringify(nowParts()), '| ai=', GEMINI_API_KEY ? 'gemini' : (ANTHROPIC_API_KEY ? 'anthropic' : 'templates'));
  for (const k of ['ask', 'nudge', 'win']) console.log('SMOKE', k, '->', pickTemplate(k, 'Marcus'));
  console.log('SMOKE isAdmin(manager)=', isAdmin(String(process.env.MANAGER_CHAT_ID || '')));
  console.log('SMOKE ok');
} else {
  if (!TOKEN || !MANAGER_CHAT_ID) { console.error('Missing TELEGRAM_BOT_TOKEN / MANAGER_CHAT_ID'); process.exit(1); }
  runOnce();
}
