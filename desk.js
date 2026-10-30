/* Mixing Desk — the console, transport, app host and recorder. Audio building blocks are in mixer-core.js. */
'use strict';

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) { if (k == null || k === false) continue; el.append(k.nodeType ? k : document.createTextNode(k)); }
  return el;
}
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const db2g = d => Math.pow(10, d / 20);
const g2db = g => 20 * Math.log10(Math.max(g, 1e-9));
const wallNow = MixCore.wallNow;
const fmtTime = s => { const neg = s < 0; s = Math.abs(s); const m = Math.floor(s / 60); return (neg ? '-' : '') + String(m).padStart(2, '0') + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
let toastTimer = 0;
function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms || 3200); }
const SVGNS = 'http://www.w3.org/2000/svg';
const ICON = {
  play: '<svg viewBox="0 0 20 20"><path d="M5 3l12 7-12 7z"/></svg>',
  stop: '<svg viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="1"/></svg>',
  restart: '<svg viewBox="0 0 20 20"><path d="M10 3a7 7 0 1 1-6.6 4.7l2 .7A4.9 4.9 0 1 0 10 5.1V8L5.5 4.2 10 .4z"/></svg>',
};

/* ================= app catalog =================
   Apps that can be guests (they speak the Discobot guest protocol). Any other address can be added too. */
const CATALOG = [
  { name: 'Logic Rhythm', url: 'https://aaronvandorn.github.io/Logic-Rhythm/', about: 'logic-gate drum machine' },
  { name: 'Boolean Melody Machine', short: 'Melody Machine', url: 'https://aaronvandorn.github.io/Boolean-Melody-Machine/', about: 'generative melodies' },
  { name: 'Choir', url: 'https://aaronvandorn.github.io/Choir/', about: 'generative choral synth' },
  { name: 'Pocket Mouse', url: 'https://aaronvandorn.github.io/Pocket-Mouse/', about: 'Music Mouse-style instrument' },
  { name: 'Pocket Grains', url: 'https://aaronvandorn.github.io/Pocket-Grains/', about: 'granular instrument' },
  { name: 'Tape Loop Deck', url: 'https://aaronvandorn.github.io/Tape-Loop-Deck/', about: 'tape loops' },
];

/* ================= state ================= */
const S = {
  bpm: 120, playing: false, segs: [], channels: [], nextId: 1, midiMap: {}, learn: false, learnTarget: null,
  view: 'console', shown: null, click: false, lastStopWall: 0, tapTimes: [],
  verb: { size: 2.6, tone: 6000, vol: -6, mute: false },
  master: { vol: 0, limit: true },
  rec: { mode: 'bar', bars: 0, stems: false, bits: 24 },
  takes: [], name: 'mix-session'
};
const BEATS_PER_BAR = 4;

/* ================= channel parameters ================= */
const DIVS = MixCore.ECHO_DIVS;
const CH = {
  trim:    { label: 'Gain', short: 'Gain', min: -24, max: 24, dflt: 0, d: 'db' },
  lowcut:  { label: 'Low cut', short: 'Lo cut', min: 20, max: 1000, dflt: 20, scale: 'log', d: 'cut' },
  hi:      { label: 'EQ high', short: 'High', min: -15, max: 15, dflt: 0, d: 'db' },
  mid:     { label: 'EQ mid', short: 'Mid', min: -15, max: 15, dflt: 0, d: 'db' },
  midF:    { label: 'EQ mid freq', short: 'Freq', min: 200, max: 6000, dflt: 1000, scale: 'log', d: 'hz' },
  lo:      { label: 'EQ low', short: 'Low', min: -15, max: 15, dflt: 0, d: 'db' },
  filter:  { label: 'Filter (low-pass ← → high-pass)', short: 'Filter', min: -1, max: 1, dflt: 0, d: 'flt' },
  drive:   { label: 'Drive', short: 'Drive', min: 0, max: 1, dflt: 0, d: 'pct' },
  echo:    { label: 'Echo send', short: 'Echo', min: 0, max: 1, dflt: 0, d: 'pct' },
  echoDiv: { label: 'Echo time', short: 'Time', min: 0, max: DIVS.length - 1, dflt: 5, step: 1, d: 'div' },
  echoFb:  { label: 'Echo feedback', short: 'Fdbk', min: 0, max: 0.92, dflt: 0.35, d: 'pct' },
  verb:    { label: 'Reverb send', short: 'Verb', min: 0, max: 1, dflt: 0, d: 'pct' },
  pan:     { label: 'Pan', short: 'Pan', min: -1, max: 1, dflt: 0, d: 'pan' },
  vol:     { label: 'Volume', short: 'Vol', min: -60, max: 6, dflt: 0, scale: 'fader', d: 'vol' },
  mute:    { label: 'Mute', toggle: true },
  solo:    { label: 'Solo', toggle: true },
  play:    { label: 'Play / stop channel', toggle: true },
  restart: { label: 'Restart channel on the next bar', toggle: true, action: true },
};
const DEFAULT_CC = { vol: 7, pan: 10, trim: 20, hi: 21, mid: 22, midF: 23, lo: 24, drive: 25, echo: 26, echoDiv: 27, echoFb: 28, verb: 29, filter: 30, mute: 31, solo: 32, play: 33, restart: 34, lowcut: 35 };
const defaultP = () => { const p = {}; for (const [k, s] of Object.entries(CH)) if (!s.toggle) p[k] = s.dflt; p.mute = false; p.solo = false; return p; };

/* ================= controls registry (same model as Tape Loop Deck) ================= */
const CTL = new Map();
function defCtl(id, def) { CTL.set(id, Object.assign({ id, els: new Set() }, def)); }
function norm(c, v) {
  if (c.scale === 'log') return Math.log(v / c.min) / Math.log(c.max / c.min);
  if (c.scale === 'fader') return v <= -60 ? 0 : Math.cbrt(db2g(v) / db2g(6));
  return (v - c.min) / (c.max - c.min);
}
function denorm(c, n) {
  n = clamp(n, 0, 1);
  let v;
  if (c.scale === 'log') v = c.min * Math.pow(c.max / c.min, n);
  else if (c.scale === 'fader') v = n <= 0.0005 ? -60 : Math.max(-60, 20 * Math.log10(n * n * n * db2g(6)));
  else v = c.min + n * (c.max - c.min);
  return c.step ? Math.round(v / c.step) * c.step : v;
}
function setCtl(id, v, src) {
  const c = CTL.get(id); if (!c) return;
  if (!c.toggle) { v = clamp(v, c.min, c.max); if (c.step) v = Math.round(v / c.step) * c.step; } else v = !!v;
  c.set(v); syncCtl(id);
  logAutomation(c, v);
  if (!c.noSave) saveSoon();
}
function syncCtl(id) {
  const c = CTL.get(id); if (!c) return;
  for (const el of c.els) { if (!el.isConnected && el._wasConnected) { c.els.delete(el); continue; } el._sync && el._sync(); }
}
function bindEl(id, el, sync) { const c = CTL.get(id); el._sync = sync; c.els.add(el); requestAnimationFrame(() => { el._wasConnected = true; }); sync(); }
function ctlLabel(id) { const c = CTL.get(id); if (!c) return id; return c.group ? c.group() + ' · ' + c.label : c.label; }

function dispFor(k, v) {
  switch (k) {
    case 'db': return [(v > 0.05 ? '+' : '') + v.toFixed(1), 'dB'];
    case 'vol': return v <= -60 ? ['-∞', 'dB'] : [(v > 0.05 ? '+' : '') + v.toFixed(1), 'dB'];
    case 'hz': return v >= 1000 ? [(v / 1000).toFixed(2), 'kHz'] : [String(Math.round(v)), 'Hz'];
    case 'cut': return v <= 20.5 ? ['off', ''] : [String(Math.round(v)), 'Hz'];
    case 'pct': return [String(Math.round(v * 100)), '%'];
    case 'pan': { const p = Math.round(v * 100); return [String(Math.abs(p)), p < 0 ? 'L' : p > 0 ? 'R' : 'C']; }
    case 'flt': { const p = Math.round(v * 100); return p === 0 ? ['open', ''] : [String(Math.abs(p)), p < 0 ? 'LP' : 'HP']; }
    case 'div': return [DIVS[clamp(Math.round(v), 0, DIVS.length - 1)][0], ''];
    case 's': return [v.toFixed(1), 's'];
    case 'bpm': return [v.toFixed(1).replace(/\.0$/, ''), ''];
  }
  return [String(v), ''];
}
function parseFor(k, str) {
  const s = String(str).trim().toLowerCase();
  if (k === 'vol' && /inf|∞|off/.test(s)) return -60;
  if (k === 'cut' && /off/.test(s)) return 20;
  if ((k === 'flt') && /open|^c/.test(s)) return 0;
  if (k === 'div') { const i = DIVS.findIndex(d => d[0].toLowerCase() === s.replace(/\s+/g, ' ')); return i >= 0 ? i : NaN; }
  let x = parseFloat(s.replace(/[^0-9.+\-]/g, ''));
  if (k === 'pan' || k === 'flt') {
    if (isNaN(x)) return NaN;
    if (/l/.test(s)) x = -Math.abs(x); else if (/r|h/.test(s)) x = Math.abs(x);
    return x / 100;
  }
  if (isNaN(x)) return NaN;
  if ((k === 'hz' || k === 'cut') && /k/.test(s)) x *= 1000;
  if (k === 'pct') x /= 100;
  return x;
}

/* Pot widget: a knob plus an editable number. Drag (up/right raises, Shift for fine), tap the number
   to type, double-click to reset, wheel or arrow keys while focused. */
function potEl(a, layout) {
  const ptA = (r, deg) => { const q = (deg - 90) * Math.PI / 180; return [18 + r * Math.cos(q), 18 + r * Math.sin(q)]; };
  const arcD = (r, a0, a1) => { if (Math.abs(a1 - a0) < 0.4) return ''; const p = ptA(r, a0), q = ptA(r, a1); return `M${p[0].toFixed(2)} ${p[1].toFixed(2)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${q[0].toFixed(2)} ${q[1].toFixed(2)}`; };
  const wrap = h('div', { class: 'pot ' + (layout || ''), 'data-ctl': a.ctlId || null });
  let knob = null, vArc = null, ptr = null;
  if (layout !== 'bare' && layout !== 'big') {
    knob = document.createElementNS(SVGNS, 'svg');
    for (const [k, v] of Object.entries({ class: 'knob', viewBox: '0 0 36 36', tabindex: '0', role: 'slider', 'aria-label': a.name })) knob.setAttribute(k, v);
    knob.innerHTML = `<path class="trk" d="${arcD(14, -135, 135)}"/><path class="arc"/><circle class="cap" cx="18" cy="18" r="9"/><line class="ptr" x1="18" y1="18" x2="18" y2="11"/>`;
    vArc = knob.querySelector('.arc'); ptr = knob.querySelector('.ptr');
    wrap.append(knob, h('div', { class: 'nm', title: a.name }, a.label));
  }
  const num = h('input', { class: 'num', type: 'text', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': a.name + ' value' });
  const un = h('span', { class: 'un' });
  wrap.append(h('div', { class: 'nr' }, num, un));
  if (a.ctlId && layout !== 'big') wrap.append(h('div', { class: 'mb', 'data-mb': a.ctlId }));
  const fit = () => { num.style.width = (Math.max(1, num.value.length) + 0.4) + 'ch'; };
  const render = () => {
    const v = a.get(), n = clamp(a.norm(v), 0, 1), ang = -135 + 270 * n;
    const [txt, u] = a.disp(v);
    if (knob) {
      const a0 = a.bip ? -135 + 270 * a.norm(0) : -135;
      vArc.setAttribute('d', arcD(14, Math.min(a0, ang), Math.max(a0, ang)));
      const p1 = ptA(3, ang), p2 = ptA(9.5, ang);
      ptr.setAttribute('x1', p1[0].toFixed(2)); ptr.setAttribute('y1', p1[1].toFixed(2)); ptr.setAttribute('x2', p2[0].toFixed(2)); ptr.setAttribute('y2', p2[1].toFixed(2));
      knob.setAttribute('aria-valuenow', String(+(+v).toFixed(4))); knob.setAttribute('aria-valuetext', txt + ' ' + u);
    }
    if (document.activeElement !== num) num.value = txt;
    un.textContent = u; fit();
  };
  const setN = n => a.set(a.denorm(clamp(n, 0, 1)));
  const nudge = (dir, big) => { if (a.step) a.set(a.get() + dir * a.step * (big ? 10 : 1)); else setN(a.norm(a.get()) + dir * (big ? 0.1 : 0.01)); };
  function drag(target, onTap) {
    let st = null;
    target.addEventListener('pointerdown', e => {
      if (e.button > 0 || S.learn) return;
      if (target === num && document.activeElement === num) return;
      e.preventDefault(); target.setPointerCapture(e.pointerId);
      st = { x: e.clientX, y: e.clientY, n: clamp(a.norm(a.get()), 0, 1), last: 0, moved: false };
      if (target === knob) knob.focus();
    });
    target.addEventListener('pointermove', e => {
      if (!st) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (!st.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      st.moved = true;
      const d = (dx - dy) - st.last; st.last = dx - dy;
      st.n = clamp(st.n + d / (e.shiftKey ? 900 : (a.sens || 220)), 0, 1); setN(st.n);
    });
    const end = e => { if (!st) return; const s0 = st; st = null; try { target.releasePointerCapture(e.pointerId); } catch (_) {} if (!s0.moved && onTap) onTap(); };
    target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
  }
  drag(num, () => { num.focus(); num.select(); });
  const wheel = e => { if (document.activeElement !== knob && document.activeElement !== num) return; e.preventDefault(); nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey); if (document.activeElement === num) { render(); num.value = a.disp(a.get())[0]; num.select(); } };
  num.addEventListener('wheel', wheel, { passive: false });
  if (knob) {
    drag(knob, null);
    knob.addEventListener('wheel', wheel, { passive: false });
    knob.addEventListener('dblclick', () => { if (!S.learn) a.set(a.dflt); });
    knob.addEventListener('keydown', e => {
      const map = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };
      if (map[e.key]) { e.preventDefault(); nudge(map[e.key], e.shiftKey); }
      else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); nudge(e.key === 'PageUp' ? 1 : -1, true); }
      else if (e.key === 'Home') { e.preventDefault(); setN(0); }
      else if (e.key === 'End') { e.preventDefault(); setN(1); }
      else if (e.key === 'Enter') { e.preventDefault(); num.focus(); num.select(); }
    });
  }
  const commit = () => { const x = a.parse(num.value); if (!isNaN(x)) a.set(x); num.value = a.disp(a.get())[0]; render(); };
  num.addEventListener('input', fit);
  num.addEventListener('focus', () => num.select());
  num.addEventListener('blur', commit);
  num.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); num.blur(); if (knob) knob.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); num.value = a.disp(a.get())[0]; num.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); num.value = a.disp(a.get())[0]; fit(); num.select(); }
  });
  render();
  return { el: wrap, render, knob, num };
}
function ctlPot(id, layout, label) {
  const c = CTL.get(id);
  const p = potEl({ ctlId: id, name: ctlLabel(id), label: label || c.short || c.label, get: c.get, set: v => setCtl(id, v),
    norm: v => norm(c, v), denorm: n => denorm(c, n), dflt: c.dflt, step: c.step, sens: c.sens, bip: c.min < 0 && c.max > 0 && c.scale !== 'fader',
    disp: v => dispFor(c.d, v), parse: x => parseFor(c.d, x) }, layout);
  bindEl(id, p.el, p.render);
  return p.el;
}
const FADER_H = 200, FADER_TRAVEL = FADER_H - 16;
function faderEl(id) {
  const c = CTL.get(id);
  const cap = h('div', { class: 'cap' });
  const f = h('div', { class: 'fader', tabindex: 0, role: 'slider', 'aria-label': ctlLabel(id), 'aria-orientation': 'vertical', 'data-ctl': id }, h('div', { class: 'slot' }), cap);
  for (const db of [6, 0, -6, -12, -24, -40]) { const tk = h('div', { class: 'tick' + (db === 0 ? ' zero' : '') }); tk.style.top = (8 + (1 - norm(c, db)) * FADER_TRAVEL) + 'px'; f.insertBefore(tk, f.firstChild); }
  bindEl(id, f, () => {
    const n = norm(c, c.get());
    cap.style.top = `${8 + (1 - n) * FADER_TRAVEL}px`;
    f.setAttribute('aria-valuetext', dispFor('vol', c.get()).join(' '));
  });
  f.addEventListener('pointerdown', e => {
    if (S.learn) return;
    e.preventDefault(); f.setPointerCapture(e.pointerId); f.focus();
    const y0 = e.clientY, n0 = norm(c, c.get());
    f.onpointermove = ev => setCtl(id, denorm(c, n0 + (y0 - ev.clientY) / (ev.shiftKey ? 700 : FADER_TRAVEL)));
    f.onpointerup = f.onpointercancel = () => { f.onpointermove = null; };
  });
  f.addEventListener('dblclick', () => setCtl(id, c.dflt));
  f.addEventListener('keydown', e => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key]; if (!d) return;
    e.preventDefault(); setCtl(id, denorm(c, norm(c, c.get()) + d * (e.shiftKey ? 0.004 : 0.03)));
  });
  return f;
}
function toggleEl(id, cls, text) {
  const c = CTL.get(id);
  const b = h('button', { class: cls, 'aria-pressed': 'false', 'data-ctl': id, 'aria-label': ctlLabel(id) }, text);
  b.addEventListener('click', () => { if (!S.learn) setCtl(id, !c.get()); });
  bindEl(id, b, () => b.setAttribute('aria-pressed', String(!!c.get())));
  return h('div', { class: 'mbw' }, b, h('div', { class: 'mb', 'data-mb': id }));
}

/* ================= audio ================= */
let AC = null, MASTER = null, VERB = null, MASTER_METER = null, VERB_METER = null, MASTER_TAP = null, audioReady = null;
function ensureAudio() {
  if (AC) { if (AC.state === 'suspended') AC.resume(); return audioReady; }
  AC = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  MASTER = MixCore.master(AC);
  VERB = MixCore.reverb(AC, MASTER.bus);
  MASTER_METER = MixCore.meter(AC, MASTER.post);
  VERB_METER = MixCore.meter(AC, VERB.out);
  MASTER_TAP = MixCore.tap(AC, MASTER.post);
  applyMaster(); applyVerb();
  audioReady = MixCore.ready(AC).then(() => { S.channels.forEach(attachAudio); jamSource && jamSource.refresh && jamSource.refresh(); });
  if (AC.state === 'suspended') AC.resume();
  return audioReady;
}
function applyMaster() { if (MASTER) MASTER.apply({ vol: S.master.vol, limit: S.master.limit }); }
function applyVerb() { if (VERB) VERB.apply({ size: S.verb.size, tone: S.verb.tone, vol: S.verb.vol, muted: S.verb.mute }); }
const anySolo = () => S.channels.some(c => c.p.solo);
function applyChannel(ch) {
  if (!ch.n) return;
  const p = Object.assign({}, ch.p, { muted: ch.p.mute || (anySolo() && !ch.p.solo) });
  ch.n.apply(p, currentBpm());
}
function applyAll() { S.channels.forEach(applyChannel); }
function attachAudio(ch) {
  if (!AC || ch.n) return;
  ch.n = MixCore.strip(AC, { out: MASTER.bus, reverb: VERB.input });
  ch.meter = MixCore.meter(AC, ch.n.out);
  ch.tap = MixCore.tap(AC, ch.n.out);
  if (ch.type === 'app') {
    ch.player = MixCore.guestPlayer(AC, ms => { ch.latency = ms; guestSend(ch, { type: 'hello', host: 'discobot', latencyMs: ms }); refreshStatus(ch); }, ch.latency);
    ch.player.node.connect(ch.n.input);
  } else if (ch.type === 'input' && ch.stream) {
    ch.src = AC.createMediaStreamSource(ch.stream); ch.src.connect(ch.n.input);
  }
  if (ch.type === 'input') setInputOpen(ch);
  applyChannel(ch);
}

/* ================= transport =================
   The timeline is a list of tempo segments on the shared wall clock, exactly as Jam Link and Discobot
   describe it: beat b falls at anchorWall + (b - anchorBeat) * 60000 / bpm. The desk owns it and tells
   every app; each app plays its own notes on those beats. */
const segAtBeat = b => { let s = S.segs[0]; for (const x of S.segs) if (x.anchorBeat <= b) s = x; return s; };
const segAtWall = w => { let s = S.segs[0]; for (const x of S.segs) if (x.anchorWall <= w) s = x; return s; };
const beatToWall = b => { const s = segAtBeat(b); return s.anchorWall + (b - s.anchorBeat) * 60000 / s.bpm; };
const wallToBeat = w => { const s = segAtWall(w); return s.anchorBeat + (w - s.anchorWall) * s.bpm / 60000; };
const currentBpm = () => S.playing && S.segs.length ? S.segs[S.segs.length - 1].bpm : S.bpm;
const beatNow = () => S.playing && S.segs.length ? wallToBeat(wallNow()) : 0;
const frameOfBeat = b => Math.round(MixCore.ctxAtWall(AC, beatToWall(b)) * AC.sampleRate);
const heardFrame = () => Math.round(MixCore.ctxAtWall(AC, wallNow()) * AC.sampleRate);

// How long after "now" a start must be placed so this channel can make it.
function leadFor(ch) {
  if (ch.type === 'app') return ch.connected ? (ch.warm ? ch.latency / 1000 + 0.23 : 0.9) : 0;
  return 0.08;
}
function play() {
  if (S.playing) return;
  ensureAudio();
  const runners = S.channels.filter(c => c.run && c.type !== 'input');
  const lead = Math.max(0.15, ...runners.map(leadFor));
  S.segs = [{ bpm: S.bpm, anchorWall: wallNow() + lead * 1000, anchorBeat: 0 }];
  S.playing = true; S.clickNext = 0;
  runners.forEach(c => startChannel(c, 0));
  if (REC.armed && !REC.on) beginRecordingAt(0);
  syncCtl('m:play'); refreshTransportUI();
}
function stop() {
  if (!S.playing) {
    S.lastStopWall = wallNow(); updateCounter(); return;
  }
  if (REC.on) finishRecording(heardFrame());
  S.channels.forEach(c => { if (c.type !== 'input' && (c.playing || c.pending != null)) stopChannel(c, true); });
  S.playing = false; S.segs = []; S.lastStopWall = wallNow();
  syncCtl('m:play'); refreshTransportUI(); updateCounter();
}
function setTempo(bpm) {
  bpm = clamp(Math.round(bpm * 10) / 10, 20, 400);
  S.bpm = bpm;
  if (S.playing) {
    const w = wallNow() + 150, seg = { bpm, anchorWall: w, anchorBeat: wallToBeat(w) };
    S.segs = S.segs.filter(s => s.anchorWall < w); S.segs.push(seg); if (S.segs.length > 64) S.segs.shift();
    S.channels.forEach(c => { if (c.type === 'app' && (c.playing || c.pending != null)) guestSend(c, { type: 'transport', playing: true, bpm, anchorWall: seg.anchorWall, anchorBeat: seg.anchorBeat }); });
  }
  S.channels.forEach(c => c.n && c.n.setTempo(bpm, c.p.echoDiv));
  saveSoon();
}
// The first bar line at least `leadSec` from now.
function nextBarBeat(leadSec) {
  const b = wallToBeat(wallNow() + leadSec * 1000);
  return Math.ceil(b / BEATS_PER_BAR - 1e-9) * BEATS_PER_BAR;
}
function startChannel(ch, beat) {
  ch.pending = beat; ch.playing = false;
  const startWall = beatToWall(beat);
  if (ch.type === 'app') {
    if (ch.connected) {
      ch.player && ch.player.clear();
      const s = segAtBeat(beat);
      guestSend(ch, { type: 'transport', playing: true, bpm: s.bpm, anchorWall: startWall, anchorBeat: beat });
      // later tempo segments (a change already scheduled) follow on
      S.segs.filter(x => x.anchorBeat > beat).forEach(x => guestSend(ch, { type: 'transport', playing: true, bpm: x.bpm, anchorWall: x.anchorWall, anchorBeat: x.anchorBeat }));
      ch.warm = true;
    }
  } else if (ch.type === 'file' && ch.buffer && AC) {
    const t = MixCore.ctxAtWall(AC, startWall);
    const src = AC.createBufferSource(); src.buffer = ch.buffer; src.loop = ch.loop !== false;
    const g = AC.createGain(); src.connect(g); g.connect(ch.n.input);
    src.start(Math.max(AC.currentTime, t));
    if (ch.srcNode) killSource(ch);
    ch.srcNode = src; ch.srcGain = g;
    if (!src.loop) src.onended = () => { if (ch.srcNode === src) { ch.playing = false; ch.pending = null; ch.srcNode = null; refreshChannelTransport(ch); } };
  }
  clearTimeout(ch.pendTimer);
  ch.pendTimer = setTimeout(() => { if (ch.pending === beat) { ch.pending = null; ch.playing = true; refreshChannelTransport(ch); } }, Math.max(0, startWall - wallNow()));
  refreshChannelTransport(ch);
}
function killSource(ch) {
  const src = ch.srcNode, g = ch.srcGain; ch.srcNode = null; ch.srcGain = null;
  if (!src) return;
  try { g.gain.setTargetAtTime(0, AC.currentTime, 0.008); src.stop(AC.currentTime + 0.06); } catch (e) {}
}
function stopChannel(ch, all) {
  clearTimeout(ch.pendTimer);
  ch.pending = null; ch.playing = false;
  if (ch.type === 'app') guestSend(ch, { type: 'transport', playing: false });
  else if (ch.type === 'file') killSource(ch);
  if (!all) refreshChannelTransport(ch);
}
// Channel play button. While the desk plays it starts on the next bar line or stops at once;
// while stopped it arms the channel (or not) for the next Play.
function channelPlay(ch, on) {
  ch.run = on;
  if (ch.type === 'input') { setInputOpen(ch); refreshChannelTransport(ch); saveSoon(); return; }
  if (S.playing) {
    if (on && !ch.playing && ch.pending == null) startChannel(ch, nextBarBeat(leadFor(ch)));
    else if (!on) stopChannel(ch);
  }
  refreshChannelTransport(ch); saveSoon();
}
function setInputOpen(ch) {
  ch.playing = !!ch.run && !!ch.stream; ch.pending = null;
  if (ch.n && AC) ch.n.input.gain.setTargetAtTime(ch.run ? 1 : 0, AC.currentTime, 0.01);
}
function channelRestart(ch) {
  ch.run = true;
  if (ch.type === 'input') { setInputOpen(ch); refreshChannelTransport(ch); return; }
  if (!S.playing) { play(); return; }
  if (ch.playing || ch.pending != null) stopChannel(ch, true);
  startChannel(ch, nextBarBeat(Math.max(leadFor(ch), 0.15)));
}

/* tap tempo */
$('#tapBtn').addEventListener('click', () => {
  const t = performance.now();
  S.tapTimes = S.tapTimes.filter(x => t - x < 2500); S.tapTimes.push(t);
  if (S.tapTimes.length >= 3) {
    const d = []; for (let i = 1; i < S.tapTimes.length; i++) d.push(S.tapTimes[i] - S.tapTimes[i - 1]);
    setCtl('m:bpm', 60000 / (d.reduce((a, b) => a + b, 0) / d.length));
  }
});

/* metronome: scheduled straight to the speakers, never into the mix or a recording */
function clickTick() {
  if (!S.click || !S.playing || !AC) return;
  const ahead = wallNow() + 150;
  if (S.clickNext == null) S.clickNext = 0;
  const now = wallToBeat(wallNow());
  if (S.clickNext < Math.ceil(now)) S.clickNext = Math.ceil(now);
  while (beatToWall(S.clickNext) < ahead) {
    const b = S.clickNext, t = MixCore.ctxAtWall(AC, beatToWall(b));
    if (t > AC.currentTime) {
      const o = AC.createOscillator(), g = AC.createGain(), acc = b % BEATS_PER_BAR === 0;
      o.frequency.value = acc ? 1760 : 1175; o.type = 'square';
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(acc ? 0.22 : 0.13, t + 0.001); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.045);
      o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + 0.06);
    }
    S.clickNext++;
  }
}

/* ================= app hosting (Discobot guest protocol v1) ================= */
function guestSend(ch, msg) {
  if (!ch.frame || !ch.frame.contentWindow) return;
  msg.discobotGuest = 1;
  const target = ch.origin && ch.origin !== 'null' ? ch.origin : '*';
  try { ch.frame.contentWindow.postMessage(msg, target); } catch (e) {}
}
window.addEventListener('message', e => {
  const m = e.data;
  if (!m || typeof m !== 'object' || m.discobotGuest !== 1 || typeof m.type !== 'string') return;
  const ch = S.channels.find(c => c.frame && c.frame.contentWindow === e.source);
  if (!ch) return;
  if (m.type === 'ready') ch.origin = e.origin;          // first load, or the app reloaded in its frame
  else if (ch.origin == null || e.origin !== ch.origin) return;
  switch (m.type) {
    case 'ready': onGuestReady(ch, m); break;
    case 'audio':
      if (ch.player) { ch.player.push(m.wall, m.sampleRate, m.left, m.right); ch.lastAudio = performance.now(); }
      break;
    case 'state':
      if (typeof m.id === 'string' && ch.stateReq && ch.stateReq.id === m.id) {
        try { const txt = JSON.stringify(m.state); if (txt && txt.length <= 100000) ch.state = JSON.parse(txt); } catch (err) {}
        const r = ch.stateReq; ch.stateReq = null; r.resolve(); saveSoon();
      }
      break;
    case 'stateChanged': clearTimeout(ch.stateTimer); ch.stateTimer = setTimeout(() => requestState(ch), 400); break;
  }
});
function onGuestReady(ch, m) {
  ch.features = Array.isArray(m.features) ? m.features.filter(f => typeof f === 'string') : [];
  if (typeof m.name === 'string' && m.name.trim() && !ch.renamed) { ch.name = m.name.trim().slice(0, 40); refreshNames(ch); }
  ch.connected = true; ch.warm = false; ch.noLink = false; ch.playing = false; ch.pending = null;
  ch.player && ch.player.clear();
  clearTimeout(ch.readyTimer);
  guestSend(ch, { type: 'hello', host: 'discobot', latencyMs: ch.latency });
  if (ch.state != null && ch.features.includes('state')) guestSend(ch, { type: 'setState', state: ch.state });
  if (ch.features.includes('audio')) guestSend(ch, { type: 'audio', on: true });
  // the desk is already playing: come in on the next bar line
  if (S.playing && ch.run) startChannel(ch, nextBarBeat(0.9));
  refreshStatus(ch); refreshChannelTransport(ch);
}
function requestState(ch) {
  if (!ch.connected || !(ch.features || []).includes('state')) return Promise.resolve();
  if (ch.stateReq) return ch.stateReq.promise;
  const id = Math.random().toString(36).slice(2, 12);
  let resolve; const promise = new Promise(r => resolve = r);
  ch.stateReq = { id, resolve, promise };
  setTimeout(() => { if (ch.stateReq && ch.stateReq.id === id) { ch.stateReq.resolve(); ch.stateReq = null; } }, 1500);
  guestSend(ch, { type: 'getState', id });
  return promise;
}
const captureAllStates = () => Promise.all(S.channels.filter(c => c.type === 'app').map(requestState));
setInterval(() => S.channels.forEach(c => { if (c.type === 'app') requestState(c); }), 6000);

function mountFrame(ch) {
  const f = h('iframe', { title: ch.name, allow: 'autoplay; midi; microphone', src: ch.url, loading: 'eager', referrerpolicy: 'no-referrer-when-downgrade' });
  ch.frame = f; ch.origin = null; ch.connected = false;
  f.addEventListener('load', () => {
    clearTimeout(ch.readyTimer);
    ch.readyTimer = setTimeout(() => { if (!ch.connected) { ch.noLink = true; refreshStatus(ch); } }, 6000);
  });
  $('#frames').append(f);
}

/* ================= channels ================= */
function newChannel(type, opts) {
  const ch = Object.assign({ id: S.nextId++, type, name: 'Channel', p: defaultP(), run: true, latency: MixCore.GUEST_LATENCY_MS, midiCh: 0, ui: {} }, opts || {});
  ch.p = Object.assign(defaultP(), opts && opts.p);
  if (!ch.midiCh) { const used = new Set(S.channels.map(c => c.midiCh)); for (let i = 1; i <= 15; i++) if (!used.has(i)) { ch.midiCh = i; break; } }
  S.channels.push(ch);
  defineChannelCtls(ch);
  if (opts && opts.midiDefaults !== false && !opts.restoring) setStripChannel(ch, ch.midiCh || 0);
  if (type === 'app') mountFrame(ch);
  if (AC) { ensureAudio(); if (AC.audioWorklet) MixCore.ready(AC).then(() => attachAudio(ch)); }
  if (S.playing && ch.run && type === 'file') startChannel(ch, nextBarBeat(leadFor(ch)));
  refreshAll();
  if (!S.shown || type === 'app') showChannel(ch.id);
  saveSoon();
  return ch;
}
function defineChannelCtls(ch) {
  for (const [k, s] of Object.entries(CH)) {
    const id = `c${ch.id}:${k}`;
    const def = Object.assign({}, s, { key: k, chId: ch.id, group: () => ch.name });
    if (k === 'play') { def.get = () => !!ch.run; def.set = v => channelPlay(ch, v); }
    else if (k === 'restart') { def.get = () => false; def.set = () => channelRestart(ch); def.noSave = true; }
    else if (k === 'solo') { def.get = () => ch.p.solo; def.set = v => { ch.p.solo = v; applyAll(); }; }
    else { def.get = () => ch.p[k]; def.set = v => { ch.p[k] = v; applyChannel(ch); }; }
    defCtl(id, def);
  }
}
function removeChannel(ch) {
  if (ch.playing || ch.pending != null) stopChannel(ch, true);
  if (ch.frame) ch.frame.remove();
  if (ch.player) ch.player.dispose();
  if (ch.meter) ch.meter.dispose();
  if (ch.srcNode) killSource(ch);
  if (ch.src) try { ch.src.disconnect(); } catch (e) {}
  if (ch.stream) ch.stream.getTracks().forEach(t => t.stop());
  if (ch.n) ch.n.dispose();
  for (const k of Object.keys(CH)) { CTL.delete(`c${ch.id}:${k}`); delete S.midiMap[`c${ch.id}:${k}`]; }
  S.channels = S.channels.filter(c => c !== ch);
  if (S.shown === ch.id) S.shown = S.channels.length ? S.channels[0].id : null;
  applyAll(); refreshAll(); saveSoon();
}
function setStripChannel(ch, mch) {
  for (const k of Object.keys(DEFAULT_CC)) delete S.midiMap[`c${ch.id}:${k}`];
  ch.midiCh = mch;
  if (mch) {
    for (const [k, num] of Object.entries(DEFAULT_CC)) {
      // a channel number can only belong to one strip
      for (const [id, m] of Object.entries(S.midiMap)) if (m.ch === mch && m.type === 'cc' && m.num === num) delete S.midiMap[id];
      S.midiMap[`c${ch.id}:${k}`] = { ch: mch, type: 'cc', num };
    }
    S.channels.forEach(o => { if (o !== ch && o.midiCh === mch) o.midiCh = 0; });
  }
  refreshBadges(); refreshMap(); S.channels.forEach(o => { if (o.ui.chSel) o.ui.chSel.value = o.midiCh; });
  saveSoon();
}

/* adding */
function fillCatalog() {
  const sel = $('#catSel'); sel.innerHTML = '';
  CATALOG.forEach((a, i) => sel.append(h('option', { value: i }, `${a.name} — ${a.about}`)));
}
fillCatalog();
function addApp(url, name) {
  let u;
  try { u = new URL(url, location.href); } catch (e) { toast('That address does not look right.'); return null; }
  if (!/^https?:$/.test(u.protocol)) { toast('Only http(s) addresses can be added.'); return null; }
  if (u.href.split('#')[0] === location.href.split('#')[0]) { toast('The desk cannot host itself.'); return null; }
  ensureAudio();
  return newChannel('app', { url: u.href, name: name || u.hostname, renamed: !!name });
}
$('#addApp').addEventListener('click', () => { const a = CATALOG[+$('#catSel').value]; addApp(a.url, a.short || a.name); });
$('#addUrl').addEventListener('click', () => { const v = $('#urlIn').value.trim(); if (!v) { $('#urlIn').focus(); return; } if (addApp(v)) $('#urlIn').value = ''; });
$('#urlIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('#addUrl').click(); });
$('#quickAdd').addEventListener('click', () => { setView(S.view === 'console' ? 'both' : S.view); $('#catSel').focus(); });
$('#addFile').addEventListener('click', () => $('#fileIn').click());
$('#fileIn').addEventListener('change', async e => { for (const f of e.target.files) await addFileChannel(f); e.target.value = ''; });
async function addFileChannel(file, opts) {
  await ensureAudio();
  try {
    const bytes = await file.arrayBuffer();
    const buffer = await AC.decodeAudioData(bytes.slice(0));
    const name = (opts && opts.name) || file.name.replace(/\.[^.]+$/, '');
    if (opts && opts.into) { const ch = opts.into; ch.buffer = buffer; ch.bytes = bytes; ch.fileName = file.name; ch.missing = false; refreshAll(); return ch; }
    return newChannel('file', Object.assign({ name: name.slice(0, 40), buffer, bytes, fileName: file.name, loop: true }, opts || {}));
  } catch (err) { toast(`Could not read ${file.name}.`); }
}
$('#addInput').addEventListener('click', () => addInputChannel());
async function addInputChannel(opts) {
  await ensureAudio();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: opts && opts.deviceId ? { ideal: opts.deviceId } : undefined } });
    const track = stream.getAudioTracks()[0];
    if (opts && opts.into) { const ch = opts.into; ch.stream = stream; ch.missing = false; ch.run = true; if (ch.n) { ch.src = AC.createMediaStreamSource(stream); ch.src.connect(ch.n.input); setInputOpen(ch); } refreshAll(); return ch; }
    const ch = newChannel('input', Object.assign({ name: (track && track.label ? track.label : 'Live input').slice(0, 40), stream, p: { mute: true } }, opts || {}));
    toast('Live input added, muted. Unmute it when you are on headphones, so the speakers do not feed back.', 5200);
    return ch;
  } catch (err) { toast('The browser did not allow audio input.'); }
}

/* ================= UI: views and app tabs ================= */
function setView(v) {
  S.view = v; document.body.dataset.view = v;
  document.querySelectorAll('.tabs [data-view]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  try { localStorage.setItem('mixdesk:view', v); } catch (e) {}
}
document.querySelectorAll('.tabs [data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
function showChannel(id) {
  S.shown = id;
  const ch = S.channels.find(c => c.id === id);
  S.channels.forEach(c => c.frame && c.frame.classList.toggle('show', c.id === id));
  const fp = $('#filePanel');
  if (ch && ch.type !== 'app') {
    fp.classList.add('show'); fp.innerHTML = '';
    const desc = ch.type === 'file'
      ? (ch.buffer ? `${ch.fileName || 'Audio file'} · ${ch.buffer.duration.toFixed(2)} s · ${(ch.buffer.duration * currentBpm() / 60 / BEATS_PER_BAR).toFixed(2)} bars at ${currentBpm()} BPM. Starts on a bar line with the transport${ch.loop !== false ? ' and loops' : ''}.` : 'The audio for this file is not loaded (sessions remember files without their audio). Load it again to use the channel.')
      : 'Sound from your audio input (an interface, a mixer, another program routed in). Its channel play button opens and closes it on the bar line.';
    fp.append(h('div', {}, h('h3', {}, ch.name), h('p', { class: 'note' }, desc),
      ch.type === 'file' ? h('div', { style: 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-top:10px' },
        h('label', { style: 'display:inline-flex;gap:6px;align-items:center' }, h('input', { type: 'checkbox', checked: ch.loop !== false, onchange: e => { ch.loop = e.target.checked; if (ch.srcNode) ch.srcNode.loop = ch.loop; saveSoon(); } }), 'Loop'),
        h('button', { class: 'btn small', onclick: () => { const i = h('input', { type: 'file', accept: 'audio/*' }); i.onchange = () => i.files[0] && addFileChannel(i.files[0], { into: ch }).then(() => showChannel(ch.id)); i.click(); } }, ch.buffer ? 'Replace audio' : 'Load audio')) : null,
      ch.type === 'input' && ch.missing ? h('button', { class: 'btn small', style: 'margin-top:10px', onclick: () => addInputChannel({ into: ch }) }, 'Open input') : null));
  } else fp.classList.remove('show');
  $('#framesEmpty').hidden = S.channels.length > 0;
  refreshAppTabs();
}
function refreshAppTabs() {
  const box = $('#appTabs'); box.innerHTML = '';
  S.channels.forEach((c, i) => {
    const led = h('span', { class: 'led' }); c.ui.tabLed = led;
    box.append(h('button', { class: 'apptab', role: 'tab', 'aria-selected': String(S.shown === c.id), onclick: () => showChannel(c.id) },
      led, h('span', { class: 'chn' }, String(i + 1).padStart(2, '0')), c.name));
  });
}

/* ================= UI: console ================= */
const SCALE_DB = [0, -6, -12, -18, -30, -48];
const meterPct = db => clamp((db + 60) / 60, 0, 1) * 100;
function meterEl() {
  const mk = () => h('div', { class: 'ch' }, h('i'), h('b'));
  const L = mk(), R = mk(), clip = h('button', { class: 'clip', title: 'Clip indicator — click to reset', 'aria-label': 'Clip indicator, click to reset' });
  const scale = h('div', { class: 'scale', 'aria-hidden': 'true' }, ...SCALE_DB.map(d => { const s = h('span', {}, String(Math.abs(d))); s.style.top = (100 - meterPct(d)) + '%'; return s; }));
  const box = h('div', { class: 'meterwrap' }, clip, h('div', { style: 'display:flex;gap:2px' }, h('div', { class: 'meter', role: 'meter', 'aria-label': 'Level' }, L, R), scale));
  const st = { pkL: -90, pkR: -90, holdL: -90, holdR: -90, holdAtL: 0, holdAtR: 0, clip: false, max: -90 };
  clip.addEventListener('click', () => { st.clip = false; st.max = -90; clip.classList.remove('on'); });
  box._m = { L, R, clip, st };
  return box;
}
function drawMeter(box, r, now) {
  if (!box) return;
  const { L, R, clip, st } = box._m;
  const one = (el, rms, peak, side) => {
    const pdb = g2db(peak), rdb = g2db(rms);
    // bar: fast attack, eased release; hold line: 1.5 s, then falls
    st['pk' + side] = Math.max(pdb, st['pk' + side] - 1.2);
    if (pdb >= st['hold' + side] || now - st['holdAt' + side] > 1500) { st['hold' + side] = pdb >= st['hold' + side] ? pdb : st['hold' + side] - 0.8; if (pdb >= st['hold' + side]) st['holdAt' + side] = now; }
    el.firstChild.style.height = meterPct(Math.max(rdb + 3, st['pk' + side] - 6)) + '%';
    el.lastChild.style.bottom = `calc(${meterPct(st['hold' + side])}% - 2px)`;
    if (peak >= 0.999) st.clip = true;
    st.max = Math.max(st.max, pdb);
  };
  if (r) { one(L, r.rmsL, r.peakL, 'L'); one(R, r.rmsR, r.peakR, 'R'); }
  clip.classList.toggle('on', st.clip);
}
function refreshStrips() {
  const box = $('#strips'); box.innerHTML = '';
  if (!S.channels.length) box.append(h('div', { class: 'strip empty' }, h('p', {}, 'No channels yet.'), h('button', { class: 'btn primary', onclick: () => { setView('both'); $('#catSel').focus(); } }, 'Add an app')));
  S.channels.forEach((ch, i) => box.append(buildStrip(ch, i)));
  box.append(buildVerbStrip(), buildMasterStrip());
  refreshBadges();
}
function buildStrip(ch, i) {
  const k = key => ctlPot(`c${ch.id}:${key}`);
  const name = h('input', { class: 'strip-name', value: ch.name, 'aria-label': 'Channel name', maxlength: 40 });
  name.addEventListener('change', () => { ch.name = name.value.trim() || ch.name; ch.renamed = true; refreshNames(ch); saveSoon(); });
  ch.ui.name = name;
  const sel = h('select', { class: 'sel', 'aria-label': `MIDI channel for ${ch.name}` }, h('option', { value: 0 }, '—'), ...Array.from({ length: 15 }, (_, j) => h('option', { value: j + 1 }, String(j + 1))));
  sel.value = ch.midiCh; sel.addEventListener('change', () => setStripChannel(ch, +sel.value));
  ch.ui.chSel = sel;
  const playB = h('button', { class: 'cplay', 'aria-pressed': 'false', 'data-ctl': `c${ch.id}:play`, title: 'Play / stop this channel. While the desk plays, it starts on the next bar line; while stopped, it arms the channel for the next Play.', html: ICON.play });
  playB.addEventListener('click', () => { if (!S.learn) setCtl(`c${ch.id}:play`, !(ch.playing || ch.pending != null || (!S.playing && ch.run))); });
  const restartB = h('button', { class: 'crestart', 'data-ctl': `c${ch.id}:restart`, title: 'Restart this channel from the top on the next bar line', html: ICON.restart });
  restartB.addEventListener('click', () => { if (!S.learn) setCtl(`c${ch.id}:restart`, true); });
  const viewB = h('button', { title: 'Show this app', 'aria-label': 'Show this app', html: '<svg viewBox="0 0 20 20"><path d="M3 4h14v10H3zM7 16h6v1.5H7z"/></svg>' });
  viewB.addEventListener('click', () => { showChannel(ch.id); if (S.view === 'console') setView('both'); });
  ch.ui.playB = playB; ch.ui.restartB = restartB;
  ch.ui.state = h('div', { class: 'cstate' });
  ch.ui.led = h('span', { class: 'led' }); ch.ui.statusText = h('span');
  ch.ui.meter = meterEl();
  const kind = { app: 'App', file: 'File', input: 'Input' }[ch.type];
  const el = h('div', { class: 'strip', 'data-ch': ch.id },
    h('div', { class: 'strip-num' }, h('span', {}, 'Ch ' + String(i + 1).padStart(2, '0')), h('span', { class: 'kind' }, kind)),
    name,
    h('div', { class: 'status' }, ch.ui.led, ch.ui.statusText),
    h('div', { class: 'ctx' }, playB, restartB, viewB),
    ch.ui.state,
    h('div', { class: 'chsel' }, h('span', {}, 'MIDI ch'), sel),
    h('div', { class: 'sect' }, h('div', { class: 'kgrid' }, k('trim'), k('lowcut'))),
    h('div', { class: 'sect' }, h('span', { class: 'lbl' }, 'EQ'), h('div', { class: 'kgrid' }, k('hi'), k('mid'), k('midF'), k('lo'))),
    h('div', { class: 'sect' }, h('span', { class: 'lbl' }, 'Effects bus'), h('div', { class: 'kgrid' }, k('filter'), k('drive'), k('echo'), k('echoDiv'), k('echoFb'), k('verb'))),
    h('div', { class: 'sect' }, h('div', { class: 'kgrid one' }, k('pan'))),
    h('div', { class: 'faderzone' }, faderEl(`c${ch.id}:vol`), ch.ui.meter),
    ctlPot(`c${ch.id}:vol`, 'bare'),
    h('div', { class: 'ms' }, toggleEl(`c${ch.id}:mute`, 'mute', 'M'), toggleEl(`c${ch.id}:solo`, 'solo', 'S')),
    h('div', { class: 'foot' }, h('button', { class: 'btn tiny', onclick: e => confirmRemove(e.currentTarget, ch) }, 'Remove'))
  );
  refreshStatus(ch); refreshChannelTransport(ch);
  return el;
}
function confirmRemove(btn, ch) {
  if (btn.dataset.armed) { removeChannel(ch); return; }
  btn.dataset.armed = '1'; btn.textContent = 'Sure?'; btn.classList.add('primary');
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = 'Remove'; btn.classList.remove('primary'); } }, 2500);
}
const VERB_UI = {}, MASTER_UI = {};
function buildVerbStrip() {
  VERB_UI.meter = meterEl();
  return h('div', { class: 'strip ret' },
    h('div', { class: 'strip-num' }, h('span', {}, 'Return'), h('span', { class: 'kind' }, 'FX')),
    h('div', { class: 'strip-name' }, 'Reverb'),
    h('div', { class: 'status' }, 'Fed by every strip’s Verb send'),
    h('div', { class: 'sect' }, h('div', { class: 'kgrid' }, ctlPot('v:size'), ctlPot('v:tone'))),
    h('div', { style: 'flex:1' }),
    h('div', { class: 'faderzone' }, faderEl('v:vol'), VERB_UI.meter),
    ctlPot('v:vol', 'bare'),
    h('div', { class: 'ms', style: 'grid-template-columns:1fr' }, toggleEl('v:mute', 'mute', 'M')),
    h('div', { class: 'foot' }, h('span', { class: 'note', style: 'font-size:12px' }, ' '))
  );
}
function buildMasterStrip() {
  MASTER_UI.meter = meterEl();
  MASTER_UI.peak = h('b', {}, '-∞'); MASTER_UI.gr = h('b', {}, '0.0');
  return h('div', { class: 'strip master' },
    h('div', { class: 'strip-num' }, h('span', {}, 'Stereo bus'), h('span', { class: 'kind' }, 'Out')),
    h('div', { class: 'strip-name' }, 'Master'),
    h('div', { class: 'sect' }, h('span', { class: 'lbl' }, 'Transport'), h('div', { class: 'ms' }, toggleEl('m:play', 'on', 'Play'), toggleEl('m:rec', 'mute', 'Rec'))),
    h('div', { class: 'sect' }, h('span', { class: 'lbl' }, 'Tempo'), h('div', { class: 'kgrid one' }, ctlPot('m:bpm'))),
    h('div', { class: 'sect' }, h('span', { class: 'lbl' }, 'Bus limiter'), h('div', { class: 'ms', style: 'grid-template-columns:1fr' }, toggleEl('m:limit', 'on', 'Limit')), h('div', { class: 'gr' }, 'Reduction ', MASTER_UI.gr, ' dB')),
    h('div', { style: 'flex:1' }),
    h('div', { class: 'faderzone' }, faderEl('m:vol'), MASTER_UI.meter),
    ctlPot('m:vol', 'bare'),
    h('div', { class: 'readouts' }, h('span', {}, 'Peak ', MASTER_UI.peak))
  );
}
function refreshNames(ch) {
  if (ch.ui.name && document.activeElement !== ch.ui.name) ch.ui.name.value = ch.name;
  if (ch.frame) ch.frame.title = ch.name;
  refreshAppTabs(); refreshMap();
}
function refreshStatus(ch) {
  if (!ch.ui.statusText) return;
  let text = '', cls = '';
  if (ch.type === 'app') {
    if (ch.connected) {
      const audio = (ch.features || []).includes('audio');
      text = audio ? (performance.now() - (ch.lastAudio || -1e9) < 600 ? `Live · ${ch.latency} ms` : 'Connected') : 'No audio link';
      cls = audio ? 'on' : 'wait';
    } else if (ch.noLink) { text = 'Not a guest app'; cls = 'bad'; }
    else { text = 'Loading…'; cls = 'wait'; }
  } else if (ch.type === 'file') { text = ch.buffer ? `${ch.buffer.duration.toFixed(1)} s ${ch.loop !== false ? 'loop' : 'one-shot'}` : 'Audio missing'; cls = ch.buffer ? 'on' : 'bad'; }
  else { text = ch.stream ? 'Input open' : 'Input closed'; cls = ch.stream ? 'on' : 'bad'; }
  ch.ui.statusText.textContent = text;
  ch.ui.led.className = 'led ' + cls;
  if (ch.ui.tabLed) ch.ui.tabLed.className = 'led ' + cls;
}
function refreshChannelTransport(ch) {
  const b = ch.ui.playB; if (!b) return;
  const live = ch.playing, waiting = ch.pending != null;
  b.setAttribute('aria-pressed', String(live));
  b.dataset.armed = String(ch.run);
  b.classList.toggle('cwait', waiting);
  b.innerHTML = live || waiting ? ICON.stop : ICON.play;
  let st;
  if (ch.type === 'input') { ch.ui.state.textContent = ch.stream ? (ch.run ? 'Open' : 'Closed') : 'Not open'; b.setAttribute('aria-pressed', String(!!(ch.run && ch.stream))); b.innerHTML = ch.run && ch.stream ? ICON.stop : ICON.play; return; }
  if (waiting) st = `In at bar ${Math.floor(ch.pending / BEATS_PER_BAR) + 1}`;
  else if (live) st = 'Playing';
  else if (!S.playing) st = ch.run ? 'Armed' : 'Off';
  else st = 'Stopped';
  ch.ui.state.textContent = st;
}
function refreshTransportUI() {
  $('#playBtn').setAttribute('aria-pressed', String(S.playing));
  S.channels.forEach(refreshChannelTransport);
}
function refreshAll() { refreshStrips(); showChannel(S.shown); refreshMap(); }

/* master, reverb, transport controls */
defCtl('m:vol', Object.assign({}, CH.vol, { label: 'Master volume', short: 'Master', get: () => S.master.vol, set: v => { S.master.vol = v; applyMaster(); } }));
defCtl('m:limit', { label: 'Bus limiter', toggle: true, get: () => S.master.limit, set: v => { S.master.limit = v; applyMaster(); } });
defCtl('m:play', { label: 'Play / stop', toggle: true, noSave: true, get: () => S.playing, set: v => { if (v) play(); else stop(); } });
defCtl('m:rec', { label: 'Record', toggle: true, noSave: true, get: () => REC.on || REC.armed, set: v => toggleRecord(v) });
defCtl('m:click', { label: 'Click', toggle: true, get: () => S.click, set: v => { S.click = v; $('#clickBtn').setAttribute('aria-pressed', String(v)); } });
defCtl('m:bpm', { label: 'Tempo', short: 'BPM', min: 20, max: 400, dflt: 120, d: 'bpm', scale: 'log', sens: 600, get: () => currentBpm(), set: v => setTempo(v) });
defCtl('v:size', { label: 'Reverb size', short: 'Size', min: 0.4, max: 8, dflt: 2.6, scale: 'log', d: 's', get: () => S.verb.size, set: v => { S.verb.size = v; clearTimeout(defCtl._vt); defCtl._vt = setTimeout(applyVerb, 120); } });
defCtl('v:tone', { label: 'Reverb tone', short: 'Tone', min: 800, max: 16000, dflt: 6000, scale: 'log', d: 'hz', get: () => S.verb.tone, set: v => { S.verb.tone = v; applyVerb(); } });
defCtl('v:vol', Object.assign({}, CH.vol, { label: 'Reverb return', short: 'Return', dflt: -6, get: () => S.verb.vol, set: v => { S.verb.vol = v; applyVerb(); } }));
defCtl('v:mute', { label: 'Reverb mute', toggle: true, get: () => S.verb.mute, set: v => { S.verb.mute = v; applyVerb(); } });
const MASTER_DEFAULT_MAP = { 'm:vol': 7, 'm:play': 20, 'm:limit': 21, 'm:rec': 22, 'm:bpm': 23, 'm:click': 24, 'v:vol': 25, 'v:size': 26, 'v:tone': 27, 'v:mute': 28 };
for (const [id, num] of Object.entries(MASTER_DEFAULT_MAP)) S.midiMap[id] = { ch: 16, type: 'cc', num };
for (const g of ['m', 'v']) for (const [id, c] of CTL) if (id.startsWith(g + ':')) c.group = () => (g === 'm' ? 'Master' : 'Reverb');

$('#playBtn').addEventListener('click', () => { if (!S.learn) setCtl('m:play', !S.playing); });
$('#stopBtn').addEventListener('click', () => { if (!S.learn) stop(); });
$('#recBtn').addEventListener('click', () => { if (!S.learn) setCtl('m:rec', !(REC.on || REC.armed)); });
$('#recBtn2').addEventListener('click', () => setCtl('m:rec', !(REC.on || REC.armed)));
$('#clickBtn').addEventListener('click', () => { if (!S.learn) { ensureAudio(); setCtl('m:click', !S.click); } });
(() => { const p = ctlPot('m:bpm', 'big'); p.querySelector('.num').setAttribute('aria-label', 'Tempo in BPM'); $('#tempoBox').append(p); })();
document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea,[contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); setCtl('m:play', !S.playing); }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); setCtl('m:rec', !(REC.on || REC.armed)); }
  else if (e.key === 'Escape' && S.learnTarget) setLearnTarget(null);
});
// browsers need a gesture before sound can start
document.addEventListener('pointerdown', () => ensureAudio(), { capture: true, once: true });

/* counter and meters */
function updateCounter() {
  const b = $('#ctrBars'), t = $('#ctrTime'), ctr = $('#counter');
  if (S.playing && S.segs.length) {
    const beat = wallToBeat(wallNow());
    if (beat < 0) { b.textContent = '001.1.1'; t.textContent = 'count-in'; }
    else {
      const bar = Math.floor(beat / BEATS_PER_BAR) + 1, bt = Math.floor(beat % BEATS_PER_BAR) + 1, six = Math.floor((beat % 1) * 4) + 1;
      b.textContent = `${String(bar).padStart(3, '0')}.${bt}.${six}`;
      t.textContent = fmtTime((wallNow() - S.segs[0].anchorWall) / 1000);
    }
  } else { b.textContent = '001.1.1'; t.textContent = '00:00.0'; }
  if (REC.on && AC) { ctr.classList.add('rec'); t.textContent = '● ' + fmtTime(Math.max(0, heardFrame() - REC.f0) / AC.sampleRate); }
  else ctr.classList.remove('rec');
}
function frame() {
  const now = performance.now();
  if (AC) {
    S.channels.forEach(ch => { if (ch.meter && ch.ui.meter) drawMeter(ch.ui.meter, ch.meter.read(), now); });
    if (VERB_METER) drawMeter(VERB_UI.meter, VERB_METER.read(), now);
    if (MASTER_METER && MASTER_UI.meter) {
      const r = MASTER_METER.read(); drawMeter(MASTER_UI.meter, r, now);
      const st = MASTER_UI.meter._m.st; MASTER_UI.peak.textContent = st.max <= -89 ? '-∞' : st.max.toFixed(1);
      MASTER_UI.gr.textContent = (-MASTER.reduction()).toFixed(1);
    }
  }
  updateCounter();
  if (!frame.n || now - frame.n > 400) { frame.n = now; S.channels.forEach(refreshStatus); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// timing work stays off requestAnimationFrame, which stops in background tabs
setInterval(() => { clickTick(); recTick(); }, 25);

/* ================= recorder ================= */
const REC = { on: false, armed: false, f0: 0, f1: 0, startBeat: null, endBeat: null, stems: [] };
function recOpts() { return { mode: $('#recMode').value, bars: +$('#recLen').value, stems: $('#recStems').checked, bits: +$('#recBits').value }; }
function toggleRecord(v) {
  ensureAudio();
  if (!v) {
    if (REC.on && REC.startBeat != null && S.playing) {
      // end cleanly on the next bar line, so the take loops
      const end = Math.max(REC.startBeat + BEATS_PER_BAR, nextBarBeat(0.02));
      if (REC.endBeat == null || end < REC.endBeat) REC.endBeat = end;
      toast(`Stopping on bar ${Math.floor(REC.endBeat / BEATS_PER_BAR) + 1}.`);
    } else if (REC.on) finishRecording(heardFrame());
    else if (REC.armed) { REC.armed = false; stopTaps(); refreshRecUI(); }
    return;
  }
  if (REC.on || REC.armed) return;
  const o = recOpts();
  audioReady.then(() => {
    startTaps(o.stems);
    if (o.mode === 'bar') {
      if (S.playing) beginRecordingAt(nextBarBeat(0.05));
      else { REC.armed = true; toast('Recording is armed: it starts on bar 1 when you press Play.'); }
    } else beginRecordingFree();
    refreshRecUI();
  });
}
function startTaps(stems) {
  MASTER_TAP.start(); MASTER_TAP.rolling(4);
  REC.stems = stems ? S.channels.filter(c => c.tap).map(c => { c.tap.start(); c.tap.rolling(4); return { ch: c, name: c.name }; }) : [];
}
function stopTaps() { MASTER_TAP.stop(); REC.stems.forEach(s => s.ch.tap && s.ch.tap.stop()); }
function beginRecordingAt(beat) {
  const o = recOpts();
  REC.armed = false; REC.on = true; REC.startBeat = beat;
  REC.f0 = frameOfBeat(beat);
  REC.endBeat = o.bars > 0 ? beat + o.bars * BEATS_PER_BAR : null;
  MASTER_TAP.rolling(null); REC.stems.forEach(s => s.ch.tap.rolling(null));
  refreshRecUI();
}
function beginRecordingFree() {
  const o = recOpts();
  REC.armed = false; REC.on = true; REC.f0 = heardFrame();
  REC.startBeat = null;
  REC.endBeat = null; REC.freeLen = o.bars > 0 ? o.bars * BEATS_PER_BAR * 60 / currentBpm() : 0;
  MASTER_TAP.rolling(null); REC.stems.forEach(s => s.ch.tap.rolling(null));
  refreshRecUI();
}
function recTick() {
  if (!REC.on || !AC) return;
  let f1 = null;
  if (REC.endBeat != null && S.playing) f1 = frameOfBeat(REC.endBeat);
  else if (REC.freeLen) f1 = REC.f0 + Math.round(REC.freeLen * AC.sampleRate);
  if (f1 != null && MASTER_TAP.lastFrame() >= f1 + 2048) finishRecording(f1);
}
function finishRecording(f1) {
  if (!REC.on) return;
  if (f1 == null) f1 = REC.endBeat != null ? frameOfBeat(REC.endBeat) : heardFrame();
  // stopping before a bar-synced start has arrived: nothing to keep
  const sr = AC.sampleRate, f0 = REC.f0;
  REC.on = false;
  const wait = () => {
    if (MASTER_TAP.lastFrame() < f1 && MASTER_TAP.running()) { setTimeout(wait, 30); return; }
    const mb = MASTER_TAP.stop();
    const stems = REC.stems.map(s => ({ name: s.name, blocks: s.ch.tap ? s.ch.tap.stop() : [] }));
    REC.stems = [];
    if (f1 - f0 < sr * 0.05) { toast('Nothing was recorded.'); refreshRecUI(); return; }
    const { L, R } = MixCore.cut(mb, f0, f1);
    const bars = REC.startBeat != null && REC.endBeat != null ? (REC.endBeat - REC.startBeat) / BEATS_PER_BAR : null;
    const take = { id: Date.now(), name: `${S.name} take ${S.takes.length + 1}`, L, R, sr, bpm: currentBpm(), bars,
      stems: stems.map(s => Object.assign({ name: s.name }, MixCore.cut(s.blocks, f0, f1))) };
    S.takes.push(take);
    refreshTakes(); refreshRecUI();
    toast(`Recorded ${(L.length / sr).toFixed(1)} s${bars ? ` (${bars} bars)` : ''}.`);
  };
  refreshRecUI();
  wait();
}
function refreshRecUI() {
  const st = REC.on ? 'on' : REC.armed ? 'armed' : 'off';
  $('#recBtn').dataset.state = st;
  $('#recBtn2').textContent = REC.on ? '■ Stop recording' : REC.armed ? '■ Disarm' : '● Record';
  $('#recBtn2').classList.toggle('primary', !REC.on && !REC.armed);
  syncCtl('m:rec');
}
function refreshTakes() {
  const box = $('#takes'); box.innerHTML = '';
  if (!S.takes.length) { box.append(h('p', { class: 'note' }, 'No takes yet. Press Record (or R) to capture the mix.')); return; }
  S.takes.slice().reverse().forEach(t => {
    const name = h('input', { class: 'tn', value: t.name, 'aria-label': 'Take name' });
    name.addEventListener('change', () => { t.name = name.value.trim() || t.name; });
    const cv = h('canvas', { width: 360, height: 60, 'aria-hidden': 'true' });
    drawWave(cv, t.L, t.R);
    const pk = g2db(MixCore.peakOf(t.L, t.R));
    const audio = h('audio', { controls: true, preload: 'none', style: 'height:32px;max-width:100%' });
    let url = null;
    audio.addEventListener('play', () => { if (!url) { url = URL.createObjectURL(MixCore.wavBlob(t.L, t.R, t.sr, 16)); audio.src = url; audio.play(); } }, { once: false });
    const fname = ext => slug(t.name) + '.' + ext;
    box.append(h('div', { class: 'take' },
      name, cv,
      h('span', { class: 'meta' }, `${(t.L.length / t.sr).toFixed(2)} s${t.bars ? ` · ${t.bars} bars` : ''} · ${t.bpm} BPM · peak ${pk.toFixed(1)} dBFS`),
      h('button', { class: 'btn small', onclick: () => { audio.hidden = !audio.hidden; } }, 'Listen'),
      h('button', { class: 'btn small primary', onclick: () => download(MixCore.wavBlob(t.L, t.R, t.sr, +$('#recBits').value), fname('wav')) }, 'WAV'),
      h('button', { class: 'btn small', onclick: () => { try { download(MixCore.mp3Blob(t.L, t.R, t.sr, 256), fname('mp3')); } catch (e) { toast('The MP3 encoder did not load. WAV works offline.'); } } }, 'MP3'),
      t.stems.length ? h('button', { class: 'btn small', onclick: () => downloadStems(t) }, `Stems (${t.stems.length})`) : null,
      h('button', { class: 'btn small', onclick: e => { const b = e.currentTarget; if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Sure?'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Delete'; } }, 2500); return; } S.takes = S.takes.filter(x => x !== t); if (url) URL.revokeObjectURL(url); refreshTakes(); } }, 'Delete'),
      audio));
    audio.hidden = true;
  });
}
async function downloadStems(t) {
  const bits = +$('#recBits').value;
  const files = t.stems.map((st, i) => ({ name: `${String(i + 1).padStart(2, '0')}-${slug(st.name)}.wav`, blob: MixCore.wavBlob(st.L, st.R, t.sr, bits) }));
  files.unshift({ name: `00-mix-${slug(t.name)}.wav`, blob: MixCore.wavBlob(t.L, t.R, t.sr, bits) });
  if (window.JamClips && JamClips.zipBlob) {
    try {
      const withData = await Promise.all(files.map(async f => ({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) })));
      download(JamClips.zipBlob(withData), slug(t.name) + '-stems.zip');
      return;
    } catch (e) {}
  }
  files.forEach(f => download(f.blob, slug(t.name) + '-' + f.name));
}
function drawWave(cv, L, R) {
  const c = cv.getContext('2d'), W = cv.width, H = cv.height, n = L.length, step = Math.max(1, Math.floor(n / W));
  c.clearRect(0, 0, W, H);
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--oxide-hi').trim() || '#dc8a50';
  for (let x = 0; x < W; x++) {
    let mx = 0; const s = x * step, e = Math.min(n, s + step);
    for (let i = s; i < e; i += 4) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > mx) mx = a; if (b > mx) mx = b; }
    const hh = Math.max(1, mx * H); c.fillRect(x, (H - hh) / 2, 1, hh);
  }
}
const slug = s => String(s || 'take').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'take';
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name, style: 'display:none' });
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
}
for (const id of ['recMode', 'recLen', 'recStems', 'recBits']) $('#' + id).addEventListener('change', () => { S.rec = recOpts(); saveSoon(); });
window.addEventListener('beforeunload', e => { if (S.takes.length) { e.preventDefault(); e.returnValue = ''; } });

/* ================= shared ecosystem export (jam-clips) =================
   The desk is a source like every other app: the Export bar saves the last N bars of the mix as WAV,
   with the console's fader, pan and mute moves as MIDI controller tracks, and Tape Loop Deck can grab
   bar-exact clips of the whole mix. */
let jamSource = null;
if (window.JamClips) {
  jamSource = JamClips.source({
    app: 'mixdesk', title: 'Mixing Desk',
    ctx: () => AC, nodes: () => MASTER ? [MASTER.post] : [],
    grid: { barAt: t => (S.playing && S.segs.length && AC) ? wallToBeat(MixCore.wallAtCtx(AC, t)) / BEATS_PER_BAR : null,
            timeOfBar: k => (S.playing && S.segs.length && AC) ? MixCore.ctxAtWall(AC, beatToWall(k * BEATS_PER_BAR)) : null },
    bpm: () => currentBpm(), beatsPerBar: BEATS_PER_BAR
  });
  jamSource.mount($('#exportBar'), { btn: 'btn small', primary: 'btn small primary', select: 'sel', title: 'Export' });
}
function logAutomation(c, v) {
  if (!jamSource || !AC || !c.chId) return;
  const num = DEFAULT_CC[c.key]; if (num == null) return;
  const ch = S.channels.find(x => x.id === c.chId); if (!ch) return;
  const val = c.toggle ? (v ? 127 : 0) : Math.round(clamp(norm(c, v), 0, 1) * 127);
  try { jamSource.cc(AC.currentTime, num, val, ch.name, ch.midiCh || 1); } catch (e) {}
}

/* ================= MIDI ================= */
let midiAccess = null;
const lastCC = {};
async function initMIDI() {
  const st = $('#midiStatus');
  if (!navigator.requestMIDIAccess) { st.textContent = 'This browser does not support Web MIDI. Chrome, Edge and Opera do.'; return; }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const bind = () => {
      const names = [];
      midiAccess.inputs.forEach(i => { i.onmidimessage = onMidi; names.push(i.name); });
      st.textContent = names.length ? 'Listening to ' + names.join(', ') : 'MIDI is on, but no input devices are connected.';
      $('#midiLed').classList.toggle('on', names.length > 0);
      $('#midiConnect').textContent = 'Rescan';
    };
    midiAccess.onstatechange = bind; bind();
  } catch (e) { st.textContent = 'MIDI access was blocked.'; }
}
$('#midiConnect').addEventListener('click', initMIDI);
function onMidi(e) {
  const [st, d1, d2 = 0] = e.data; const hi = st & 0xF0, ch = (st & 0x0F) + 1;
  let type = null, on = false;
  if (hi === 0xB0) type = 'cc';
  else if (hi === 0x90 || hi === 0x80) { type = 'note'; on = hi === 0x90 && d2 > 0; }
  if (!type) return;
  $('#midiMon').textContent = `ch${String(ch).padStart(2, '0')} ${type === 'cc' ? 'CC' : 'Note'} ${String(d1).padStart(3, ' ')} = ${String(d2).padStart(3, ' ')}`;
  if (S.learnTarget) {
    if (type === 'note' && !on) return;
    for (const [id, om] of Object.entries(S.midiMap)) if (om.ch === ch && om.type === type && om.num === d1) delete S.midiMap[id];
    S.midiMap[S.learnTarget] = { ch, type, num: d1 };
    toast(`Mapped ${ctlLabel(S.learnTarget)} to ch ${ch} ${type === 'cc' ? 'CC' : 'note'} ${d1}`);
    setLearnTarget(null); refreshBadges(); refreshMap(); saveSoon();
    return;
  }
  for (const [id, m] of Object.entries(S.midiMap)) {
    if (m.ch !== ch || m.type !== type || m.num !== d1) continue;
    const c = CTL.get(id); if (!c) continue;
    if (c.toggle) {
      if (type === 'cc') { const prev = lastCC[id] ?? 0; lastCC[id] = d2; if (d2 >= 64 && prev < 64) setCtl(id, !c.get()); }
      else if (on) setCtl(id, !c.get());
    } else if (type === 'cc' || on) setCtl(id, denorm(c, d2 / 127));
  }
}
function setLearnTarget(id) {
  document.querySelectorAll('.is-target').forEach(el => el.classList.remove('is-target'));
  S.learnTarget = id;
  if (id) {
    document.querySelectorAll(`[data-ctl="${CSS.escape(id)}"]`).forEach(el => el.classList.add('is-target'));
    $('#learnText').textContent = `Move a knob, fader or pad on your MIDI device to map “${ctlLabel(id)}”. Esc cancels.` + (midiAccess ? '' : ' MIDI isn’t connected yet.');
  } else $('#learnText').textContent = 'Click a knob, fader or button, then move a control on your MIDI device.';
}
function setLearn(on) {
  S.learn = on; document.body.classList.toggle('learning', on);
  $('#learnBtn').setAttribute('aria-pressed', String(on));
  if (!on) setLearnTarget(null); else if (!midiAccess) initMIDI();
}
$('#learnBtn').addEventListener('click', () => setLearn(!S.learn));
$('#learnDone').addEventListener('click', () => setLearn(false));
document.addEventListener('pointerdown', e => {
  if (!S.learn) return;
  const el = e.target.closest('[data-ctl]'); if (!el) return;
  e.preventDefault(); e.stopPropagation(); setLearnTarget(el.dataset.ctl);
}, true);
document.addEventListener('click', e => { if (S.learn && e.target.closest('[data-ctl]')) { e.preventDefault(); e.stopPropagation(); } }, true);
function refreshBadges() {
  document.querySelectorAll('[data-mb]').forEach(el => { const m = S.midiMap[el.dataset.mb]; el.textContent = m ? `${m.type === 'cc' ? 'CC' : 'N'}${m.num}·${m.ch}` : ''; });
}
function refreshMap() {
  const body = $('#mapBody'); if (!body) return; body.innerHTML = '';
  const groups = [['Transport, master and reverb', Object.keys(MASTER_DEFAULT_MAP)]];
  S.channels.forEach((c, i) => groups.push([`Ch ${String(i + 1).padStart(2, '0')} · ${c.name}`, Object.keys(CH).map(k => `c${c.id}:${k}`)]));
  for (const [g, ids] of groups) {
    body.append(h('tr', { class: 'grp' }, h('td', { colspan: 5 }, g)));
    for (const id of ids) {
      const c = CTL.get(id); if (!c) continue;
      const m = S.midiMap[id];
      const chS = h('select', { 'aria-label': 'Channel' }, h('option', { value: 0 }, '—'), ...Array.from({ length: 16 }, (_, j) => h('option', { value: j + 1 }, String(j + 1))));
      const tyS = h('select', { 'aria-label': 'Type' }, h('option', { value: 'cc' }, 'CC'), h('option', { value: 'note' }, 'Note'));
      const numI = h('input', { type: 'number', min: 0, max: 127, 'aria-label': 'Number' });
      chS.value = m ? m.ch : 0; tyS.value = m ? m.type : 'cc'; numI.value = m ? m.num : '';
      const commit = () => {
        const ch = +chS.value, num = numI.value === '' ? null : clamp(Math.round(+numI.value), 0, 127);
        if (!ch || num == null) delete S.midiMap[id];
        else { for (const [o, om] of Object.entries(S.midiMap)) if (o !== id && om.ch === ch && om.type === tyS.value && om.num === num) delete S.midiMap[o]; S.midiMap[id] = { ch, type: tyS.value, num }; }
        refreshBadges(); saveSoon();
      };
      chS.addEventListener('change', () => { if (+chS.value && numI.value === '') numI.value = DEFAULT_CC[c.key] ?? MASTER_DEFAULT_MAP[id] ?? 1; commit(); });
      tyS.addEventListener('change', commit); numI.addEventListener('change', commit);
      body.append(h('tr', {}, h('td', {}, c.label), h('td', {}, chS), h('td', {}, tyS), h('td', {}, numI),
        h('td', {}, h('button', { class: 'btn small', onclick: () => { if (!S.learn) setLearn(true); setLearnTarget(id); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, 'Learn'), ' ',
          h('button', { class: 'btn small', onclick: () => { delete S.midiMap[id]; refreshBadges(); refreshMap(); saveSoon(); } }, 'Clear'))));
    }
  }
}

/* ================= project: save, open, session memory ================= */
// In saved files strip controls are keyed by position (i0:vol), since channel ids change on load.
function portableMap() {
  const out = {};
  for (const [id, m] of Object.entries(S.midiMap)) {
    const mm = /^c(\d+):(\w+)$/.exec(id);
    if (!mm) { out[id] = m; continue; }
    const i = S.channels.findIndex(c => c.id === +mm[1]); if (i >= 0) out[`i${i}:${mm[2]}`] = m;
  }
  return out;
}
function snapshot(withAudio) {
  return {
    app: 'mixing-desk', v: 1, name: S.name, bpm: S.bpm, click: S.click,
    verb: S.verb, master: S.master, rec: S.rec, midiMap: portableMap(),
    channels: S.channels.map(c => ({
      type: c.type, name: c.name, renamed: !!c.renamed, url: c.url, p: c.p, run: c.run, midiCh: c.midiCh,
      state: c.state, latency: c.latency, loop: c.loop, fileName: c.fileName,
      audio: withAudio && c.type === 'file' && c.bytes ? b64(c.bytes) : undefined
    }))
  };
}
let saveTimer = 0, restoring = false;
function saveSoon() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem('mixdesk:session', JSON.stringify(snapshot(false))); } catch (e) {} }, 800);
}
function b64(buf) { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
const syncAllCtls = () => { for (const id of CTL.keys()) syncCtl(id); };
const cleanMap = m => m && typeof m === 'object' && +m.ch >= 1 && +m.ch <= 16 && +m.num >= 0 && +m.num <= 127 ? { ch: +m.ch, type: m.type === 'note' ? 'note' : 'cc', num: +m.num } : null;
async function restore(data) {
  if (!data || data.app !== 'mixing-desk') throw new Error('not a Mixing Desk project');
  restoring = true;
  try {
    if (S.playing) stop();
    S.channels.slice().forEach(removeChannel);
    S.name = typeof data.name === 'string' ? data.name.slice(0, 60) : 'mix-session'; $('#projName').value = S.name;
    S.bpm = clamp(+data.bpm || 120, 20, 400);
    Object.assign(S.verb, data.verb || {}); Object.assign(S.master, data.master || {});
    if (data.rec) { $('#recMode').value = data.rec.mode === 'free' ? 'free' : 'bar'; $('#recLen').value = String(data.rec.bars || 0); $('#recStems').checked = !!data.rec.stems; $('#recBits').value = String(data.rec.bits || 24); S.rec = recOpts(); }
    const pending = [], made = [];
    for (const c of (Array.isArray(data.channels) ? data.channels : [])) {
      const opts = { name: String(c.name || 'Channel').slice(0, 40), renamed: !!c.renamed, p: c.p || {}, run: c.run !== false, midiCh: +c.midiCh || 0, restoring: true,
        state: c.state, latency: clamp(+c.latency || MixCore.GUEST_LATENCY_MS, 60, 480), loop: c.loop !== false, fileName: c.fileName };
      let ch = null;
      if (c.type === 'app' && typeof c.url === 'string') { try { const u = new URL(c.url); if (/^https?:$/.test(u.protocol)) ch = newChannel('app', Object.assign(opts, { url: u.href })); } catch (e) {} }
      else if (c.type === 'file') {
        ch = newChannel('file', Object.assign(opts, { missing: !c.audio }));
        if (c.audio) pending.push(addFileChannel(new File([unb64(c.audio)], c.fileName || 'audio'), { into: ch }));
      } else if (c.type === 'input') ch = newChannel('input', Object.assign(opts, { missing: true, run: false }));
      made.push(ch);   // positions line up with the saved MIDI map
    }
    // MIDI map: positions (i0:vol) become this session's channel ids
    const map = data.midiMap && typeof data.midiMap === 'object' ? data.midiMap : {};
    S.midiMap = {};
    for (const [id, m0] of Object.entries(map)) {
      const m = cleanMap(m0); if (!m) continue;
      const pm = /^i(\d+):(\w+)$/.exec(id);
      if (pm) { const ch = made[+pm[1]]; if (ch && CH[pm[2]]) S.midiMap[`c${ch.id}:${pm[2]}`] = m; }
      else if (CTL.has(id) && !/^c\d+:/.test(id)) S.midiMap[id] = m;
    }
    applyMaster(); applyVerb(); applyAll();
    if (data.click) setCtl('m:click', true);
    await Promise.all(pending);
  } finally { restoring = false; }
  refreshAll(); syncAllCtls(); refreshBadges(); saveSoon();
}

$('#openSheet').addEventListener('click', () => { $('#sheet').hidden = false; });
$('#closeSheet').addEventListener('click', () => { $('#sheet').hidden = true; });
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') $('#sheet').hidden = true; });
$('#projName').addEventListener('change', e => { S.name = e.target.value.trim() || 'mix-session'; saveSoon(); });
$('#saveProj').addEventListener('click', async () => {
  await captureAllStates();
  download(new Blob([JSON.stringify(snapshot(true))], { type: 'application/json' }), slug(S.name) + '.mixdesk.json');
});
$('#loadProjBtn').addEventListener('click', () => $('#projIn').click());
$('#projIn').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { await restore(JSON.parse(await f.text())); $('#sheet').hidden = true; toast(`Opened ${S.name}.`); }
  catch (err) { restoring = false; toast('That file is not a Mixing Desk project.'); }
});
$('#newProj').addEventListener('click', e => {
  const b = e.currentTarget;
  if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Press again to clear'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'Clear the desk'; }, 2500); return; }
  delete b.dataset.armed; b.textContent = 'Clear the desk';
  if (S.playing) stop();
  S.channels.slice().forEach(removeChannel);
  $('#sheet').hidden = true; toast('The desk is clear.');
});

/* ================= theme ================= */
// dark by default (the house style); the Light button switches to the Logic-Rhythm colorway
const effectiveTheme = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
function onThemeChange() {
  const light = effectiveTheme() === 'light', b = $('#themeBtn');
  b.textContent = light ? '☾ Dark' : '☀ Light';
  b.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  if (S.takes.length) refreshTakes();
}
$('#themeBtn').addEventListener('click', () => {
  const next = effectiveTheme() === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('mixdesk:theme', next); } catch (e) {}
});
try { const th = localStorage.getItem('mixdesk:theme'); if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th; } catch (e) {}
new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
onThemeChange();

/* ================= start ================= */
(async () => {
  let v = 'console';
  try { const sv = localStorage.getItem('mixdesk:view'); if (['apps', 'both', 'console'].includes(sv)) v = sv; } catch (e) {}
  setView(v);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('mixdesk:session') || 'null'); } catch (e) {}
  if (saved && saved.app === 'mixing-desk' && saved.channels && saved.channels.length) {
    try { await restore(saved); } catch (e) { restoring = false; refreshAll(); }
  } else refreshAll();
  syncAllCtls(); refreshTakes(); refreshRecUI();
})();
