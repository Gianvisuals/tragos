// Síntesis musical 100% procedural — sin samples.
// 120 BPM · 16 tiempos · 8.000 s exactos · 48 kHz estéreo · WAV 16-bit con dither TPDF.
// Uso: node music.mjs out.wav
import { writeFileSync } from 'node:fs';

const SR = 48000, DUR = 8.0, N = Math.round(SR * DUR);
const BEAT = 0.5;
const TAU = Math.PI * 2;

// ---------- utilidades ----------
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = rng(1337);
const noise = () => rnd() * 2 - 1;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const S = t => Math.round(t * SR);

class Bus {
  constructor() { this.L = new Float32Array(N); this.R = new Float32Array(N); }
  // añade señal mono con paneo (−1..1) y ganancia
  add(sig, t0, gain = 1, pan = 0) {
    const s0 = S(t0), gl = gain * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = gain * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
    for (let i = 0; i < sig.length; i++) { const j = s0 + i; if (j < 0 || j >= N) continue; this.L[j] += sig[i] * gl; this.R[j] += sig[i] * gr; }
  }
  addStereo(l, r, t0, gain = 1) {
    const s0 = S(t0);
    for (let i = 0; i < l.length; i++) { const j = s0 + i; if (j < 0 || j >= N) continue; this.L[j] += l[i] * gain; this.R[j] += r[i] * gain; }
  }
}

// Filtro de variable de estado TPT (Zavalishin) — corte modulable por muestra
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; }
  run(x, fc, q) {
    const g = Math.tan(Math.PI * clamp(fc, 10, SR * 0.49) / SR), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - this.ic2, v1 = a1 * this.ic1 + a2 * v3, v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return { lp: v2, bp: v1, hp: x - k * v1 - v2 };
  }
}
// polyBLEP para sierras sin aliasing
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// ---------- instrumentos ----------
function kick(dur = 0.42, punch = 1) {
  const n = S(dur), o = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 44 + 120 * Math.exp(-t * 26) + 380 * Math.exp(-t * 140);
    ph += TAU * f / SR;
    const env = Math.min(1, t / 0.0015) * Math.exp(-t * 6.2);
    let s = Math.sin(ph) * env;
    s += (t < 0.004 ? noise() * (1 - t / 0.004) * 0.35 * punch : 0); // clic de ataque
    o[i] = Math.tanh(s * 1.9) * 0.9;
  }
  return o;
}
function thump(dur = 0.35) { // golpe de la pelota: kick corto + "pop" tonal
  const n = S(dur), o = new Float32Array(n); let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += TAU * (60 + 90 * Math.exp(-t * 35)) / SR;
    ph2 += TAU * (180 + 900 * Math.exp(-t * 60)) / SR;
    o[i] = Math.tanh(1.6 * Math.sin(ph) * Math.exp(-t * 11)) * 0.8 + Math.sin(ph2) * Math.exp(-t * 40) * 0.35;
  }
  return o;
}
function clap() {
  const n = S(0.35), o = new Float32Array(n), f = new SVF();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let env = 0;
    for (const b of [0, 0.011, 0.023]) if (t >= b) env = Math.max(env, Math.exp(-(t - b) * 190));
    if (t >= 0.03) env = Math.max(env, 0.55 * Math.exp(-(t - 0.03) * 20));
    o[i] = f.run(noise(), 1250, 1.1).bp * env * 2.2;
  }
  return o;
}
function snare(vel = 1) {
  const n = S(0.22), o = new Float32Array(n), f = new SVF(); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; ph += TAU * (185 + 60 * Math.exp(-t * 50)) / SR;
    o[i] = vel * (Math.sin(ph) * Math.exp(-t * 28) * 0.55 + f.run(noise(), 2200, 0.7).hp * Math.exp(-t * 24) * 0.7);
  }
  return o;
}
function hat(open = false) {
  const dur = open ? 0.32 : 0.07, n = S(dur), o = new Float32Array(n), f = new SVF(), f2 = new SVF();
  const fr = [205.3, 304.4, 369.6, 522.7, 540, 800].map(x => x * 1.6); const ph = fr.map(() => rnd());
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let m = 0; for (let k = 0; k < 6; k++) { ph[k] += fr[k] / SR; m += (ph[k] % 1) < 0.5 ? 1 : -1; }
    const x = m / 6 * 0.6 + noise() * 0.5;
    const env = open ? Math.exp(-t * 9) : Math.exp(-t * 70);
    o[i] = f2.run(f.run(x, 7200, 0.9).hp, 11000, 0.7).lp * env;
  }
  return o;
}
// Karplus–Strong: cuerda pulsada sintetizada
function pluck(midi, dur = 0.8, bright = 0.5, decay = 0.996) {
  const f = mtof(midi), n = S(dur), o = new Float32Array(n);
  const p = SR / f, L = Math.floor(p), frac = p - L;
  const buf = new Float32Array(L + 2); const lp = new SVF();
  for (let i = 0; i < buf.length; i++) buf[i] = lp.run(noise(), 1500 + bright * 9000, 0.7).lp;
  let idx = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[idx % buf.length], b = buf[(idx + 1) % buf.length];
    const y = decay * ((1 - bright * 0.5) * 0.5 * (a + b) + bright * 0.5 * a);
    // interpolación fraccional sencilla para afinar
    const out = a + frac * (b - a);
    buf[idx % buf.length] = y; idx++;
    last = out; o[i] = out * Math.min(1, i / 30);
  }
  return o;
}
function sawVoice(freq, n, phase0 = 0) {
  const o = new Float32Array(n); let ph = phase0; const dt = freq / SR;
  for (let i = 0; i < n; i++) { ph += dt; if (ph >= 1) ph -= 1; o[i] = (2 * ph - 1) - blep(ph, dt); }
  return o;
}
// Supersaw: 7 sierras desafinadas por nota, abiertas en estéreo, filtradas
function supersaw(notes, dur, { voices = 7, detune = 0.18, cutoff = t => 3000, q = 0.8, env = t => 1, width = 0.85 } = {}) {
  const n = S(dur), l = new Float32Array(n), r = new Float32Array(n);
  for (const m of notes) {
    for (let v = 0; v < voices; v++) {
      const spread = voices === 1 ? 0 : (v / (voices - 1)) * 2 - 1;
      const f = mtof(m + spread * detune);
      const s = sawVoice(f, n, rnd());
      const pan = spread * width, gl = Math.cos((pan + 1) * Math.PI / 4), gr = Math.sin((pan + 1) * Math.PI / 4);
      const g = (v === (voices >> 1) ? 1 : 0.75) / Math.sqrt(voices * notes.length);
      for (let i = 0; i < n; i++) { l[i] += s[i] * g * gl; r[i] += s[i] * g * gr; }
    }
  }
  const fl = new SVF(), fr = new SVF();
  for (let i = 0; i < n; i++) {
    const t = i / SR, c = cutoff(t), e = env(t);
    l[i] = fl.run(l[i], c, q).lp * e; r[i] = fr.run(r[i], c, q).lp * e;
  }
  return [l, r];
}
function bassNote(midi, dur, { cut = 380, pluckEnv = false } = {}) {
  const n = S(dur), o = new Float32Array(n), f = new SVF(); const fr = mtof(midi);
  const saw = sawVoice(fr, n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; ph += TAU * fr / SR;
    const env = pluckEnv ? Math.min(1, t / 0.003) * Math.exp(-t * 7) : Math.min(1, t / 0.004) * (t > dur - 0.02 ? (dur - t) / 0.02 : 1);
    const c = pluckEnv ? cut + 1400 * Math.exp(-t * 18) : cut;
    o[i] = (Math.sin(ph) * 0.8 + f.run(saw[i], c, 1.1).lp * 0.45) * env;
  }
  return o;
}
function blip(f0, f1, dur, k = 30) { // FM "bloop" digital
  const n = S(dur), o = new Float32Array(n); let ph = 0, pm = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; const f = f1 + (f0 - f1) * Math.exp(-t * k);
    pm += TAU * f * 2 / SR; ph += TAU * f / SR;
    o[i] = Math.sin(ph + Math.sin(pm) * 1.2 * Math.exp(-t * 20)) * Math.exp(-t * 14) * Math.min(1, t / 0.002);
  }
  return o;
}
function sweep(dur, f0, f1, { q = 2, shape = t => t, gainEnv = t => 1 } = {}) { // ruido filtrado con barrido
  const n = S(dur), o = new Float32Array(n), f = new SVF();
  for (let i = 0; i < n; i++) {
    const u = i / n; const fc = f0 * Math.pow(f1 / f0, shape(u));
    o[i] = f.run(noise(), fc, q).bp * gainEnv(u);
  }
  return o;
}

// ---------- buses ----------
const drums = new Bus(), bass = new Bus(), chords = new Bus(), lead = new Bus(), fx = new Bus();
const verbSend = new Bus(), delaySend = new Bus();

// línea de tiempo compartida con el vídeo (ver reel.js → TIMELINE)
const KICKS = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0];
const CLAPS = [2.5, 3.5, 4.5, 5.5, 6.5];
// sidechain: ducking ligado a cada bombo
function duck(t, depth = 0.8) {
  let g = 1;
  for (const k of KICKS) if (t >= k && t < k + 0.5) g = Math.min(g, 1 - depth * (1 - smooth(0, 0.24, t - k)));
  return g;
}
function applyDuck(bus, depth, from = 0, to = DUR) {
  for (let i = S(from); i < Math.min(N, S(to)); i++) { const g = duck(i / SR, depth); bus.L[i] *= g; bus.R[i] *= g; }
}

// ===== COMPÁS 1 (0–2 s): pelota, tipografía =====
// pad Dm9 filtrado que se abre
{
  const [l, r] = supersaw([50, 53, 57, 60, 64], 2.05, { voices: 3, detune: 0.12, cutoff: t => 500 + 900 * t, q: 0.9, env: t => Math.min(1, t / 0.5) * (t > 1.95 ? Math.max(0, (2.05 - t) / 0.1) : 1) });
  chords.addStereo(l, r, 0, 0.55); verbSend.addStereo(l, r, 0, 0.25);
}
// caída: glissando descendente suave + aire
{
  const n = S(0.5), o = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const u = i / n; ph += TAU * (1500 * Math.pow(420 / 1500, u * u)) / SR; o[i] = Math.sin(ph) * 0.12 * Math.sin(Math.PI * Math.min(1, u * 1.1)); }
  fx.add(o, 0.0, 0.5, -0.3); verbSend.add(o, 0, 0.3);
  fx.add(sweep(0.5, 3000, 700, { q: 1.5, gainEnv: u => u * u }), 0.0, 0.18, 0.2);
}
// impactos de la pelota (0.5 y 1.0) + nota musical en cada bote
for (const [t, m, p] of [[0.5, 74, -0.15], [1.0, 81, 0.25]]) {
  fx.add(thump(), t, 0.95, 0);
  const pl = pluck(m, 1.2, 0.7, 0.997); lead.add(pl, t, 0.45, p); delaySend.add(pl, t, 0.35); verbSend.add(pl, t, 0.3);
}
// woosh del barrido circular (1.0)
fx.add(sweep(0.45, 300, 7000, { q: 1.2, shape: u => Math.sqrt(u), gainEnv: u => Math.sin(Math.PI * u) }), 0.98, 0.35, 0.3);
// letras de MOTION: cada letra una nota ascendente
[62, 69, 72, 74, 76, 81].forEach((m, i) => {
  const t = 1.12 + i * 0.05; const pl = pluck(m + 12, 0.7, 0.6, 0.995);
  lead.add(pl, t, 0.22, -0.5 + i * 0.2); delaySend.add(pl, t, 0.25);
});
// arpegio KS en semicorcheas desde 1.5 (entra con las filas de texto)
const ARP1 = [74, 69, 77, 72, 76, 81, 77, 72];
for (let k = 0; k < 4; k++) { const t = 1.5 + k * 0.125; const pl = pluck(ARP1[k], 0.5, 0.45); lead.add(pl, t, 0.14 + k * 0.03, k % 2 ? 0.4 : -0.4); delaySend.add(pl, t, 0.2); }
// barrido de las lamas (1.9)
{
  const sw = sweep(0.3, 500, 9000, { q: 1.4, shape: u => u, gainEnv: u => Math.sin(Math.PI * u) });
  const l = new Float32Array(sw.length), r = new Float32Array(sw.length);
  for (let i = 0; i < sw.length; i++) { const u = i / sw.length; l[i] = sw[i] * (1 - u); r[i] = sw[i] * u; }
  fx.addStereo(l, r, 1.86, 0.5);
}

// ===== COMPÁS 2 (2–4 s): rejilla + anticipación =====
for (const k of KICKS) if (k < 4) drums.add(kick(), k, 1.0);
for (const c of CLAPS) if (c < 4) { const s = clap(); drums.add(s, c, 0.5, 0.05); verbSend.add(s, c, 0.35); }
for (let k = 0; k < 8; k++) drums.add(hat(), 2.0 + k * 0.125, k % 2 ? 0.16 : 0.09, 0.25);
// bajo a contratiempo
for (const t of [2.25, 2.75, 3.25]) bass.add(bassNote(46 - 12, 0.22, { pluckEnv: true }), t, 0.7);
// pad Bbmaj9 + filtro que se abre durante el build
{
  const [l, r] = supersaw([46, 50, 53, 57, 60], 1.875, { voices: 5, detune: 0.16, cutoff: t => 600 * Math.pow(12, t / 1.875), q: 1.4, env: t => Math.min(1, t / 0.02) * (t > 1.84 ? (1.875 - t) / 0.035 : 1) });
  chords.addStereo(l, r, 2.0, 0.5); verbSend.addStereo(l, r, 2.0, 0.15);
}
// arpegio en la rejilla
const ARP2 = [70, 77, 74, 81, 84, 81, 77, 74];
for (let k = 0; k < 14; k++) { const t = 2.0 + k * 0.125; const pl = pluck(ARP2[k % 8] + (k >= 8 ? 12 : 0), 0.45, 0.4 + k * 0.03); lead.add(pl, t, 0.13, k % 2 ? 0.45 : -0.45); delaySend.add(pl, t, 0.18); }
// "bloops" de cada ola de morphing (2.0, 2.25, 2.5, 2.75)
[[2.0, 1800, 300], [2.25, 300, 1200], [2.5, 2400, 500], [2.75, 600, 2600]].forEach(([t, a, b], i) => { const s = blip(a, b, 0.25, 25); fx.add(s, t, 0.22, i % 2 ? 0.5 : -0.5); verbSend.add(s, t, 0.2); });
// redoble acelerando 3.0 → 3.875
{
  const hits = []; for (let t = 3.0; t < 3.5 - 1e-6; t += 0.125) hits.push(t); for (let t = 3.5; t < 3.75 - 1e-6; t += 0.0625) hits.push(t); for (let t = 3.75; t < 3.875 - 1e-6; t += 0.03125) hits.push(t);
  hits.forEach((t, i) => { const s = snare(0.35 + 0.65 * i / hits.length); drums.add(s, t, 0.42, (i % 2 ? 0.15 : -0.15)); verbSend.add(s, t, 0.2); });
}
// riser: ruido + sierra que sube dos octavas, cortado en seco en 3.875 (silencio de tensión)
{
  const d = 0.875; fx.add(sweep(d, 400, 10000, { q: 2.2, shape: u => u * u, gainEnv: u => u * u * (u > 0.97 ? (1 - u) / 0.03 : 1) }), 3.0, 0.45, 0);
  const n = S(d), l = new Float32Array(n), r = new Float32Array(n), f = new SVF(); let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) { const u = i / n, fr = mtof(50 + 24 * u * u); p1 += fr / SR; p2 += fr * 1.006 / SR; const g = u * u * 0.18 * (u > 0.97 ? (1 - u) / 0.03 : 1); l[i] = f.run((p1 % 1) * 2 - 1, 800 + 6000 * u, 1).lp * g; r[i] = ((p2 % 1) * 2 - 1) * g * 0.6; }
  fx.addStereo(l, r, 3.0, 1);
}

// ===== COMPÁS 3 (4–6 s): DROP =====
// impacto: sub-drop + crash de ruido
{
  const n = S(1.6), o = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / SR; ph += TAU * (28 + 70 * Math.exp(-t * 3)) / SR; o[i] = Math.sin(ph) * Math.exp(-t * 2.4) * Math.min(1, t / 0.003); }
  fx.add(o, 4.0, 0.7, 0);
  const c = new Float32Array(S(1.2)), cr = new Float32Array(S(1.2)), f1 = new SVF(), f2 = new SVF();
  for (let i = 0; i < c.length; i++) { const t = i / SR, e = Math.exp(-t * 3.2); c[i] = f1.run(noise(), 3500, 0.6).hp * e; cr[i] = f2.run(noise(), 3500, 0.6).hp * e; }
  fx.addStereo(c, cr, 4.0, 0.32); verbSend.addStereo(c, cr, 4.0, 0.25);
}
for (const k of KICKS) if (k >= 4 && k < 7) drums.add(kick(0.42, 1.2), k, 1.05);
for (const c of CLAPS) if (c >= 4) { const s = clap(); drums.add(s, c, 0.6, -0.05); verbSend.add(s, c, 0.4); }
for (let k = 0; k < 24; k++) { const t = 4.0 + k * 0.125; if (t >= 6.75) break; drums.add(hat(), t, k % 2 ? 0.2 : 0.11, 0.3); }
for (let k = 0; k < 6; k++) { const t = 4.25 + k * 0.5; drums.add(hat(true), t, 0.17, -0.3); }
// bajo sostenido: Bb → C → D
[[4.0, 34], [5.0, 36], [6.0, 38]].forEach(([t, m]) => bass.add(bassNote(m, 1.0, { cut: 420 }), t, 0.85));
// supersaw principal con bombeo
[[4.0, [58, 62, 65, 69, 74]], [5.0, [60, 64, 67, 72, 74]], [6.0, [62, 65, 69, 74, 76]]].forEach(([t, ns]) => {
  const [l, r] = supersaw(ns, 1.0, { voices: 7, detune: 0.2, cutoff: u => 2400 + 3500 * Math.exp(-u * 3), q: 0.9, env: u => Math.min(1, u / 0.004) * (u > 0.985 ? (1 - u) / 0.015 : 1) });
  chords.addStereo(l, r, t, 0.75); verbSend.addStereo(l, r, t, 0.18);
});
// partículas (5.0): granos sinusoidales agudos dispersos en estéreo
{
  const r2 = rng(99); const pent = [86, 88, 91, 93, 95, 98, 100, 103];
  for (let g = 0; g < 46; g++) {
    const t = 5.0 + Math.pow(r2(), 1.6) * 0.55, m = pent[Math.floor(r2() * pent.length)], dur = 0.05 + r2() * 0.08;
    const n = S(dur), o = new Float32Array(n); for (let i = 0; i < n; i++) { const u = i / n; o[i] = Math.sin(TAU * mtof(m) * i / SR) * Math.sin(Math.PI * u) ** 2; }
    fx.add(o, t, 0.05 + r2() * 0.05, r2() * 2 - 1); verbSend.add(o, t, 0.06);
  }
  fx.add(sweep(0.5, 9000, 800, { q: 0.9, shape: u => Math.sqrt(u), gainEnv: u => Math.exp(-u * 5) }), 5.0, 0.4, 0);
}
// melodía principal (semicorcheas) — KS + sierra filtrada
const MEL = [[4.0, 81], [4.25, 77], [4.375, 81], [4.5, 84], [4.75, 86], [4.875, 84],
             [5.0, 79], [5.25, 76], [5.375, 79], [5.5, 86], [5.75, 88], [5.875, 86],
             [6.0, 81], [6.25, 77], [6.375, 81], [6.5, 88], [6.625, 86]];
for (const [t, m] of MEL) {
  const pl = pluck(m, 0.5, 0.75, 0.995);
  const n = pl.length, sq = sawVoice(mtof(m), n), f = new SVF(), o = new Float32Array(n);
  for (let i = 0; i < n; i++) { const u = i / SR; o[i] = pl[i] * 0.8 + f.run(sq[i], 900 + 5000 * Math.exp(-u * 16), 1.6).lp * Math.exp(-u * 9) * 0.35; }
  lead.add(o, t, 0.38, 0.1); delaySend.add(o, t, 0.3); verbSend.add(o, t, 0.15);
}

// ===== COMPÁS 4 (6–8 s): montaje + identidad =====
// acentos por corte
fx.add(blip(3200, 90, 0.22, 22), 6.25, 0.3, 0.4);                         // zap en el corte 2
{ const s = blip(160, 70, 0.3, 15); drums.add(s, 6.5, 0.4, -0.2); }       // tom en el corte 3
// final 7.0: acorde Fadd9 grande + todo
{
  drums.add(kick(0.6, 1.3), 7.0, 1.1);
  const [l, r] = supersaw([41, 53, 60, 65, 67, 69, 72], 1.0, { voices: 7, detune: 0.22, cutoff: u => 900 + 6000 * Math.exp(-u * 4), q: 0.8, env: u => Math.min(1, u / 0.003) * Math.exp(-u * 3.2) });
  chords.addStereo(l, r, 7.0, 0.95); verbSend.addStereo(l, r, 7.0, 0.5);
  bass.add(bassNote(29, 0.95, { cut: 300 }).map((x, i) => x * Math.exp(-i / SR * 3)), 7.0, 0.9);
  const c = new Float32Array(S(1)), cr = new Float32Array(S(1)), f1 = new SVF(), f2 = new SVF();
  for (let i = 0; i < c.length; i++) { const t = i / SR, e = Math.exp(-t * 4); c[i] = f1.run(noise(), 4000, 0.6).hp * e; cr[i] = f2.run(noise(), 4000, 0.6).hp * e; }
  fx.addStereo(c, cr, 7.0, 0.25); verbSend.addStereo(c, cr, 7.0, 0.3);
  // "ding" de resolución cuando aparece el subtítulo + clics de tecleo
  for (const [m, p] of [[81, -0.2], [89, 0.2]]) { const pl = pluck(m, 0.9, 0.5, 0.998); lead.add(pl, 7.45, 0.28, p); verbSend.add(pl, 7.45, 0.45); delaySend.add(pl, 7.45, 0.2); }
  for (let i = 0; i < 31; i++) { const t = 7.45 + i * 0.014; const n = S(0.006), o = new Float32Array(n); for (let k = 0; k < n; k++) o[k] = noise() * Math.exp(-k / SR * 900); fx.add(o, t, 0.045, (i / 15 - 1) * 0.4); }
}

// ---------- procesado ----------
// sidechain (ligado a los bombos)
applyDuck(chords, 0.72, 2.0, 7.0);
applyDuck(bass, 0.6, 4.0, 7.0);
applyDuck(lead, 0.3, 4.0, 7.0);

// glitch-stutter 6.767 → 7.0 sobre acordes + lead (repetición de rebanadas cada vez más cortas + bitcrush)
function stutter(bus, t0, t1) {
  const s0 = S(t0), s1 = S(t1);
  for (const ch of [bus.L, bus.R]) {
    const src = ch.slice(s0, s0 + S(0.0625));
    let i = s0, slice = S(0.0625), rep = 0;
    while (i < s1) {
      for (let k = 0; k < slice && i < s1; k++, i++) {
        const fade = Math.min(1, k / 40, (slice - k) / 40);
        let v = src[k % src.length] * fade;
        v = Math.round(v * 24) / 24;                       // bitcrush
        ch[i] = v;
      }
      rep++; if (rep % 2 === 0) slice = Math.max(S(0.012), Math.floor(slice * 0.62));
    }
  }
}
stutter(chords, 6.767, 7.0); stutter(lead, 6.767, 7.0);
// el resto calla antes del golpe final
for (const b of [drums, bass, delaySend]) for (let i = S(6.75); i < S(7.0); i++) { const g = Math.max(0, 1 - (i - S(6.75)) / S(0.05)); if (b === drums) continue; b.L[i] *= g; b.R[i] *= g; }

// delay ping-pong a corchea con puntillo (0.375 s), con LP en la realimentación
function pingpong(src, time = 0.375, fb = 0.38) {
  const d = S(time), l = new Float32Array(N), r = new Float32Array(N); let zl = 0, zr = 0; const a = Math.exp(-TAU * 4500 / SR);
  for (let i = 0; i < N; i++) {
    const inl = (src.L[i] + src.R[i]) * 0.5;
    const dl = i >= d ? l[i - d] : 0, dr = i >= d ? r[i - d] : 0;
    zl = (1 - a) * (inl + dr * fb) + a * zl; zr = (1 - a) * (dl * fb) + a * zr;
    l[i] = zl; r[i] = zr;
  }
  return { L: l, R: r };
}
// FFT radix-2 para reverb por convolución
function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = TAU / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
function convolve(x, h) {
  let n = 1; while (n < x.length + h.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x); br.set(h); fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) { const r = ar[i] * br[i] - ai[i] * bi[i], m = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r; ai[i] = m; }
  fft(ar, ai, true); return Float32Array.from(ar.subarray(0, x.length));
}
// respuesta al impulso sintética: ruido decorrelado L/R con decaimiento exponencial y amortiguación de agudos
function makeIR(seed, rt60 = 1.5, len = 1.6) {
  const r = rng(seed), n = S(len), o = new Float32Array(n); let z = 0; const pre = S(0.014);
  for (let i = pre; i < n; i++) {
    const t = (i - pre) / SR, fc = 9000 * Math.exp(-t * 2.2) + 900, a = Math.exp(-TAU * fc / SR);
    z = (1 - a) * (r() * 2 - 1) + a * z;
    o[i] = z * Math.exp(-6.9 * t / rt60) * Math.min(1, t / 0.02);
  }
  let e = 0; for (const v of o) e += v * v; const g = 1 / Math.sqrt(e); for (let i = 0; i < n; i++) o[i] *= g;
  return o;
}
const dly = pingpong(delaySend);
for (let i = 0; i < N; i++) { verbSend.L[i] += dly.L[i] * 0.3; verbSend.R[i] += dly.R[i] * 0.3; }
const revL = convolve(verbSend.L, makeIR(11)), revR = convolve(verbSend.R, makeIR(23));

// ---------- mezcla ----------
const mixL = new Float32Array(N), mixR = new Float32Array(N);
const stems = [[drums, 0.9], [bass, 0.85], [chords, 0.62], [lead, 1.6], [fx, 0.8], [dly, 0.45]];
for (const [b, g] of stems) for (let i = 0; i < N; i++) { mixL[i] += b.L[i] * g; mixR[i] += b.R[i] * g; }
for (let i = 0; i < N; i++) { mixL[i] += revL[i] * 0.32; mixR[i] += revR[i] * 0.32; }

// HPF suave a 25 Hz para limpiar DC/sub-infra
{ const a = new SVF(), b = new SVF(); for (let i = 0; i < N; i++) { mixL[i] = a.run(mixL[i], 25, 0.7).hp; mixR[i] = b.run(mixR[i], 25, 0.7).hp; } }
// compresor de bus (detector de pico, ataque 3 ms, release 120 ms)
{
  let env = 0; const at = Math.exp(-1 / (0.003 * SR)), rl = Math.exp(-1 / (0.12 * SR)); const thr = 0.35, ratio = 2.5;
  for (let i = 0; i < N; i++) {
    const x = Math.max(Math.abs(mixL[i]), Math.abs(mixR[i]));
    env = x > env ? at * env + (1 - at) * x : rl * env + (1 - rl) * x;
    const g = env > thr ? Math.pow(env / thr, 1 / ratio - 1) : 1;
    mixL[i] *= g; mixR[i] *= g;
  }
}
// saturación suave + normalización a −1 dBFS
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(mixL[i]), Math.abs(mixR[i]));
const drive = 1.6 / peak;
for (let i = 0; i < N; i++) { mixL[i] = Math.tanh(mixL[i] * drive); mixR[i] = Math.tanh(mixR[i] * drive); }
// pico real (true-peak) estimado con sobremuestreo ×4 por sinc enventanada → −1 dBTP
function truePeak(ch) {
  let p = 0; const T = 8;
  for (let i = T; i < N - T; i++) {
    p = Math.max(p, Math.abs(ch[i]));
    for (let f = 1; f < 4; f++) {
      const x = f / 4; let s = 0;
      for (let k = -T + 1; k <= T; k++) { const d = k - x; const w = 0.5 + 0.5 * Math.cos(Math.PI * d / T); s += ch[i + k] * (Math.sin(Math.PI * d) / (Math.PI * d)) * w; }
      p = Math.max(p, Math.abs(s));
    }
  }
  return p;
}
peak = Math.max(truePeak(mixL), truePeak(mixR));
const norm = Math.pow(10, -1.2 / 20) / peak;
for (let i = 0; i < N; i++) {
  const fade = Math.min(1, i / S(0.004), (N - 1 - i) / S(0.12));
  mixL[i] *= norm * fade; mixR[i] *= norm * fade;
}

// ---------- WAV 16-bit con dither TPDF ----------
const out = process.argv[2] || 'music.wav';
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  for (const [c, ch] of [[0, mixL], [1, mixR]]) {
    const d = (rnd() - rnd()) / 32768;
    buf.writeInt16LE(clamp(Math.round((ch[i] + d) * 32767), -32768, 32767), 44 + i * 4 + c * 2);
  }
}
writeFileSync(out, buf);
// informe por stem (RMS dBFS) para revisar la mezcla sin oírla
const rms = a => { let s = 0; for (const v of a) s += v * v; return (10 * Math.log10(s / a.length + 1e-12)).toFixed(1); };
console.log('stems RMS dB:', Object.fromEntries([['drums', drums], ['bass', bass], ['chords', chords], ['lead', lead], ['fx', fx]].map(([k, b]) => [k, rms(b.L)])), 'peak→drive', drive.toFixed(2));
console.log('wrote', out);
