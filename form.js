/* Form — the desk's song-form conductor (Form Link). Loaded after desk.js and uses its transport.
   Instead of chaining patterns, a chart of sections (A, B, C, D) sets the key, mode, length and feel
   while the apps keep generating on their own clocks and gates. Each bar, one beat before its
   downbeat, the desk sends a `bar` message to every hosted app (guest message type "form") and on the
   aaronvandorn-form-v1 BroadcastChannel for apps open in other tabs. FORM-LINK.md has the format.
   Optional guide voices (gate melody, quartal choir, logic drums) play the chart into the master bus. */
(function () {
  'use strict';
  const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  // mode ids match Jam Link; `color` is the characteristic degree in semitones above the root
  const MODES = {
    major: { name: 'Major (Ionian)', pcs: [0, 2, 4, 5, 7, 9, 11], color: null },
    minor: { name: 'Minor (Aeolian)', pcs: [0, 2, 3, 5, 7, 8, 10], color: 8 },
    dorian: { name: 'Dorian', pcs: [0, 2, 3, 5, 7, 9, 10], color: 9 },
    phrygian: { name: 'Phrygian', pcs: [0, 1, 3, 5, 7, 8, 10], color: 1 },
    lydian: { name: 'Lydian', pcs: [0, 2, 4, 6, 7, 9, 11], color: 6 },
    mixolydian: { name: 'Mixolydian', pcs: [0, 2, 4, 5, 7, 9, 10], color: 10 },
    locrian: { name: 'Locrian', pcs: [0, 1, 3, 5, 6, 8, 10], color: 6 },
    majPent: { name: 'Major Pentatonic', pcs: [0, 2, 4, 7, 9], color: null },
    minPent: { name: 'Minor Pentatonic', pcs: [0, 3, 5, 7, 10], color: null },
    blues: { name: 'Blues', pcs: [0, 3, 5, 6, 7, 10], color: 6 },
    harmMinor: { name: 'Harmonic Minor', pcs: [0, 2, 3, 5, 7, 8, 11], color: 11 }
  };
  const LETTERS = ['A', 'B', 'C', 'D'];
  const ENTER_HINT = {
    hard: 'The new key and mode land on the downbeat.',
    pivot: 'For the first bar, only the notes both scales share, then the full new scale.',
    anticipate: 'In the last beat before this section, the music leans into its key early.'
  };
  const sec = (root, mode, length, feel, enter) => ({ root, mode, length, feel, enter: enter || 'hard' });
  const PRESETS = {
    bridge: { name: 'Half-step bridge', order: ['A', 'A', 'B', 'A'], sections: {
      A: sec(2, 'dorian', { type: 'fixed', bars: 8 }, { density: .4, register: .45, brightness: .45 }),
      B: sec(3, 'dorian', { type: 'fixed', bars: 8 }, { density: .6, register: .6, brightness: .65 }) } },
    colors: { name: 'Three colors', order: ['A', 'B', 'A', 'C'], sections: {
      A: sec(0, 'lydian', { type: 'fixed', bars: 8 }, { density: .35, register: .55, brightness: .75 }),
      B: sec(9, 'minor', { type: 'fixed', bars: 8 }, { density: .5, register: .45, brightness: .4 }, 'pivot'),
      C: sec(4, 'phrygian', { type: 'fixed', bars: 4 }, { density: .75, register: .35, brightness: .3 }, 'anticipate') } },
    vamp: { name: 'Open vamp', order: ['A', 'B'], sections: {
      A: sec(5, 'dorian', { type: 'vamp', min: 8, max: 32, rule: { kind: 'gate', a: 3, b: 5, op: 'AND' } }, { density: .4, register: .5, brightness: .5 }),
      B: sec(8, 'mixolydian', { type: 'vamp', min: 4, max: 16, rule: { kind: 'chance', pct: 25 } }, { density: .7, register: .6, brightness: .7 }, 'pivot') } }
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  const freshChart = k => Object.assign({ v: 1, loop: true }, clone(PRESETS[k]));

  const F = {
    on: true,
    chart: freshChart('bridge'),
    guide: { melody: false, choir: false, drums: false, level: 0.5 },
    editing: 'A'
  };
  try { const s = JSON.parse(localStorage.getItem('mixdesk:form')); if (s) load(s, true); } catch (e) {}

  /* ---------------- chart validation ---------------- */
  function cleanSection(s) {
    if (!s || typeof s !== 'object') return null;
    const out = { root: clamp(Math.round(+s.root) || 0, 0, 11), mode: MODES[s.mode] ? s.mode : 'dorian',
      enter: ENTER_HINT[s.enter] ? s.enter : 'hard', feel: {} };
    ['density', 'register', 'brightness'].forEach(k => { out.feel[k] = clamp(isFinite(+(s.feel || {})[k]) ? +s.feel[k] : .5, 0, 1); });
    const L = s.length || {};
    if (L.type === 'vamp') {
      const min = clamp(Math.round(+L.min) || 8, 1, 64), max = clamp(Math.round(+L.max) || 32, min, 128);
      const r = L.rule || {};
      out.length = { type: 'vamp', min, max, rule: r.kind === 'chance'
        ? { kind: 'chance', pct: clamp(Math.round(+r.pct) || 25, 1, 100) }
        : { kind: 'gate', a: clamp(Math.round(+r.a) || 3, 1, 16), b: clamp(Math.round(+r.b) || 5, 1, 16), op: ['AND', 'OR', 'XOR'].includes(r.op) ? r.op : 'AND' } };
    } else out.length = { type: 'fixed', bars: clamp(Math.round(+L.bars) || 8, 1, 64) };
    return out;
  }
  function cleanChart(c) {
    if (!c || typeof c !== 'object' || !c.sections) return null;
    const sections = {};
    LETTERS.forEach(L => { const s = cleanSection(c.sections[L]); if (s) sections[L] = s; });
    const order = (Array.isArray(c.order) ? c.order : []).filter(L => sections[L]).slice(0, 64);
    if (!order.length) return null;
    return { v: 1, loop: true, name: typeof c.name === 'string' ? c.name.slice(0, 60) : 'Your chart', order, sections };
  }
  function save() { return { on: F.on, chart: F.chart, guide: F.guide }; }
  function load(d, quiet) {
    if (!d || typeof d !== 'object') return;
    const c = cleanChart(d.chart); if (c) F.chart = c;
    if (typeof d.on === 'boolean') F.on = d.on;
    if (d.guide && typeof d.guide === 'object') ['melody', 'choir', 'drums'].forEach(k => { F.guide[k] = !!d.guide[k]; });
    if (d.guide && isFinite(+d.guide.level)) F.guide.level = clamp(+d.guide.level, 0, 1);
    F.editing = F.chart.order[0];
    if (!quiet) { renderAll(); sendChart(); }
  }
  function persist() {
    try { localStorage.setItem('mixdesk:form', JSON.stringify(save())); } catch (e) {}
    if (typeof saveSoon === 'function') saveSoon();
  }

  /* ---------------- form engine ---------------- */
  let fs = null; // live state while the desk plays
  const scaleOf = s => MODES[s.mode].pcs.map(p => (p + s.root) % 12);
  const lenOf = s => s.length.type === 'fixed' ? s.length.bars : null;
  const nextIndex = i => (i + 1) % F.chart.order.length;
  function ruleFires(s, n) {
    const r = s.length.rule;
    if (r.kind === 'chance') return Math.random() * 100 < r.pct;
    const a = n % r.a === 0, b = n % r.b === 0;
    return r.op === 'AND' ? (a && b) : r.op === 'OR' ? (a || b) : (a !== b);
  }
  // Decided at the start of each bar: is bar k (0-based) the section's last?
  function decideLast(s, k) {
    let natural;
    if (s.length.type === 'fixed') natural = k >= s.length.bars - 1;
    else { const n = k + 1; natural = n >= s.length.max ? true : n < s.length.min ? false : ruleFires(s, n); }
    if (natural) { fs.cue = false; fs.cueArmed = false; return true; }
    if (fs.cueArmed) { fs.cueArmed = false; return true; }
    if (fs.cue) { fs.cue = false; fs.cueArmed = true; }   // a cue ends the section after the following bar
    return false;
  }
  function startForm() { fs = { index: 0, bar: 0, barInSection: 0, last: false, changed: true, cue: false, cueArmed: false, prev: null, ctx: null, bars: new Map(), nextBar: 0, nextStep: null }; }
  function advanceBar() {
    if (fs.bar > 0) {
      if (fs.last) { fs.prevScale = fs.ctx ? fs.ctx.fullScale : null; fs.index = nextIndex(fs.index); fs.barInSection = 0; fs.changed = true; }
      else { fs.barInSection++; fs.changed = false; }
    }
    if (fs.index >= F.chart.order.length) fs.index = 0;
    const L = F.chart.order[fs.index], s = F.chart.sections[L];
    const nL = F.chart.order[nextIndex(fs.index)], ns = F.chart.sections[nL];
    fs.last = decideLast(s, fs.barInSection);
    const full = scaleOf(s);
    let scale = full;
    if (fs.changed && s.enter === 'pivot' && fs.prevScale) { const common = full.filter(p => fs.prevScale.includes(p)); if (common.length >= 3) scale = common; }
    const len = lenOf(s);
    const c = { section: L, index: fs.index, bar: fs.bar, barInSection: fs.barInSection, last: fs.last,
      barsLeft: len ? len - fs.barInSection : (fs.last ? 1 : null), root: s.root, mode: s.mode, scale, fullScale: full,
      feel: Object.assign({}, s.feel), enter: s.enter, changed: fs.changed,
      next: { section: nL, root: ns.root, mode: ns.mode, enter: ns.enter }, nextScale: scaleOf(ns) };
    fs.ctx = c; fs.bars.set(fs.bar, c);
    if (fs.bars.size > 8) fs.bars.delete(Math.min(...fs.bars.keys()));
    fs.bar++;
    return c;
  }

  /* ---------------- messages ---------------- */
  const myId = Math.random().toString(36).slice(2, 10);
  let fch = null; try { fch = new BroadcastChannel('aaronvandorn-form-v1'); } catch (e) {}
  if (fch) fch.onmessage = e => { const m = e.data; if (m && m.v === 1 && m.t === 'chart-request' && m.from !== myId) post({ t: 'chart', chart: F.chart }); };
  const appChannels = () => S.channels.filter(c => c.type === 'app' && c.connected);
  function post(msg) {
    msg.v = 1; msg.from = myId;
    if (fch) { try { fch.postMessage(msg); } catch (e) {} }
    // hosted apps get it as a guest message; apps that don't know "form" ignore it
    appChannels().forEach(ch => guestSend(ch, Object.assign({ type: msg.t === 'bar' ? 'form' : 'form-chart' }, clone(msg))));
    logBus(msg);
  }
  function sendChart() { if (F.on) post({ t: 'chart', chart: F.chart }); }
  function sendBar(c) {
    const beat = c.bar * BEATS_PER_BAR;
    post({ t: 'bar', wall: beatToWall(beat), sharedBeat: beat, bar: c.bar, section: c.section, index: c.index,
      barInSection: c.barInSection, barsLeft: c.barsLeft, last: c.last, root: c.root, mode: c.mode, scale: c.scale,
      feel: c.feel, enter: c.enter, changed: c.changed, next: c.next });
  }

  /* ---------------- guide voices ---------------- */
  let out = null, noiseBuf = null;
  function ensureOut() {
    if (out || !AC || !MASTER) return out;
    out = AC.createGain(); out.gain.value = F.guide.level; out.connect(MASTER.bus);
    noiseBuf = AC.createBuffer(1, AC.sampleRate, AC.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return out;
  }
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  function melodyNote(t, midi, dur, bright, vel) {
    const o = AC.createOscillator(), o2 = AC.createOscillator(), f = AC.createBiquadFilter(), g = AC.createGain(), g2 = AC.createGain();
    o.type = 'triangle'; o2.type = 'square'; o.frequency.value = mtof(midi); o2.frequency.value = mtof(midi - 12); g2.gain.value = .18;
    f.type = 'lowpass'; f.Q.value = 4;
    const fc = 600 + bright * 3400;
    f.frequency.setValueAtTime(fc * 1.8, t); f.frequency.exponentialRampToValueAtTime(Math.max(200, fc * .4), t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(.22 * vel, t + .006); g.gain.exponentialRampToValueAtTime(.0008, t + dur);
    o.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(out);
    o.start(t); o2.start(t); o.stop(t + dur + .05); o2.stop(t + dur + .05);
  }
  const VOWELS = { oo: [300, 870, 2240], o: [450, 800, 2830], ah: [730, 1090, 2440], eh: [530, 1840, 2480] };
  function choirChord(t, notes, dur, bright) {
    const vw = bright < .3 ? 'oo' : bright < .55 ? 'o' : bright < .8 ? 'ah' : 'eh';
    const bus = AC.createGain();
    bus.gain.setValueAtTime(0, t); bus.gain.linearRampToValueAtTime(.07, t + Math.min(.6, dur * .3)); bus.gain.setValueAtTime(.07, t + dur * .75); bus.gain.linearRampToValueAtTime(0, t + dur);
    [1, .5, .25].forEach((amp, i) => { const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = VOWELS[vw][i]; bp.Q.value = 8; const a = AC.createGain(); a.gain.value = amp * 3; bus.connect(bp); bp.connect(a); a.connect(out); });
    notes.forEach(m => [-6, 6].forEach(cents => {
      const o = AC.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = cents + (Math.random() * 4 - 2);
      const vib = AC.createOscillator(), vg = AC.createGain(); vib.frequency.value = 4.6 + Math.random() * .8; vg.gain.value = 5; vib.connect(vg); vg.connect(o.detune);
      o.connect(bus); o.start(t); vib.start(t); o.stop(t + dur + .05); vib.stop(t + dur + .05);
    }));
  }
  function noiseHit(t, dur, type, freq, q, amp) {
    const s = AC.createBufferSource(); s.buffer = noiseBuf; const f = AC.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; const g = AC.createGain();
    g.gain.setValueAtTime(amp, t); g.gain.exponentialRampToValueAtTime(.0005, t + dur); s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random() * .5); s.stop(t + dur + .02);
  }
  function kick(t, reg) {
    const o = AC.createOscillator(), g = AC.createGain(), base = 42 + reg * 18;
    o.frequency.setValueAtTime(base * 3.2, t); o.frequency.exponentialRampToValueAtTime(base, t + .12);
    g.gain.setValueAtTime(.9, t); g.gain.exponentialRampToValueAtTime(.001, t + .38); o.connect(g); g.connect(out); o.start(t); o.stop(t + .4);
  }
  function melodyStep(t, step, c, stepDur) {
    const d = c.feel.density, s16 = step % 16;
    const pa = d < .34 ? 2 : 3, pb = d < .34 ? 3 : (d < .67 ? 4 : 5);
    const a = step % pa === 0, b = step % pb === 0;
    let gate = d < .34 ? (a && b) : d < .67 ? (a !== b) : (a || b);
    let scale = c.scale, target = null;
    const ant = c.last && c.next.enter === 'anticipate' && s16 >= 12;
    if (ant) { scale = c.nextScale; if (s16 === 12) { gate = true; target = c.next.root; } }
    if (!gate) return;
    const v = clamp(.5 + .32 * Math.sin(step * .19 + Math.sin(step * .047) * 2) + .18 * (Math.random() * 2 - 1), 0, 1); // S&H of a wandering LFO
    const center = 55 + c.feel.register * 20, lo = Math.round(center - 8), hi = Math.round(center + 9);
    const pool = []; for (let m = lo; m <= hi; m++) if (scale.includes(m % 12)) pool.push(m);
    if (!pool.length) return;
    let midi = pool[Math.round(v * (pool.length - 1))];
    const mode = MODES[ant ? c.next.mode : c.mode], rootPc = ant ? c.next.root : c.root;
    if (target !== null) { const rs = pool.filter(m => m % 12 === target).sort((x, y) => Math.abs(x - center) - Math.abs(y - center)); if (rs.length) midi = rs[0]; }
    else if (mode.color !== null && Math.random() < .12 + c.feel.brightness * .18) { const cand = pool.filter(m => m % 12 === (mode.color + rootPc) % 12); if (cand.length) midi = cand[0]; }
    if (c.changed && s16 === 0) { const r = pool.find(m => m % 12 === c.root); if (r) midi = r; }
    melodyNote(t, midi, stepDur * (1.2 + Math.random() * 1.4), c.feel.brightness, s16 % 4 === 0 ? 1 : .75);
  }
  function quartal(scale, rootPc, reg) {
    const deg = scale.slice().sort((x, y) => ((x - rootPc + 12) % 12) - ((y - rootPc + 12) % 12));
    let start = 45 + Math.round(reg * 10); while (start % 12 !== rootPc) start++;
    const notes = [start]; let last = start + 2;
    [3, 6, 2].forEach(di => { const pc = deg[di % deg.length]; let m = last + 1; while (m % 12 !== pc) m++; notes.push(m); last = m + 2; });
    return notes;
  }
  function choirStep(t, step, c, barDur) {
    const s16 = step % 16, every = c.feel.density > .6 ? 1 : 2;
    const ant = c.last && c.next.enter === 'anticipate';
    if (s16 === 0 && (c.changed || c.barInSection % every === 0))
      choirChord(t, quartal(c.scale.length >= 4 ? c.scale : c.fullScale, c.root, c.feel.register), (ant ? barDur * .75 : barDur * every) + .15, c.feel.brightness);
    if (ant && s16 === 12) choirChord(t, quartal(c.nextScale, c.next.root, c.feel.register), barDur * .25 + .3, c.feel.brightness);
  }
  function drumStep(t, step, c) {
    const d = c.feel.density, s16 = step % 16;
    if (c.changed && s16 === 0) noiseHit(t, 1.4, 'highpass', 5000, .5, .16);
    if (s16 % 4 === 0 && (d > .3 || s16 === 0 || s16 === 8)) kick(t, c.feel.register);
    else if (d > .55 && s16 === 14 && Math.random() < .4) kick(t, c.feel.register);
    if (s16 % (d > .7 ? 1 : 2) === 0) noiseHit(t, s16 % 4 === 2 && c.feel.brightness > .6 ? .16 : .04, 'highpass', 7000 + c.feel.brightness * 3000, .8, s16 % 4 === 2 ? .16 : .08);
    if ((step % 5 === 0) !== (step % 7 === 0) && d > .2) noiseHit(t, .05, 'bandpass', 1700, 6, .22);   // clock 5 XOR clock 7
    if (c.last && s16 >= 12) noiseHit(t, .12, 'bandpass', 900, 1.5, .12 + .06 * (s16 - 12));         // fill into the next section
  }

  /* ---------------- scheduler on the desk's timeline ---------------- */
  const LOOK_S = .15;
  function tick() {
    if (!F.on || !S.playing || !S.segs.length) { if (fs) { fs = null; renderNow(null); } return; }
    if (!fs) startForm();
    const now = wallNow();
    // bar messages go out one beat before each downbeat, so apps can schedule against them
    while (beatToWall(fs.nextBar * BEATS_PER_BAR - 1) <= now + 40) {
      const c = advanceBar(); sendBar(c);
      const at = beatToWall(c.bar * BEATS_PER_BAR);
      setTimeout(() => { if (fs && fs.bars.get(c.bar) === c) renderNow(c); }, Math.max(0, at - wallNow()));
      fs.nextBar++;
    }
    if (!AC || !(F.guide.melody || F.guide.choir || F.guide.drums) || !ensureOut()) { fs.nextStep = null; return; }
    if (fs.nextStep == null) fs.nextStep = Math.max(0, Math.ceil(wallToBeat(now) * 4));
    while (true) {
      const step = fs.nextStep, t = MixCore.ctxAtWall(AC, beatToWall(step / 4));
      if (t > AC.currentTime + LOOK_S) break;
      fs.nextStep++;
      const c = fs.bars.get(Math.floor(step / 16));
      if (!c || t < AC.currentTime - .01) continue;
      const stepDur = MixCore.ctxAtWall(AC, beatToWall((step + 1) / 4)) - t;
      if (F.guide.melody) melodyStep(t, step, c, stepDur);
      if (F.guide.choir) choirStep(t, step, c, stepDur * 16);
      if (F.guide.drums) drumStep(t, step, c);
    }
  }
  setInterval(tick, 25);

  /* ---------------- UI ---------------- */
  const panel = $('#formPanel');
  const secVar = L => `var(--sec-${(L || 'a').toLowerCase()})`;
  const keyName = (root, mode) => NOTES[root] + ' ' + MODES[mode].name.replace(/ \(.*\)/, '');
  function lengthText(s) {
    if (s.length.type === 'fixed') return s.length.bars + ' bars';
    const r = s.length.rule;
    return `Vamp ${s.length.min}–${s.length.max} bars, until ` + (r.kind === 'gate' ? `clock ${r.a} ${r.op} ${r.b}` : `${r.pct}% chance a bar`);
  }
  panel.innerHTML = `
    <div class="phead">
      <h2 id="formTitle">Form</h2>
      <p class="note">A chart of sections with keys, modes and lengths. The apps keep their own patterns and logic; the chart tells them where they are.</p>
      <button class="btn small" id="fmOn" aria-pressed="true" title="Send the chart to the apps while the desk plays">Conduct</button>
    </div>
    <div class="fm-now" id="fmNow">
      <div class="fm-big" id="fmLetter">A</div>
      <div class="fm-info">
        <div class="fm-key" id="fmKey"></div>
        <div class="note" id="fmWhere"></div>
        <div class="fm-next" id="fmNext"></div>
      </div>
      <div class="fm-meter" id="fmMeter"></div>
      <div class="fm-actions">
        <button class="btn primary" id="fmCue" data-ctl="f:cue">Cue next section</button>
        <span class="mb" data-mb="f:cue"></span>
        <span class="fm-flag" id="fmFlag"></span>
        <div class="fm-scale" id="fmScale" aria-label="Scale in this bar"></div>
      </div>
    </div>
    <div class="fm-order-row">
      <div class="fm-order" id="fmOrder"></div>
      <label class="lbl" for="fmPreset">Chart</label>
      <select class="sel" id="fmPreset"></select>
    </div>
    <details class="fm-edit" id="fmEdit">
      <summary>Edit sections and guide voices</summary>
      <div class="fm-tabs" id="fmTabs" role="tablist" aria-label="Section"></div>
      <div class="fm-grid">
        <label class="fm-field"><span class="lbl">Root</span><select class="sel" id="fmRoot"></select></label>
        <label class="fm-field"><span class="lbl">Mode</span><select class="sel" id="fmMode"></select></label>
        <div class="fm-field"><span class="lbl">Enter by</span><div class="fm-seg" id="fmEnter"><button data-v="hard">Hard</button><button data-v="pivot">Pivot</button><button data-v="anticipate">Anticipate</button></div></div>
      </div>
      <p class="note" id="fmEnterHint"></p>
      <div class="fm-grid">
        <div class="fm-field"><span class="lbl">Length</span><div class="fm-seg" id="fmLenType"><button data-v="fixed">Fixed</button><button data-v="vamp">Vamp</button></div></div>
        <label class="fm-field" id="fmwBars"><span class="lbl">Bars</span><input class="txt" id="fmBars" type="number" min="1" max="64"></label>
        <label class="fm-field" id="fmwMin"><span class="lbl">At least</span><input class="txt" id="fmMin" type="number" min="1" max="64"></label>
        <label class="fm-field" id="fmwMax"><span class="lbl">At most</span><input class="txt" id="fmMax" type="number" min="1" max="128"></label>
      </div>
      <div class="fm-grid" id="fmwRule">
        <div class="fm-field"><span class="lbl">Leave when</span><div class="fm-seg" id="fmRuleKind"><button data-v="gate">Clocks</button><button data-v="chance">Chance</button></div></div>
        <label class="fm-field" id="fmwA"><span class="lbl">Bar clock</span><input class="txt" id="fmA" type="number" min="1" max="16"></label>
        <label class="fm-field" id="fmwOp"><span class="lbl">Gate</span><select class="sel" id="fmOp"><option>AND</option><option>OR</option><option>XOR</option></select></label>
        <label class="fm-field" id="fmwB"><span class="lbl">Bar clock</span><input class="txt" id="fmB" type="number" min="1" max="16"></label>
        <label class="fm-field" id="fmwPct"><span class="lbl">Chance per bar <span class="mono" id="fmvPct"></span></span><input id="fmPct" type="range" min="5" max="90"></label>
      </div>
      <p class="note" id="fmLenHint"></p>
      <div class="fm-grid">
        <label class="fm-field"><span class="lbl">Density <span class="mono" id="fmvDensity"></span></span><input id="fmDensity" type="range" min="0" max="100"></label>
        <label class="fm-field"><span class="lbl">Register <span class="mono" id="fmvRegister"></span></span><input id="fmRegister" type="range" min="0" max="100"></label>
        <label class="fm-field"><span class="lbl">Brightness <span class="mono" id="fmvBright"></span></span><input id="fmBright" type="range" min="0" max="100"></label>
      </div>
      <div class="fm-guide">
        <span class="lbl">Guide voices</span>
        <button class="btn small" data-guide="melody">Gate melody</button>
        <button class="btn small" data-guide="choir">Quartal choir</button>
        <button class="btn small" data-guide="drums">Logic drums</button>
        <label class="fm-field fm-level"><span class="lbl">Level</span><input id="fmLevel" type="range" min="0" max="100"></label>
        <p class="note">A stand-in trio that plays the chart into the master bus, so you can hear the form and record it. Apps that follow Form Link don't need it.</p>
      </div>
      <details class="fm-bus"><summary class="lbl">Bus monitor</summary><pre class="mono" id="fmBus">Messages appear here while the desk plays.</pre></details>
    </details>`;

  const q = s => panel.querySelector(s);
  NOTES.forEach((n, i) => q('#fmRoot').append(h('option', { value: i }, n)));
  Object.keys(MODES).forEach(k => q('#fmMode').append(h('option', { value: k }, MODES[k].name)));
  Object.keys(PRESETS).forEach(k => q('#fmPreset').append(h('option', { value: k }, PRESETS[k].name)));
  q('#fmPreset').append(h('option', { value: '' }, 'Your chart'));

  function renderNow(c) {
    const ch = F.chart, L = c ? c.section : ch.order[0], s = ch.sections[L];
    if (!s) return;
    const nL = c ? c.next.section : ch.order[nextIndex(0)], ns = ch.sections[nL];
    const box = q('#fmNow');
    box.style.setProperty('--sec', secVar(L)); box.style.setProperty('--sec-next', secVar(nL));
    box.classList.toggle('idle', !c);
    q('#fmLetter').textContent = L;
    q('#fmKey').textContent = keyName(s.root, s.mode);
    const len = lenOf(s), bis = c ? c.barInSection : 0;
    q('#fmWhere').textContent = !F.on ? 'Not conducting. Press Conduct to send the chart to the apps.'
      : !c ? `Starts on play · ${lengthText(s)}`
      : (len ? `Bar ${bis + 1} of ${len}` : `Bar ${bis + 1} · ${lengthText(s)}`) + (c.last ? ' · last bar' : '');
    q('#fmNext').innerHTML = '';
    q('#fmNext').append('Then ', h('b', {}, nL), ` · ${keyName(ns.root, ns.mode)} · enters ${ns.enter}`);
    const m = q('#fmMeter'); m.innerHTML = '';
    const total = len || Math.max(Math.min(s.length.max, 32), bis + 1);
    for (let i = 0; i < total; i++) m.append(h('i', { class: i < bis ? 'done' : i === bis && c ? 'cur' : (!len && i >= s.length.min ? 'open' : '') }));
    const scale = c ? c.scale : scaleOf(s), mode = MODES[s.mode], sb = q('#fmScale'); sb.innerHTML = '';
    for (let i = 0; i < 12; i++) { const pc = (s.root + i) % 12; sb.append(h('span', { class: scale.includes(pc) ? 'in' + (i === 0 ? ' root' : '') + (mode.color === i ? ' color' : '') : '' }, NOTES[pc])); }
    sb.title = c && c.scale.length < c.fullScale.length ? 'Pivot bar: common tones only' : 'Scale in this bar (underline marks the color tone)';
    panel.querySelectorAll('.fm-cue').forEach((el, i) => el.classList.toggle('cur', !!c && i === c.index));
    if (CTL.has('f:cue')) syncCtl('f:cue');
    q('#fmFlag').textContent = fs && fs.cueArmed ? 'Moving on after this bar' : fs && fs.cue ? 'Moving on after the next bar' : '';
  }
  function renderOrder() {
    const o = q('#fmOrder'); o.innerHTML = '';
    F.chart.order.forEach((L, i) => {
      const s = F.chart.sections[L];
      const b = h('button', { class: 'fm-cue', style: `--sec:${secVar(L)}`, title: 'Remove from the form', 'aria-label': `Section ${L}, position ${i + 1}. Remove` },
        L, h('small', {}, s.length.type === 'fixed' ? String(s.length.bars) : '∞'));
      b.onclick = () => { if (F.chart.order.length < 2) return; F.chart.order.splice(i, 1); edited(); };
      o.append(b);
    });
    LETTERS.forEach(L => o.append(h('button', { class: 'btn tiny fm-add', style: `color:${secVar(L)}`, title: `Add section ${L} to the end`, onclick: () => {
      if (!F.chart.sections[L]) F.chart.sections[L] = sec(7, 'mixolydian', { type: 'fixed', bars: 8 }, { density: .5, register: .5, brightness: .5 });
      F.chart.order.push(L); F.editing = L; edited();
    } }, '+' + L)));
  }
  const setSeg = (id, v) => panel.querySelectorAll(`#${id} button`).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  function renderEditor() {
    if (!F.chart.sections[F.editing]) F.editing = F.chart.order[0];
    const tabs = q('#fmTabs'); tabs.innerHTML = '';
    LETTERS.filter(L => F.chart.sections[L]).forEach(L => tabs.append(h('button', { role: 'tab', 'aria-selected': String(L === F.editing), style: `--sec:${secVar(L)}`, onclick: () => { F.editing = L; renderEditor(); } }, L)));
    const s = F.chart.sections[F.editing];
    q('#fmEdit').style.setProperty('--sec', secVar(F.editing));
    q('#fmRoot').value = s.root; q('#fmMode').value = s.mode; setSeg('fmEnter', s.enter);
    q('#fmEnterHint').textContent = ENTER_HINT[s.enter];
    const vamp = s.length.type === 'vamp'; setSeg('fmLenType', s.length.type);
    q('#fmwBars').hidden = vamp; q('#fmwMin').hidden = !vamp; q('#fmwMax').hidden = !vamp; q('#fmwRule').hidden = !vamp;
    if (!vamp) { q('#fmBars').value = s.length.bars; q('#fmLenHint').textContent = ''; }
    else {
      const r = s.length.rule, g = r.kind === 'gate';
      q('#fmMin').value = s.length.min; q('#fmMax').value = s.length.max; setSeg('fmRuleKind', r.kind);
      q('#fmwA').hidden = q('#fmwB').hidden = q('#fmwOp').hidden = !g; q('#fmwPct').hidden = g;
      if (g) { q('#fmA').value = r.a; q('#fmB').value = r.b; q('#fmOp').value = r.op; } else { q('#fmPct').value = r.pct; q('#fmvPct').textContent = r.pct + '%'; }
      q('#fmLenHint').textContent = lengthText(s) + (g ? '. The bars played so far are counted, and each count acts as a clock into the gate.' : '.');
    }
    [['fmDensity', 'fmvDensity', 'density'], ['fmRegister', 'fmvRegister', 'register'], ['fmBright', 'fmvBright', 'brightness']].forEach(([i, v, k]) => { q('#' + i).value = Math.round(s.feel[k] * 100); q('#' + v).textContent = s.feel[k].toFixed(2); });
    panel.querySelectorAll('[data-guide]').forEach(b => b.setAttribute('aria-pressed', String(F.guide[b.dataset.guide])));
    q('#fmLevel').value = Math.round(F.guide.level * 100);
    q('#fmOn').setAttribute('aria-pressed', String(F.on));
    q('#fmPreset').value = Object.keys(PRESETS).find(k => PRESETS[k].name === F.chart.name) || '';
  }
  function renderAll() { renderOrder(); renderEditor(); renderNow(fs ? fs.ctx : null); }
  function edited(keepName) { if (!keepName) F.chart.name = 'Your chart'; renderAll(); persist(); sendChart(); }
  const busLog = [];
  function logBus(msg) {
    busLog.unshift(JSON.stringify(msg, (k, v) => typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v));
    busLog.length = Math.min(busLog.length, 6);
    const pre = q('#fmBus'); if (pre && q('.fm-bus').open) pre.textContent = busLog.join('\n\n');
  }

  /* wiring */
  const cur = () => F.chart.sections[F.editing];
  q('#fmPreset').onchange = () => { const k = q('#fmPreset').value; if (!PRESETS[k]) return; F.chart = freshChart(k); F.editing = F.chart.order[0]; edited(true); };
  q('#fmRoot').onchange = () => { cur().root = +q('#fmRoot').value; edited(); };
  q('#fmMode').onchange = () => { cur().mode = q('#fmMode').value; edited(); };
  const segWire = (id, fn) => panel.querySelectorAll(`#${id} button`).forEach(b => b.onclick = () => { fn(b.dataset.v); edited(); });
  segWire('fmEnter', v => { cur().enter = v; });
  segWire('fmLenType', v => { const s = cur(); if (v === s.length.type) return;
    s.length = v === 'fixed' ? { type: 'fixed', bars: s.length.min || 8 } : { type: 'vamp', min: s.length.bars || 8, max: Math.max(16, (s.length.bars || 8) * 3), rule: { kind: 'gate', a: 3, b: 5, op: 'AND' } }; });
  segWire('fmRuleKind', v => { cur().length.rule = v === 'gate' ? { kind: 'gate', a: 3, b: 5, op: 'AND' } : { kind: 'chance', pct: 25 }; });
  const num = (id, lo, hi, fn) => { q('#' + id).onchange = () => { fn(clamp(Math.round(+q('#' + id).value || lo), lo, hi)); edited(); }; };
  num('fmBars', 1, 64, v => { cur().length.bars = v; });
  num('fmMin', 1, 64, v => { const L = cur().length; L.min = v; if (L.max < v) L.max = v; });
  num('fmMax', 1, 128, v => { const L = cur().length; L.max = v; if (L.min > v) L.min = v; });
  num('fmA', 1, 16, v => { cur().length.rule.a = v; });
  num('fmB', 1, 16, v => { cur().length.rule.b = v; });
  q('#fmOp').onchange = () => { cur().length.rule.op = q('#fmOp').value; edited(); };
  q('#fmPct').oninput = () => { q('#fmvPct').textContent = q('#fmPct').value + '%'; };
  q('#fmPct').onchange = () => { cur().length.rule.pct = +q('#fmPct').value; edited(); };
  [['fmDensity', 'fmvDensity', 'density'], ['fmRegister', 'fmvRegister', 'register'], ['fmBright', 'fmvBright', 'brightness']].forEach(([i, v, k]) => {
    q('#' + i).oninput = () => { const x = +q('#' + i).value / 100; cur().feel[k] = x; q('#' + v).textContent = x.toFixed(2); };
    q('#' + i).onchange = () => edited();
  });
  panel.querySelectorAll('[data-guide]').forEach(b => b.onclick = () => { ensureAudio(); const k = b.dataset.guide; F.guide[k] = !F.guide[k]; b.setAttribute('aria-pressed', String(F.guide[k])); persist(); });
  q('#fmLevel').oninput = () => { F.guide.level = +q('#fmLevel').value / 100; if (out) out.gain.setTargetAtTime(F.guide.level, AC.currentTime, .03); };
  q('#fmLevel').onchange = persist;
  q('#fmOn').onclick = () => { F.on = !F.on; q('#fmOn').setAttribute('aria-pressed', String(F.on)); if (!F.on) fs = null; else sendChart(); renderNow(null); persist(); };
  q('.fm-bus').addEventListener('toggle', () => { if (q('.fm-bus').open) q('#fmBus').textContent = busLog.length ? busLog.join('\n\n') : 'Messages appear here while the desk plays.'; });

  // The cue is a desk control, so it can be MIDI-mapped (channel 16, CC 29 by default).
  function cue() { if (!fs) return; fs.cue = true; renderNow(fs.ctx); }
  defCtl('f:cue', { label: 'Cue next section', toggle: true, noSave: true, get: () => !!(fs && (fs.cue || fs.cueArmed)), set: v => { if (v) cue(); } });
  CTL.get('f:cue').group = () => 'Form';
  MASTER_DEFAULT_MAP['f:cue'] = 29;
  if (!S.midiMap['f:cue'] && !Object.values(S.midiMap).some(m => m.ch === 16 && m.type === 'cc' && m.num === 29)) S.midiMap['f:cue'] = { ch: 16, type: 'cc', num: 29 };
  q('#fmCue').onclick = () => { if (!S.learn) setCtl('f:cue', true); };
  bindEl('f:cue', q('#fmCue'), () => q('#fmCue').setAttribute('aria-pressed', String(!!(fs && (fs.cue || fs.cueArmed)))));

  renderAll();
  refreshBadges(); refreshMap();
  window.FormDesk = { save, load: d => load(d), get state() { return fs && fs.ctx; }, chart: () => F.chart };
})();
