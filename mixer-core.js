/* ===== MIXER CORE — audio engine for the Mixing Desk (and any app in the ecosystem) =====
   Everything here is plain Web Audio with no UI, so other apps (Tape Loop Deck's console, for one)
   can build on the same strips, buses, meters and recorder.

     MixCore.wallNow()                      shared wall clock in ms (same in every frame and tab)
     MixCore.ctxAtWall(ctx, wall)           AudioContext time at which sound scheduled now is heard at `wall`
     MixCore.wallAtCtx(ctx, t)              and back
     MixCore.ready(ctx)                     Promise: loads the worklets this file needs into ctx
     MixCore.guestPlayer(ctx, onLatency)    plays PCM blocks from a framed guest, on time (see below)
     MixCore.strip(ctx, { out, reverb })    one channel strip: gain, low cut, 3-band EQ with swept mid,
                                            DJ filter, drive, tempo-synced echo, reverb send, fader, pan, mute
     MixCore.reverb(ctx)                    shared reverb return
     MixCore.master(ctx)                    master bus: limiter, fader, safety clip, analysers
     MixCore.meter(ctx, node)               stereo peak / RMS reader for a node
     MixCore.tap(ctx, node)                 sample-exact recorder on a node (frames counted in ctx time)
     MixCore.wavBlob(L, R, sr, bits)        16- or 24-bit stereo WAV
     MixCore.mp3Blob(L, R, sr, kbps)        MP3, if lamejs is on the page

   Guest audio follows the Discobot guest protocol v1 (docs/GUEST_PROTOCOL.md in iw978599/discobot):
   each block is stamped with the wall time its first sample would have been heard in the frame.
   The guest plays `latencyMs` early; the host places the block `latencyMs` after its stamp, so the
   two cancel and the guest lands on the beat. Blocks that follow on are placed end to end so tiny
   clock-reading differences can't click. */
(function (global) {
  'use strict';
  if (global.MixCore) return;

  const wallNow = () => performance.timeOrigin + performance.now();
  function ctxAtWall(ctx, wall) {
    const s = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (s && s.performanceTime && s.contextTime) return s.contextTime + (wall - (performance.timeOrigin + s.performanceTime)) / 1000;
    return ctx.currentTime + (wall - wallNow()) / 1000;
  }
  function wallAtCtx(ctx, t) {
    const s = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (s && s.performanceTime && s.contextTime) return performance.timeOrigin + s.performanceTime + (t - s.contextTime) * 1000;
    return wallNow() + (t - ctx.currentTime) * 1000;
  }
  const db2g = d => Math.pow(10, d / 20);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------- worklets ---------- */
  const WORKLET_SRC = `
class MxGuestPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * 4);
    this.l = new Float32Array(this.size); this.r = new Float32Array(this.size); this.filledTo = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'clear') { this.filledTo = 0; this.l.fill(0); this.r.fill(0); return; }
      const start = Math.round(data.frame), n = data.left.length;
      if (start + n <= currentFrame || start > currentFrame + this.size - n) return;
      for (let i = 0; i < n; i++) {
        const f = start + i; if (f < currentFrame) continue;
        const s = f % this.size; this.l[s] = data.left[i]; this.r[s] = data.right[i];
      }
      this.filledTo = Math.max(this.filledTo, start + n);
    };
  }
  process(_in, outputs) {
    const o = outputs[0]; if (!o || !o.length) return true;
    const L = o[0], R = o[1] || o[0];
    for (let i = 0; i < L.length; i++) {
      const f = currentFrame + i, s = f % this.size;
      if (f < this.filledTo) { L[i] = this.l[s]; R[i] = this.r[s]; } else { L[i] = 0; R[i] = 0; }
      this.l[s] = 0; this.r[s] = 0;
    }
    return true;
  }
}
registerProcessor('mx-guest-player', MxGuestPlayer);
class MxTap extends AudioWorkletProcessor {
  constructor() { super(); this.B = 2048; this.l = new Float32Array(this.B); this.r = new Float32Array(this.B); this.n = 0; this.start = 0; }
  process(inputs) {
    const inp = inputs[0], a = inp && inp[0], b = inp && (inp[1] || inp[0]);
    if (this.n === 0) this.start = currentFrame;
    for (let i = 0; i < 128; i++) { this.l[this.n + i] = a ? a[i] : 0; this.r[this.n + i] = b ? b[i] : 0; }
    this.n += 128;
    if (this.n >= this.B) {
      this.port.postMessage({ frame: this.start, l: this.l, r: this.r }, [this.l.buffer, this.r.buffer]);
      this.l = new Float32Array(this.B); this.r = new Float32Array(this.B); this.n = 0;
    }
    return true;
  }
}
registerProcessor('mx-tap', MxTap);`;
  const loaded = new WeakMap();
  function ready(ctx) {
    let p = loaded.get(ctx);
    if (!p) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      p = ctx.audioWorklet.addModule(url);
      loaded.set(ctx, p);
    }
    return p;
  }

  function resample(input, from, to) {
    if (from === to || !input.length) return input;
    const len = Math.max(1, Math.round(input.length * to / from)), out = new Float32Array(len);
    const step = (input.length - 1) / Math.max(1, len - 1);
    for (let i = 0; i < len; i++) { const p = i * step, lo = Math.floor(p), hi = Math.min(input.length - 1, lo + 1); out[i] = input[lo] + (input[hi] - input[lo]) * (p - lo); }
    return out;
  }

  /* ---------- guest player ---------- */
  const GUEST_LATENCY_MS = 120, MAX_LATENCY_MS = 480, LATENCY_STEP_MS = 60, HEADROOM_S = 0.01, LATE_RUN = 4, MAX_BLOCK = 16384;
  function guestPlayer(ctx, onLatency, initialLatency) {
    const node = new AudioWorkletNode(ctx, 'mx-guest-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    let expected = null, lateRun = 0, worstLate = 0;
    const stats = { blocks: 0, late: 0, latencyMs: initialLatency || GUEST_LATENCY_MS, lastWall: 0 };
    return {
      node, stats,
      push(wall, sr, left, right) {
        if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length) return false;
        if (!left.length || left.length > MAX_BLOCK || typeof wall !== 'number' || !isFinite(wall) || !(sr >= 8000 && sr <= 192000)) return false;
        stats.blocks++; stats.lastWall = wallNow();
        const rate = ctx.sampleRate, l = resample(left, sr, rate), r = resample(right, sr, rate);
        const soonest = Math.round((ctx.currentTime + HEADROOM_S) * rate);
        const target = ctxAtWall(ctx, wall + stats.latencyMs) * rate;
        let frame = expected !== null && Math.abs(target - expected) < rate * 0.03 ? expected : Math.round(target);
        if (frame < soonest) {
          stats.late++; lateRun++; worstLate = Math.max(worstLate, (soonest - frame) / rate);
          frame = Math.max(soonest, expected || 0);
          if (lateRun >= LATE_RUN) {
            const next = Math.min(MAX_LATENCY_MS, stats.latencyMs + Math.ceil((worstLate * 1000 + 20) / LATENCY_STEP_MS) * LATENCY_STEP_MS);
            lateRun = 0; worstLate = 0;
            if (next !== stats.latencyMs) { stats.latencyMs = next; expected = null; onLatency && onLatency(next); }
          }
        } else { lateRun = 0; worstLate = 0; }
        expected = frame + l.length;
        try { node.port.postMessage({ type: 'block', frame, left: l, right: r }, l.buffer === r.buffer ? [l.buffer] : [l.buffer, r.buffer]); }
        catch (e) { node.port.postMessage({ type: 'block', frame, left: l, right: r }); }
        return true;
      },
      clear() { expected = null; lateRun = 0; worstLate = 0; node.port.postMessage({ type: 'clear' }); },
      dispose() { try { node.disconnect(); } catch (e) {} }
    };
  }

  /* ---------- curves ---------- */
  const driveCache = new Map();
  function driveCurve(amount) {
    const key = Math.round(amount * 100);
    if (driveCache.has(key)) return driveCache.get(key);
    const k = 1 + key / 100 * 14, N = 2049, c = new Float32Array(N), norm = Math.tanh(k);
    for (let i = 0; i < N; i++) { const x = i / (N - 1) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
    driveCache.set(key, c); return c;
  }
  /* master safety clip: linear up to -2 dBFS, soft knee to a hard ceiling at 0 dBFS (same as Tape Loop Deck) */
  const SAFETY_CURVE = (() => { const N = 4097, c = new Float32Array(N), K = 0.8, R = 0.2; for (let i = 0; i < N; i++) { const x = (i / (N - 1) * 2 - 1) * 2, a = Math.abs(x); c[i] = Math.sign(x) * (a <= K ? a : K + R * Math.tanh((a - K) / R)); } return c; })();

  function impulse(ctx, secs) {
    const sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * secs)), b = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let seed = ch ? 7919 : 104729;
      const pre = Math.floor(sr * 0.012);
      for (let i = 0; i < len; i++) {
        seed = (seed * 16807) % 2147483647;
        const r = seed / 2147483647 * 2 - 1;
        d[i] = i < pre ? 0 : r * Math.pow(1 - (i - pre) / (len - pre), 3.4) * (i < pre + sr * 0.06 ? 1.25 : 1);
      }
    }
    return b;
  }

  const smooth = (param, v, ctx, tc = 0.015) => { try { param.setTargetAtTime(v, ctx.currentTime, tc); } catch (e) { param.value = v; } };

  /* ---------- channel strip ---------- */
  // Echo time choices, in beats.
  const ECHO_DIVS = [['1/16', 0.25], ['1/8T', 1 / 3], ['1/8', 0.5], ['1/8.', 0.75], ['1/4T', 2 / 3], ['1/4', 1], ['1/4.', 1.5], ['1/2', 2], ['1 bar', 4]];
  function strip(ctx, opts) {
    const n = {};
    n.input = ctx.createGain();
    n.trim = ctx.createGain();
    n.lowcut = ctx.createBiquadFilter(); n.lowcut.type = 'highpass'; n.lowcut.Q.value = 0.707;
    n.lo = ctx.createBiquadFilter(); n.lo.type = 'lowshelf'; n.lo.frequency.value = 120;
    n.mid = ctx.createBiquadFilter(); n.mid.type = 'peaking'; n.mid.Q.value = 0.9;
    n.hi = ctx.createBiquadFilter(); n.hi.type = 'highshelf'; n.hi.frequency.value = 8000;
    n.djLP = ctx.createBiquadFilter(); n.djLP.type = 'lowpass'; n.djLP.Q.value = 1.1; n.djLP.frequency.value = 22000;
    n.djHP = ctx.createBiquadFilter(); n.djHP.type = 'highpass'; n.djHP.Q.value = 1.1; n.djHP.frequency.value = 10;
    n.shaper = ctx.createWaveShaper(); n.shaper.oversample = '2x';
    n.driveOut = ctx.createGain();
    n.fader = ctx.createGain();
    n.mute = ctx.createGain();
    n.pan = ctx.createStereoPanner();
    n.out = ctx.createGain();
    // echo: post-fader, post-mute send into its own feedback loop, back in ahead of the panner
    n.echoSend = ctx.createGain(); n.echoSend.gain.value = 0;
    n.delay = ctx.createDelay(4.1);
    n.fbTone = ctx.createBiquadFilter(); n.fbTone.type = 'lowpass'; n.fbTone.frequency.value = 4200;
    n.fbHP = ctx.createBiquadFilter(); n.fbHP.type = 'highpass'; n.fbHP.frequency.value = 90;
    n.fb = ctx.createGain(); n.fb.gain.value = 0.35;
    n.echoRet = ctx.createGain(); n.echoRet.gain.value = 0.8;
    n.verbSend = ctx.createGain(); n.verbSend.gain.value = 0;

    n.input.connect(n.trim); n.trim.connect(n.lowcut); n.lowcut.connect(n.lo); n.lo.connect(n.mid); n.mid.connect(n.hi);
    n.hi.connect(n.djLP); n.djLP.connect(n.djHP); n.djHP.connect(n.shaper); n.shaper.connect(n.driveOut);
    n.driveOut.connect(n.fader); n.fader.connect(n.mute); n.mute.connect(n.pan); n.pan.connect(n.out);
    n.mute.connect(n.echoSend); n.echoSend.connect(n.delay); n.delay.connect(n.fbTone); n.fbTone.connect(n.fbHP);
    n.fbHP.connect(n.fb); n.fb.connect(n.delay); n.fbHP.connect(n.echoRet); n.echoRet.connect(n.pan);
    n.mute.connect(n.verbSend);
    if (opts && opts.reverb) n.verbSend.connect(opts.reverb);
    if (opts && opts.out) n.out.connect(opts.out);
    n._drive = -1;

    // p: { trim, lowcut, lo, mid, midF, hi, filter, drive, echo, echoDiv, echoFb, verb, pan, vol, muted }
    n.apply = (p, bpm) => {
      smooth(n.trim.gain, db2g(p.trim), ctx);
      smooth(n.lowcut.frequency, p.lowcut <= 20.5 ? 10 : p.lowcut, ctx);
      smooth(n.lo.gain, p.lo, ctx); smooth(n.mid.gain, p.mid, ctx); smooth(n.hi.gain, p.hi, ctx);
      smooth(n.mid.frequency, p.midF, ctx);
      const f = p.filter;
      smooth(n.djLP.frequency, f < -0.01 ? 22000 * Math.pow(180 / 22000, -f) : 22000, ctx, 0.02);
      smooth(n.djHP.frequency, f > 0.01 ? 20 * Math.pow(7000 / 20, f) : 10, ctx, 0.02);
      if (Math.round(p.drive * 100) !== n._drive) {
        n._drive = Math.round(p.drive * 100);
        n.shaper.curve = n._drive > 0 ? driveCurve(p.drive) : null;
        smooth(n.driveOut.gain, n._drive > 0 ? 1 / (1 + p.drive * 1.4) : 1, ctx);
      }
      smooth(n.echoSend.gain, p.echo, ctx);
      smooth(n.fb.gain, p.echoFb, ctx);
      n.setTempo(bpm, p.echoDiv);
      smooth(n.verbSend.gain, p.verb, ctx);
      smooth(n.pan.pan, p.pan, ctx);
      smooth(n.fader.gain, p.vol <= -60 ? 0 : db2g(p.vol), ctx, 0.01);
      smooth(n.mute.gain, p.muted ? 0 : 1, ctx, 0.008);
    };
    n.setTempo = (bpm, div) => {
      const beats = (ECHO_DIVS[clamp(Math.round(div), 0, ECHO_DIVS.length - 1)] || ECHO_DIVS[5])[1];
      const secs = clamp(beats * 60 / (bpm || 120), 0.02, 4);
      smooth(n.delay.delayTime, secs, ctx, 0.05);
    };
    n.dispose = () => { Object.values(n).forEach(x => { if (x && x.disconnect) { try { x.disconnect(); } catch (e) {} } }); };
    return n;
  }

  /* ---------- reverb return ---------- */
  function reverb(ctx, out) {
    const r = {};
    r.input = ctx.createGain();
    r.conv = ctx.createConvolver();
    r.tone = ctx.createBiquadFilter(); r.tone.type = 'lowpass'; r.tone.frequency.value = 6000;
    r.lowcut = ctx.createBiquadFilter(); r.lowcut.type = 'highpass'; r.lowcut.frequency.value = 160;
    r.fader = ctx.createGain(); r.mute = ctx.createGain(); r.out = ctx.createGain();
    r.input.connect(r.conv); r.conv.connect(r.lowcut); r.lowcut.connect(r.tone); r.tone.connect(r.fader); r.fader.connect(r.mute); r.mute.connect(r.out);
    if (out) r.out.connect(out);
    r._size = 0;
    r.apply = p => {
      if (Math.abs(p.size - r._size) > 0.01) { r._size = p.size; r.conv.buffer = impulse(ctx, p.size); }
      smooth(r.tone.frequency, p.tone, ctx);
      smooth(r.fader.gain, p.vol <= -60 ? 0 : db2g(p.vol), ctx);
      smooth(r.mute.gain, p.muted ? 0 : 1, ctx, 0.008);
    };
    return r;
  }

  /* ---------- master ---------- */
  function master(ctx) {
    const m = {};
    m.bus = ctx.createGain();
    m.comp = ctx.createDynamicsCompressor();
    // a limiter just under full scale; Chrome adds its own makeup gain, which stays small this close to 0 dB
    m.comp.threshold.value = -1.5; m.comp.knee.value = 0; m.comp.ratio.value = 20; m.comp.attack.value = 0.002; m.comp.release.value = 0.12;
    m.dry = ctx.createGain(); m.wet = ctx.createGain(); m.wet.gain.value = 0;
    m.fader = ctx.createGain();
    m.pre = ctx.createGain(); m.pre.gain.value = 0.5;
    m.safety = ctx.createWaveShaper(); m.safety.curve = SAFETY_CURVE; m.safety.oversample = 'none';
    m.post = ctx.createGain(); m.post.gain.value = 1;   // the final mix: what is heard and recorded
    m.speakers = ctx.createGain();
    m.bus.connect(m.dry); m.bus.connect(m.comp); m.comp.connect(m.wet);
    m.dry.connect(m.fader); m.wet.connect(m.fader);
    // the safety curve's input range is ±2, so halve going in; its output is already ±1
    m.fader.connect(m.pre); m.pre.connect(m.safety); m.safety.connect(m.post);
    m.post.connect(m.speakers); m.speakers.connect(ctx.destination);
    m.apply = p => {
      smooth(m.fader.gain, p.vol <= -60 ? 0 : db2g(p.vol), ctx, 0.01);
      smooth(m.dry.gain, p.limit ? 0 : 1, ctx); smooth(m.wet.gain, p.limit ? 1 : 0, ctx);
      smooth(m.speakers.gain, p.monitor === false ? 0 : 1, ctx);
    };
    m.reduction = () => (m.comp.reduction && typeof m.comp.reduction === 'object' ? m.comp.reduction.value : m.comp.reduction) || 0;
    return m;
  }

  /* ---------- meter ---------- */
  function meter(ctx, node) {
    const sp = ctx.createChannelSplitter(2), a = ctx.createAnalyser(), b = ctx.createAnalyser();
    a.fftSize = b.fftSize = 1024; a.smoothingTimeConstant = b.smoothingTimeConstant = 0;
    node.connect(sp); sp.connect(a, 0); sp.connect(b, 1);
    const buf = new Float32Array(1024);
    const one = an => {
      an.getFloatTimeDomainData(buf);
      let s = 0, pk = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; s += v * v; const av = v < 0 ? -v : v; if (av > pk) pk = av; }
      return { rms: Math.sqrt(s / buf.length), peak: pk };
    };
    return {
      read() { const L = one(a), R = one(b); return { rmsL: L.rms, rmsR: R.rms, peakL: L.peak, peakR: R.peak }; },
      dispose() { try { node.disconnect(sp); } catch (e) {} try { sp.disconnect(); } catch (e) {} }
    };
  }

  /* ---------- recorder tap ----------
     Records a node into blocks stamped with the context frame of their first sample, so a take can
     be cut on any frame: on a bar line, or wherever Record was pressed. */
  function tap(ctx, node) {
    let wn = null, blocks = [], keep = null;
    const t = {
      start() {
        if (wn) return Promise.resolve();
        return ready(ctx).then(() => {
          if (wn) return;
          wn = new AudioWorkletNode(ctx, 'mx-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
          const sink = ctx.createGain(); sink.gain.value = 0; wn.connect(sink); sink.connect(ctx.destination); wn._sink = sink;
          wn.port.onmessage = e => { const d = e.data; blocks.push({ f: d.frame, l: d.l, r: d.r }); if (keep) { const min = d.frame - keep; while (blocks.length > 1 && blocks[0].f + 2048 < min) blocks.shift(); } };
          node.connect(wn);
        });
      },
      // keep only the last `secs` while waiting for a punch-in
      rolling(secs) { keep = secs ? Math.round(secs * ctx.sampleRate) : null; },
      stop() {
        if (wn) { try { node.disconnect(wn); } catch (e) {} try { wn.port.onmessage = null; wn.disconnect(); wn._sink.disconnect(); } catch (e) {} }
        wn = null; const b = blocks; blocks = []; keep = null; return b;
      },
      running: () => !!wn,
      lastFrame: () => blocks.length ? blocks[blocks.length - 1].f + 2048 : 0,
      peek: () => blocks
    };
    return t;
  }
  // Joins blocks into one stereo take covering frames [f0, f1).
  function cut(blocks, f0, f1) {
    const n = Math.max(0, Math.round(f1 - f0)), L = new Float32Array(n), R = new Float32Array(n);
    for (const b of blocks) {
      const s = Math.max(f0, b.f), e = Math.min(f1, b.f + b.l.length);
      for (let f = s; f < e; f++) { L[f - f0] = b.l[f - b.f]; R[f - f0] = b.r[f - b.f]; }
    }
    return { L, R };
  }

  /* ---------- file writers ---------- */
  function wavBlob(L, R, sr, bits) {
    bits = bits === 24 ? 24 : bits === 32 ? 32 : 16;
    const bps = bits / 8, n = L.length, bytes = n * 2 * bps, ab = new ArrayBuffer(44 + bytes), v = new DataView(ab);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, 2, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2 * bps, true); v.setUint16(32, 2 * bps, true); v.setUint16(34, bits, true);
    ws(36, 'data'); v.setUint32(40, bytes, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (const x0 of [L[i], R[i]]) {
        const x = clamp(x0, -1, 1);
        if (bits === 16) { v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2; }
        else if (bits === 24) { const s = Math.round(x < 0 ? x * 8388608 : x * 8388607); v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3; }
        else { v.setFloat32(o, x, true); o += 4; }
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  }
  function mp3Blob(L, R, sr, kbps) {
    if (!global.lamejs) throw new Error('MP3 encoder not loaded');
    const enc = new global.lamejs.Mp3Encoder(2, sr, kbps || 192), out = [], B = 1152;
    const toI16 = (src, s, e) => { const d = new Int16Array(e - s); for (let i = s; i < e; i++) { const x = clamp(src[i], -1, 1); d[i - s] = x < 0 ? x * 32768 : x * 32767; } return d; };
    for (let i = 0; i < L.length; i += B) { const e = Math.min(L.length, i + B), buf = enc.encodeBuffer(toI16(L, i, e), toI16(R, i, e)); if (buf.length) out.push(new Uint8Array(buf)); }
    const end = enc.flush(); if (end.length) out.push(new Uint8Array(end));
    return new Blob(out, { type: 'audio/mpeg' });
  }
  function peakOf(L, R) { let p = 0; for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > p) p = a; if (b > p) p = b; } return p; }

  global.MixCore = { wallNow, ctxAtWall, wallAtCtx, ready, guestPlayer, strip, reverb, master, meter, tap, cut, wavBlob, mp3Blob, peakOf, resample, ECHO_DIVS, GUEST_LATENCY_MS, db2g };
})(typeof window !== 'undefined' ? window : this);
