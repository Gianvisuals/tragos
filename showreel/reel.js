'use strict';
/* =====================================================================
   MOTION REEL '26 — Claude
   Vídeo de 8 s, 1920×1080, 30 fps. Todo es código: Canvas2D + WebGL2.
   Pipeline por fotograma:
     N sub-fotogramas (obturador 180°) → cada uno se dibuja en Canvas2D
     (+ shaders WebGL para 3D/líquido) → se acumula en un FBO float en
     espacio lineal (motion blur real + antialias por jitter) → post:
     bloom, aberración cromática, viñeta, grano.
   ===================================================================== */
const W = 1920, H = 1080, FPS = 30, NF = 240;
const TAU = Math.PI * 2;
const C = { ink: '#0C0C10', paper: '#F1ECE2', red: '#FF4321', blue: '#2337FF', lime: '#D4FF3A' };
const RGB = { ink: [12, 12, 16], paper: [241, 236, 226], red: [255, 67, 33], blue: [35, 55, 255], lime: [212, 255, 58] };

/* ---------------- matemáticas y curvas ---------------- */
const clamp = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;
const lerp = (a, b, t) => a + (b - a) * t;
const prog = (t, start, dur) => clamp((t - start) / dur);
const E = {
  inQuad: t => t * t,
  outQuad: t => 1 - (1 - t) * (1 - t),
  inCubic: t => t * t * t,
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inOutCubic: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  outQuart: t => 1 - Math.pow(1 - t, 4),
  inExpo: t => t <= 0 ? 0 : Math.pow(2, 10 * t - 10),
  outExpo: t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
  inOutExpo: t => t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  outBack: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
};
// Bézier cúbica estilo CSS/After Effects (resuelta por bisección: robusta y determinista)
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = t => ((ax * t + bx) * t + cx) * t, sy = t => ((ay * t + by) * t + cy) * t;
  return x => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i++) { if (sx(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}
const easeSig = cubicBezier(0.7, 0, 0.15, 1);    // curva firma: arranque contenido, frenada larga
const easeSnap = cubicBezier(0.8, 0, 0.2, 1);
// muelle amortiguado (respuesta a escalón 0→1)
function spring(t, freq = 3, damp = 0.4) {
  if (t <= 0) return 0;
  const w = TAU * freq, wd = w * Math.sqrt(1 - damp * damp);
  return 1 - Math.exp(-damp * w * t) * (Math.cos(wd * t) + (damp * w / wd) * Math.sin(wd * t));
}
// impulso amortiguado (0 → oscila → 0)
const wobble = (t, freq = 3, decay = 6) => t <= 0 ? 0 : Math.exp(-decay * t) * Math.sin(TAU * freq * t);
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// ruido de Perlin 3D
const PERM = new Uint8Array(512);
{ const r = rng(7), p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]; }
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h, x, y, z) { const u = h < 8 ? x : y, v = h < 4 ? y : h === 12 || h === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); }
function noise3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z), P = PERM;
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  return lerp(lerp(lerp(grad(P[AA] & 15, x, y, z), grad(P[BA] & 15, x - 1, y, z), u), lerp(grad(P[AB] & 15, x, y - 1, z), grad(P[BB] & 15, x - 1, y - 1, z), u), v),
    lerp(lerp(grad(P[AA + 1] & 15, x, y, z - 1), grad(P[BA + 1] & 15, x - 1, y, z - 1), u), lerp(grad(P[AB + 1] & 15, x, y - 1, z - 1), grad(P[BB + 1] & 15, x - 1, y - 1, z - 1), u), v), w);
}
const mixRGB = (a, b, t) => `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
const rgba = (k, a) => `rgba(${RGB[k][0]},${RGB[k][1]},${RGB[k][2]},${a})`;

/* ---------------- línea de tiempo (compartida con music.mjs) ---------------- */
const KICKS = [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0];
const ROLL = (() => { const h = []; for (let t = 3.0; t < 3.5 - 1e-6; t += 0.125) h.push(t); for (let t = 3.5; t < 3.75 - 1e-6; t += 0.0625) h.push(t); for (let t = 3.75; t < 3.875 - 1e-6; t += 0.03125) h.push(t); return h; })();
const CUT = [6.0, 188 / 30, 195 / 30, 203 / 30, 7.0];         // cortes del montaje (corcheas cuantizadas a fotograma)
const SHAKES = [[0.5, 9], [1.0, 7], [4.0, 26], [5.0, 14], [7.0, 10]];
const CA_HITS = [[0.5, 5], [1.0, 5], [2.0, 4], [4.0, 18], [5.0, 12], [CUT[1], 7], [CUT[2], 7], [CUT[3], 12], [7.0, 9]];
const kickPulse = t => { let p = 0; for (const k of KICKS) if (t >= k) p = Math.max(p, Math.exp(-(t - k) * 9)); return p; };

/* ---------------- lienzos ---------------- */
const out = document.getElementById('out');
const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
const sceneCanvas = mk(), ctx = sceneCanvas.getContext('2d');
const bufCanvas = mk(), bctx = bufCanvas.getContext('2d');
const glCanvas = mk();
const sgl = glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });

/* ---------------- utilidades WebGL ---------------- */
const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;
function program(gl, fs) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src); return s; };
  const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const cache = {};
  return { p, u: n => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n))) };
}
function quad(gl) {
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return vao;
}

/* ---------------- shaders de escena ---------------- */
// Blob 3D: SDF con unión suave, cromado iridiscente (película fina), entorno de estudio procedural
const FS_BLOB = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 R; uniform vec2 J; uniform float T, P, K, A;
mat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
float smin(float a, float b, float k){ float h=clamp(.5+.5*(b-a)/k,0.,1.); return mix(b,a,h)-k*h*(1.-h); }
float sdTorus(vec3 p, vec2 t){ vec2 q=vec2(length(p.xz)-t.x,p.y); return length(q)-t.y; }
float map(vec3 p){
  p/=K;
  float d = length(p) - (0.92 + 0.07*P);
  d += 0.045*sin(3.1*p.x+T*2.3)*sin(2.7*p.y+T*1.9)*sin(3.3*p.z+T*1.4);
  for(int i=0;i<4;i++){
    float fi=float(i), a=T*(1.1+0.3*fi)+fi*1.7;
    vec3 c=vec3(cos(a)*1.25, sin(a*1.3+fi*2.1)*0.7, sin(a)*1.25);
    c.xy*=rot(fi*0.9);
    d=smin(d, length(p-c)-(0.34+0.05*fi), 0.55);
  }
  vec3 q=p; q.yz*=rot(0.55); q.xy*=rot(0.3+T*0.4);
  d=min(d, sdTorus(q, vec2(1.95, 0.035)));
  vec3 s=p-vec3(cos(T*1.7)*2.3, 0.9*sin(T*1.3), sin(T*1.7)*2.3);
  d=min(d, length(s)-0.12);
  return d*K;
}
vec3 nrm(vec3 p){ const vec2 k=vec2(1,-1); float h=0.0012;
  return normalize(k.xyy*map(p+k.xyy*h)+k.yyx*map(p+k.yyx*h)+k.yxy*map(p+k.yxy*h)+k.xxx*map(p+k.xxx*h)); }
vec3 env(vec3 r){
  vec3 col = mix(vec3(0.002,0.002,0.004), vec3(0.012,0.016,0.06), smoothstep(-0.4,0.9,r.y));
  col += vec3(5.0)*smoothstep(0.62,0.82,r.y)*smoothstep(0.75,0.35,abs(r.x+0.15*r.z));          // softbox cenital
  col += vec3(1.0,0.056,0.015)*5.0*smoothstep(0.5,0.85,r.x)*smoothstep(0.65,0.15,abs(r.y-0.05)); // tira roja
  col += vec3(0.017,0.04,1.0)*5.0*smoothstep(0.5,0.85,-r.x)*smoothstep(0.65,0.15,abs(r.y+0.1)); // tira azul
  col += vec3(0.66,1.0,0.042)*1.6*smoothstep(0.75,0.98,-r.z)*smoothstep(0.2,-0.3,r.y);          // contra lima
  col += vec3(0.25)*smoothstep(-0.6,-0.95,r.y);                                                     // rebote de suelo
  return col;
}
void main(){
  vec2 uv=(gl_FragCoord.xy+J-0.5*R)/R.y;
  vec3 ro=vec3(sin(A)*7.4, 1.2, cos(A)*7.4), f=normalize(-ro), rr=normalize(cross(vec3(0,1,0),f)), up=cross(f,rr);
  vec3 rd=normalize(uv.x*rr+uv.y*up+1.75*f);
  float t=0.; bool hit=false;
  for(int i=0;i<90;i++){ float h=map(ro+rd*t); if(h<0.0007*t){hit=true;break;} t+=h; if(t>12.) break; }
  if(!hit){ o=vec4(0); return; }
  vec3 p=ro+rd*t, n=nrm(p);
  float ndv=clamp(dot(n,-rd),0.,1.);
  float fr=0.06+0.94*pow(1.-ndv,4.);
  vec3 irid=pow(0.5+0.5*cos(6.2831*(ndv*1.35+vec3(0.0,0.33,0.67)+0.1*T+0.25)), vec3(2.2));
  vec3 rf=env(reflect(rd,n));
  float ao=1.; { float s=0.; for(int k=1;k<=4;k++){ float hk=0.07*float(k); s+=(hk-map(p+n*hk))/hk; } ao=clamp(1.-0.35*s,0.,1.); }
  vec3 col = rf*mix(irid*0.9+0.08, vec3(1.0), fr) * ao;
  col += irid*0.02;
  col = 1.0-exp(-col*1.25);
  o=vec4(pow(col, vec3(1./2.2)), 1.);
}`;
// Fluido: domain warping de fbm, paleta de la marca semi-posterizada
const FS_LIQUID = `#version 300 es
precision highp float;
out vec4 o;
uniform vec2 R; uniform vec2 J; uniform float T;
float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return s; }
void main(){
  vec2 uv=(gl_FragCoord.xy+J)/R.y*1.4;
  float t=T;
  vec2 q=vec2(fbm(uv+vec2(0.,t*.6)), fbm(uv+vec2(5.2,1.3)-t*.5));
  vec2 r=vec2(fbm(uv+3.6*q+vec2(1.7,9.2)+t*.9), fbm(uv+3.6*q+vec2(8.3,2.8)-t*.7));
  float f=fbm(uv+3.6*r);
  vec3 P[5] = vec3[5](vec3(0.047,0.047,0.063), vec3(0.137,0.216,1.0), vec3(1.0,0.262,0.129), vec3(0.945,0.925,0.886), vec3(0.831,1.0,0.227));
  float x=clamp((f-0.25)*2.4+0.35*r.x-0.1,0.,0.999)*4.;
  int i=int(floor(x)); float k=smoothstep(0.42,0.58,fract(x));
  vec3 col=mix(P[i], P[min(i+1,4)], k);
  o=vec4(col,1.);
}`;
const G = (() => {
  const gl = sgl, vao = quad(gl);
  const blob = program(gl, FS_BLOB), liquid = program(gl, FS_LIQUID);
  function run(prog, uniforms) {
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.p); gl.bindVertexArray(vao);
    gl.uniform2f(prog.u('R'), W, H);
    for (const [k, v] of Object.entries(uniforms)) Array.isArray(v) ? gl.uniform2f(prog.u(k), v[0], v[1]) : gl.uniform1f(prog.u(k), v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return glCanvas;
  }
  return { blob: u => run(blob, u), liquid: u => run(liquid, u) };
})();

/* ---------------- post-proceso: acumulación + bloom + CA + grano ---------------- */
const POST = (() => {
  const gl = out.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
  gl.getExtension('EXT_color_buffer_float'); gl.getExtension('OES_texture_float_linear');
  const vao = quad(gl);
  const tex = (w, h, ifmt, fmt, type) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null); return t; };
  const fbo = (w, h) => { const t = tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT), f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return { t, f, w, h }; };
  const src = tex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  const acc = fbo(W, H), half = fbo(W / 2, H / 2), q1 = fbo(W / 4, H / 4), q2 = fbo(W / 4, H / 4);
  const head = `#version 300 es
precision highp float; out vec4 o; uniform vec2 S; uniform sampler2D A; uniform sampler2D B;`;
  const pAcc = program(gl, head + `uniform float k; void main(){ vec3 c=texture(A,gl_FragCoord.xy/S).rgb; o=vec4(pow(c,vec3(2.2))*k,k); }`);
  const pBright = program(gl, head + `uniform float th; void main(){ vec3 c=texture(A,gl_FragCoord.xy/S).rgb; float l=dot(c,vec3(0.2126,0.7152,0.0722)); o=vec4(c*smoothstep(th,th+0.35,l),1.); }`);
  const pCopy = program(gl, head + `void main(){ o=texture(A,gl_FragCoord.xy/S); }`);
  const pBlur = program(gl, head + `uniform vec2 D; void main(){ vec2 uv=gl_FragCoord.xy/S; vec3 c=texture(A,uv).rgb*0.227027;
    float w[4]=float[4](0.1945946,0.1216216,0.054054,0.016216);
    for(int i=0;i<4;i++){ vec2 off=D*float(i+1)/S; c+=(texture(A,uv+off).rgb+texture(A,uv-off).rgb)*w[i]; } o=vec4(c,1.); }`);
  const pFinal = program(gl, head + `uniform float ca, bloom, grain, vig, seed;
    float h(vec2 p){ p=fract(p*vec2(443.897,441.423)); p+=dot(p,p.yx+19.19); return fract((p.x+p.y)*p.x); }
    void main(){ vec2 uv=gl_FragCoord.xy/S, d=uv-0.5; vec2 off=d*2.*ca/S.x;
      vec3 c=vec3(texture(A,uv+off).r, texture(A,uv).g, texture(A,uv-off).b);
      c+=bloom*texture(B,uv).rgb;
      c*=1.-vig*dot(d,d)*1.6;
      c=pow(max(c,0.),vec3(1./2.2));
      float n=h(gl_FragCoord.xy+seed*7.31)+h(gl_FragCoord.xy*0.731+seed*3.17)-1.;
      c+=n*grain*(1.-0.6*dot(c,vec3(0.3333)));
      o=vec4(c,1.); }`);
  function pass(prog, target, w, h, bind) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null); gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p); gl.bindVertexArray(vao); gl.uniform2f(prog.u('S'), w, h); bind(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const bindTex = (prog, name, unit, t) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u(name), unit); };
  return {
    begin() { gl.bindFramebuffer(gl.FRAMEBUFFER, acc.f); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); },
    add(canvas, k) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      pass(pAcc, acc, W, H, p => { bindTex(p, 'A', 0, src); gl.uniform1f(p.u('k'), k); });
      gl.disable(gl.BLEND);
    },
    finish({ ca = 1, bloom = 0, grain = 0.03, vig = 0.2, seed = 0, th = 0.55 }) {
      pass(pBright, half, W / 2, H / 2, p => { bindTex(p, 'A', 0, acc.t); gl.uniform1f(p.u('th'), th); });
      pass(pCopy, q1, W / 4, H / 4, p => bindTex(p, 'A', 0, half.t));
      for (const r of [1.5, 3.5]) {
        pass(pBlur, q2, W / 4, H / 4, p => { bindTex(p, 'A', 0, q1.t); gl.uniform2f(p.u('D'), r, 0); });
        pass(pBlur, q1, W / 4, H / 4, p => { bindTex(p, 'A', 0, q2.t); gl.uniform2f(p.u('D'), 0, r); });
      }
      pass(pFinal, null, W, H, p => {
        bindTex(p, 'A', 0, acc.t); bindTex(p, 'B', 1, q1.t);
        gl.uniform1f(p.u('ca'), ca); gl.uniform1f(p.u('bloom'), bloom); gl.uniform1f(p.u('grain'), grain); gl.uniform1f(p.u('vig'), vig); gl.uniform1f(p.u('seed'), seed);
      });
      gl.finish();
    },
  };
})();

/* ---------------- tipografía ---------------- */
const DISPLAY = '"Inter Display"', MONO = '"DejaVu Sans Mono"';
function font(c, weight, size, fam = DISPLAY, ls = 0, style = '') { c.font = `${style} ${weight} ${size}px ${fam}`.trim(); c.letterSpacing = ls + 'px'; }
// mide offsets por letra para animar carácter a carácter
function layout(str, weight, size, ls = 0, fam = DISPLAY, style = '') {
  font(bctx, weight, size, fam, ls, style);
  const offs = []; for (let i = 0; i <= str.length; i++) offs.push(bctx.measureText(str.slice(0, i)).width);
  const widths = [...str].map(ch => { font(bctx, weight, size, fam, 0, style); return bctx.measureText(ch).width; });
  return { str, offs, widths, width: offs[str.length] - ls, weight, size, ls, fam, style, cap: size * 0.727 };
}
function drawChar(c, L, i, x, y) { font(c, L.weight, L.size, L.fam, 0, L.style); c.fillText(L.str[i], x + L.offs[i], y); }

/* ---------------- HUD ---------------- */
function timecode(f) { const s = Math.floor(f / FPS), fr = f % FPS; return `00:00:${String(s).padStart(2, '0')}:${String(fr).padStart(2, '0')}`; }
function hud(c, t, f, sc) {
  const col = sc.hud, m = 56, intro = E.outCubic(prog(t, 0.0, 0.45));
  c.save();
  c.fillStyle = col; c.strokeStyle = col; c.textBaseline = 'alphabetic';
  // marcas de corte
  c.lineWidth = 1.5; const cm = 26, ci = 30;
  c.globalAlpha = 0.75;
  for (const [x, y, sx, sy] of [[ci, ci, 1, 1], [W - ci, ci, -1, 1], [ci, H - ci, 1, -1], [W - ci, H - ci, -1, -1]]) {
    c.beginPath(); c.moveTo(x, y + sy * cm * intro); c.lineTo(x, y); c.lineTo(x + sx * cm * intro, y); c.stroke();
  }
  c.globalAlpha = 1;
  const typed = (s, a) => s.slice(0, Math.floor(s.length * a));
  font(c, 500, 17, MONO, 2.5);
  // sup. izq.: firma
  c.fillStyle = C.red; c.beginPath(); c.arc(m + 6, m + 1, 6 * intro, 0, TAU); c.fill(); c.fillStyle = col;
  c.fillText(typed('CLAUDE  /  MOTION REEL ’26', intro), m + 22, m + 7);
  // sup. dcha.: escena + metrónomo
  c.textAlign = 'right';
  c.fillText(typed(`${String(sc.idx).padStart(2, '0')} / 08`, intro), W - m, m + 7);
  const bt = Math.floor(t * 2 + 1e-6) / 2, bp = Math.exp(-(t - bt) * 10);
  c.fillText('120 BPM', W - m - 130, m + 7);
  c.globalAlpha = 0.35 + 0.65 * bp; c.fillRect(W - m - 120, m - 5, 12, 12); c.globalAlpha = 1;
  // inf. izq.: timecode
  c.textAlign = 'left';
  c.fillText(typed('TC ' + timecode(f), intro), m, H - m - 10);
  // inf. dcha.: etiqueta de escena tecleada al entrar
  c.textAlign = 'right';
  const lab = `${String(sc.idx).padStart(2, '0')} — ${sc.label}`;
  c.fillText(typed(lab, prog(t, sc.s, 0.18) * intro), W - m, H - m - 10);
  // barra de progreso con 16 tiempos
  const y = H - m + 14, x0 = m, x1 = W - m, len = (x1 - x0) * intro;
  c.globalAlpha = 0.25; c.fillRect(x0, y, len, 2);
  c.globalAlpha = 1; c.fillRect(x0, y - 1, (x1 - x0) * clamp(t / 8), 4);
  for (let b = 0; b <= 16; b++) { const x = x0 + (x1 - x0) * b / 16; if (x > x0 + len) break; c.globalAlpha = b % 4 === 0 ? 0.9 : 0.4; c.fillRect(x - 1, y - (b % 4 === 0 ? 8 : 4), 2, b % 4 === 0 ? 18 : 10); }
  c.restore();
}

/* =====================================================================
   ESCENA 1 · 0.0–1.0 · SQUASH & STRETCH — pelota, carta de espaciado, onion skin
   ===================================================================== */
const FY = 800, BR = 64, DC = 0.07, IMPACTS = [[0.5, 900], [1.0, 1140]];
function ball(t) {
  let x, y, s = 1, sx = 1, sy = 1;
  if (t < 0.5) {
    const u = Math.max(0, t) / 0.5, y0 = 150, y1 = FY - BR; y = y0 + (y1 - y0) * u * u; x = lerp(640, 900, u);
    s = 1 + Math.min(0.42, (2 * (y1 - y0) * u / 0.5) / 5000); sx = 1 / Math.sqrt(s); sy = s;
  } else if (t < 0.5 + DC) {
    const c = Math.sin(Math.PI * (t - 0.5) / DC); sy = 1 - 0.45 * c; sx = 1 + 0.45 * c; x = 900; y = FY - BR * sy;
  } else if (t < 1.0) {
    const D = 0.5 - DC, u = (t - 0.5 - DC) / D; y = FY - BR - 280 * 4 * u * (1 - u); x = lerp(900, 1140, u);
    const v = Math.abs(280 * 4 * (1 - 2 * u) / D); s = 1 + Math.min(0.32, v / 6000); sx = 1 / Math.sqrt(s); sy = s;
  } else if (t < 1.0 + DC) {
    const c = Math.sin(Math.PI * (t - 1.0) / DC); sy = 1 - 0.4 * c; sx = 1 + 0.4 * c; x = 1140; y = FY - BR * sy;
  } else { x = 1140; y = FY - BR; }
  y = Math.min(y, FY - BR * sy);
  return { x, y, sx, sy };
}
function drawBall(c, b, r, color) { c.save(); c.translate(b.x, b.y); c.scale(b.sx, b.sy); c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fillStyle = color; c.fill(); c.restore(); }
function floorY(x, t) {
  let d = 0;
  for (const [ti, xi] of IMPACTS) {
    if (t < ti) continue;
    const g = Math.exp(-Math.pow((x - xi) / 190, 2));
    if (t < ti + DC) d += 26 * Math.sin(Math.PI * (t - ti) / DC) * g;
    else d += 26 * wobble(t - ti - DC + 0.04, 6.5, 9) * g * 1.3;
  }
  return FY + d;
}
function drawScene1(c, t, withBall = true) {
  c.fillStyle = C.ink; c.fillRect(0, 0, W, H);
  // suelo elástico
  const L = (W / 2 - 56) * E.outExpo(prog(t, 0.02, 0.7));
  c.strokeStyle = C.paper; c.lineWidth = 2; c.beginPath();
  for (let x = 960 - L; x <= 960 + L; x += 6) { const y = floorY(x, t); x === 960 - L ? c.moveTo(x, y) : c.lineTo(x, y); }
  c.stroke();
  // carta de espaciado (dots por fotograma)
  for (let k = 0; k <= 30; k++) {
    const tk = k / 30; if (tk > t) break;
    const b = ball(tk), a = E.outBack(prog(t, tk, 0.12));
    c.fillStyle = rgba('paper', 0.45); c.beginPath(); c.arc(b.x, b.y, 3.2 * a, 0, TAU); c.fill();
  }
  // gráfica de timing (arriba izq.) — espaciado ease-in de la caída
  {
    const x0 = 56, x1 = 56 + 360, y = 170;
    c.globalAlpha = E.outCubic(prog(t, 0.05, 0.3));
    font(c, 500, 13, MONO, 2); c.fillStyle = rgba('paper', 0.65); c.fillText('SPACING · EASE-IN  f00→f15', x0, y - 22);
    c.fillStyle = C.paper; c.fillRect(x0, y, (x1 - x0) * E.outExpo(prog(t, 0.05, 0.5)), 1.5);
    for (let k = 0; k <= 15; k++) { if (k / 30 > t) break; const x = lerp(x0, x1, (k / 15) ** 2), key = k === 0 || k === 15; c.fillRect(x - 1, y - (key ? 14 : 7), 2, key ? 28 : 14); }
    c.globalAlpha = 1;
  }
  // ondas elípticas sobre el plano del suelo + chispas
  for (const [ti, xi] of IMPACTS) {
    if (t < ti) continue;
    for (let r = 0; r < 2; r++) {
      const u = prog(t, ti + r * 0.07, 0.75); if (u <= 0 || u >= 1) continue;
      const rad = BR + 560 * E.outExpo(u);
      c.strokeStyle = rgba('paper', Math.pow(1 - u, 1.6) * 0.9); c.lineWidth = 2.5 * (1 - u) + 0.5;
      c.beginPath(); c.ellipse(xi, FY, rad, rad * 0.16, 0, 0, TAU); c.stroke();
    }
    const u = prog(t, ti, 0.35);
    if (u > 0 && u < 1) {
      c.strokeStyle = C.lime; c.lineWidth = 3; c.lineCap = 'round';
      for (let k = 0; k < 7; k++) {
        const a = Math.PI + (k + 0.5) / 7 * Math.PI, r0 = BR * 1.25 + 150 * E.outExpo(u), r1 = r0 + 46 * (1 - u);
        c.beginPath(); c.moveTo(xi + Math.cos(a) * r0, FY - 10 + Math.sin(a) * r0 * 0.75); c.lineTo(xi + Math.cos(a) * r1, FY - 10 + Math.sin(a) * r1 * 0.75); c.stroke();
      }
      c.lineCap = 'butt';
    }
  }
  if (!withBall) return;
  // onion skin: anteriores en rojo, siguientes en lima (convención de animación 2D)
  if (t > 0.06 && t < 0.98) {
    c.lineWidth = 2;
    for (const [dt, col, a] of [[-0.1, 'red', 0.28], [-0.05, 'red', 0.5], [0.05, 'lime', 0.5], [0.1, 'lime', 0.28]]) {
      const b = ball(t + dt); c.save(); c.translate(b.x, b.y); c.scale(b.sx, b.sy); c.beginPath(); c.arc(0, 0, BR, 0, TAU); c.restore();
      c.strokeStyle = rgba(col, a); c.stroke();
    }
  }
  drawBall(c, ball(t), BR, C.red);
}

/* =====================================================================
   ESCENA 2 · 1.0–1.9 · KINETIC TYPE — la pelota se convierte en la O
   ===================================================================== */
let MOT, MOT_X0, MOT_BASE, O1, O4, ROW, ROW_CHUNKS;
function setupScene2() {
  MOT = layout('MOTION', 900, 300, -6);
  MOT_X0 = (W - MOT.width) / 2; MOT_BASE = 540 + MOT.cap / 2;
  const oc = i => ({ x: MOT_X0 + MOT.offs[i] + MOT.widths[i] / 2, y: MOT_BASE - MOT.cap / 2, r: MOT.cap / 2 * 1.06 });
  O1 = oc(1); O4 = oc(4);
  ROW = layout('TIMING — SPACING — EASING — ARCS — OVERLAP — FOLLOW-THROUGH — ', 900, 104, -1);
  ROW_CHUNKS = []; let i0 = 0; for (let i = 1; i <= ROW.str.length; i++) if (i === ROW.str.length || ROW.str[i - 1] === ' ') { ROW_CHUNKS.push([i0, i]); i0 = i; }
}
const T_LEAVE = 1.0 + DC, T_LAND = T_LEAVE + 0.42;
function ballPath(t) {
  const u = easeSig(prog(t, T_LEAVE, 0.42));
  return { x: lerp(1140, O1.x, u), y: lerp(FY - BR, O1.y, u) - 250 * Math.sin(Math.PI * u) };
}
function drawScene2(c, t) {
  // fondo: barrido circular desde el segundo impacto
  if (t < 1.5) {
    drawScene1(c, t, false);
    c.fillStyle = C.paper; c.beginPath(); c.arc(1140, FY, 2400 * E.outExpo(prog(t, 1.0, 0.55)), 0, TAU); c.fill();
  } else { c.fillStyle = C.paper; c.fillRect(0, 0, W, H); }
  c.save();
  // empuje de cámara constante (nada está quieto)
  const z = 1 + 0.035 * prog(t, 1.1, 0.9);
  c.translate(960, 540); c.scale(z, z); c.translate(-960, -540);
  // filas de marquesina con contorno
  for (let r = 0; r < 2; r++) {
    const a = E.outExpo(prog(t, 1.45 + r * 0.06, 0.45)); if (a <= 0) continue;
    const yb = r === 0 ? 300 : 868, hh = 120 * a;
    c.save(); c.beginPath(); c.rect(0, yb - ROW.cap / 2 - hh / 2 - 10 - 10, W, hh + 20); c.clip();
    const sp = 820, x = r === 0 ? -200 - (t - 1.45) * sp : -1500 + (t - 1.45) * sp;
    font(c, ROW.weight, ROW.size, DISPLAY, ROW.ls); c.lineWidth = 1.6; c.strokeStyle = r === 0 ? C.ink : C.red;
    // por trozos: Chromium corrompe strokeText en cadenas de >3000 px
    const full = ROW.offs[ROW.str.length];
    for (let k = -1; k < 3; k++) for (const [i0, i1] of ROW_CHUNKS) {
      const xx = x + k * full + ROW.offs[i0]; if (xx > W || xx + ROW.offs[i1] - ROW.offs[i0] < 0) continue;
      c.strokeText(ROW.str.slice(i0, i1), xx, yb);
    }
    c.restore();
  }
  // la palabra: skew de látigo en el tiempo 3 (overlapping action)
  c.save();
  const sk = 0.32 * wobble(t - 1.5, 2.4, 7);
  c.translate(0, MOT_BASE); c.transform(1, 0, -sk, 1, 0, 0); c.translate(0, -MOT_BASE);
  // subrayado del que emergen las letras
  const lA = E.outExpo(prog(t, 1.05, 0.4)), lB = E.outExpo(prog(t, 1.55, 0.35));
  const lx0 = MOT_X0 - 20, lx1 = MOT_X0 + MOT.width + 20;
  c.fillStyle = C.ink; c.fillRect(lerp(lx0, lx1, lB), MOT_BASE + 16, (lx1 - lx0) * (lA - lB), 5);
  c.save(); c.beginPath(); c.rect(0, MOT_BASE - MOT.size * 1.3, W, MOT.size * 1.3 + 14); c.clip();
  c.fillStyle = C.ink; c.textBaseline = 'alphabetic';
  for (let i = 0; i < 6; i++) {
    if (i === 1 || i === 4) continue;
    const u = E.outExpo(prog(t, 1.1 + i * 0.045, 0.6)); if (u <= 0) continue;
    drawChar(c, MOT, i, MOT_X0, MOT_BASE + (1 - u) * MOT.size * 1.05);
  }
  c.restore();
  // la segunda O: anillo que se dibuja
  const pr = E.inOutCubic(prog(t, 1.22, 0.5));
  if (pr > 0) { c.strokeStyle = C.red; c.lineWidth = MOT.size * 0.155; c.beginPath(); c.arc(O4.x, O4.y, O4.r - c.lineWidth / 2, -Math.PI / 2, -Math.PI / 2 + TAU * pr); c.stroke(); }
  c.restore();
  // la pelota → primera O (squash/stretch orientado a la velocidad)
  if (t < T_LEAVE) { drawBall(c, ball(t), BR, C.red); }
  else {
    const p = ballPath(t), p0 = ballPath(t - 1 / 120);
    const vx = (p.x - p0.x) * 120, vy = (p.y - p0.y) * 120, sp = Math.hypot(vx, vy);
    const r = lerp(BR, O1.r, spring(t - T_LEAVE - 0.08, 2.4, 0.38));
    const s = 1 + Math.min(0.4, sp / 7000), land = 0.16 * wobble(t - T_LAND, 3, 8);
    c.save(); c.translate(p.x, p.y);
    c.transform(1, 0, -sk * 0.9, 1, 0, 0);
    if (sp > 1) { const a = Math.atan2(vy, vx); c.rotate(a); c.scale(s, 1 / s); c.rotate(-a); }
    c.scale(1 + land, 1 - land);
    c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fillStyle = C.red; c.fill(); c.restore();
  }
  c.restore();
}

/* =====================================================================
   ESCENAS 3–4 · 1.9–4.0 · GRID SYSTEMS → ANTICIPATION
   1296 superelipses (círculo↔cuadrado↔astroide) que deletrean GRID y
   después caen en espiral hacia el centro.
   ===================================================================== */
const CELL = 40, GC = W / CELL, GR = H / CELL;
let CELLS = [];
function setupGrid() {
  const c = bctx; c.clearRect(0, 0, W, H);
  const L = layout('GRID', 900, 640, -10);
  font(c, 900, 640, DISPLAY, -10); c.fillStyle = '#fff'; c.fillText('GRID', (W - L.width) / 2, 540 + L.cap / 2);
  const img = c.getImageData(0, 0, W, H).data; c.clearRect(0, 0, W, H);
  const r = rng(3), RMAX = Math.hypot(960, 540);
  for (let j = 0; j < GR; j++) for (let i = 0; i < GC; i++) {
    const cx = i * CELL + CELL / 2, cy = j * CELL + CELL / 2;
    let cov = 0; for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) cov += img[((j * CELL + 5 + b * 10) * W + (i * CELL + 5 + a * 10)) * 4 + 3] / 255;
    cov /= 16;
    const dx = cx - 960, dy = cy - 540, r0 = Math.hypot(dx, dy);
    CELLS.push({ cx, cy, cov, d: r0, r0, a0: Math.atan2(dy, dx), rand: r(), RMAX });
  }
}
function superPath(c, x, y, hs, n, rot) {
  const M = 24, e = 2 / n, cr = Math.cos(rot), sr = Math.sin(rot);
  for (let k = 0; k < M; k++) {
    const a = k / M * TAU, ca = Math.cos(a), sa = Math.sin(a);
    const px = Math.sign(ca) * Math.pow(Math.abs(ca), e) * hs, py = Math.sign(sa) * Math.pow(Math.abs(sa), e) * hs;
    const X = x + px * cr - py * sr, Y = y + px * sr + py * cr;
    k ? c.lineTo(X, Y) : c.moveTo(X, Y);
  }
  c.closePath();
}
const bump = (t, t0, d) => { const u = (t - t0) / d; return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * Math.pow(u, 0.35)); };
function drawGrid(c, t) {
  // fondo cobalto → tinta durante la anticipación
  c.fillStyle = mixRGB(RGB.blue, RGB.ink, E.inOutCubic(prog(t, 3.0, 0.45))); c.fillRect(0, 0, W, H);
  c.save();
  const z = 1 + 0.14 * E.inQuad(prog(t, 3.0, 0.875));
  c.translate(960, 540); c.scale(z, z); c.rotate(-0.12 * E.inCubic(prog(t, 3.0, 0.875))); c.translate(-960, -540);
  // anillos del redoble
  for (const th of ROLL) {
    const u = prog(t, th, 0.5); if (u <= 0 || u >= 1) continue;
    c.strokeStyle = rgba('paper', 0.5 * (1 - u)); c.lineWidth = 1 + 5 * (1 - u);
    c.beginPath(); c.arc(960, 540, 30 + 950 * E.outExpo(u), 0, TAU); c.stroke();
  }
  const groups = new Map();
  for (const cell of CELLS) {
    const dC = cell.d / 3800;
    let frac = 0.22 * E.outBack(prog(t, 1.93 + dC, 0.35));
    if (frac <= 0) continue;
    frac += 0.2 * bump(t, 2.0 + dC, 0.45);
    let n = 2, rot = 0;
    const dD = (cell.cx + cell.cy) / (W + H) * 0.25;
    const m1 = E.inOutCubic(prog(t, 2.2 + dD, 0.3));
    n = lerp(2, 5, m1); rot += m1 * Math.PI / 2; frac = lerp(frac, 0.6, m1);
    const isText = cell.cov > 0.03;
    const m2 = E.outExpo(prog(t, 2.47 + dC * 0.8, 0.4));
    frac = lerp(frac, isText ? lerp(0.5, 0.97, cell.cov) : 0.24, m2);
    n = lerp(n, isText ? 14 : 0.7, m2); rot += isText ? 0 : m2 * Math.PI / 4;
    let col = isText ? 'paper' : 'paper', alpha = isText ? 1 : lerp(1, 0.55, m2);
    if (isText && prog(t, 2.72 + cell.cx / W * 0.2, 0.05) > 0.5) col = 'lime';
    if (!isText) frac += 0.08 * Math.sin(t * 9 + cell.cx * 0.01 + cell.cy * 0.013) * m2;
    let x = cell.cx, y = cell.cy;
    if (t > 2.95) { // espiral hacia el centro (interior primero)
      const dV = (1 - cell.r0 / cell.RMAX) * 0.28 + cell.rand * 0.07;
      const v = E.inCubic(prog(t, 3.0 + dV, 0.48));
      if (v >= 1) continue;
      const r = cell.r0 * (1 - v), a = cell.a0 + v * 2.2 * Math.PI * (1 + 0.3 * cell.rand);
      x = 960 + r * Math.cos(a); y = 540 + r * Math.sin(a);
      frac *= 1 - 0.6 * v; rot += v * 5;
      if (v > 0) { col = isText ? 'lime' : 'paper'; alpha = lerp(alpha, 1, v); }
    }
    const key = col + alpha.toFixed(2);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([x, y, frac * CELL / 2, n, rot]);
  }
  for (const [key, list] of groups) {
    const a = parseFloat(key.slice(-4)), col = key.slice(0, -4);
    c.beginPath(); for (const s of list) superPath(c, s[0], s[1], s[2], s[3], s[4]);
    c.fillStyle = rgba(col, a); c.fill();
  }
  // núcleo que absorbe todo y colapsa en el silencio previo al drop
  if (t > 3.1) {
    let r = 4 + 54 * E.inQuad(prog(t, 3.15, 0.65));
    r *= 1 - 0.94 * E.inExpo(prog(t, 3.8, 0.075));
    const g = c.createRadialGradient(960, 540, 0, 960, 540, r * 3);
    g.addColorStop(0, rgba('paper', 0.35)); g.addColorStop(1, rgba('paper', 0));
    c.fillStyle = g; c.beginPath(); c.arc(960, 540, r * 3, 0, TAU); c.fill();
    c.fillStyle = C.paper; c.beginPath(); c.arc(960, 540, r, 0, TAU); c.fill();
  }
  c.restore();
}
function drawScene3(c, t) {
  drawGrid(c, t);
  // transición de lamas: la escena 2 se rompe en franjas alternas
  if (t < 2.2) {
    drawScene2(bctx, t);
    const n = 10, hh = H / n;
    for (let i = 0; i < n; i++) {
      const u = easeSnap(prog(t, 1.9 + i * 0.012, 0.22)), off = (i % 2 ? 1 : -1) * (W + 60) * u;
      if (u >= 1) continue;
      c.drawImage(bufCanvas, 0, i * hh, W, hh, off, i * hh, W, hh);
    }
  }
}

/* =====================================================================
   ESCENA 5 · 4.0–5.0 · 3D / SHADING — drop
   ===================================================================== */
let DEPTH;
function drawScene5(c, t, jit) {
  c.fillStyle = C.ink; c.fillRect(0, 0, W, H);
  const g = c.createRadialGradient(960, 560, 0, 960, 560, 1100);
  g.addColorStop(0, '#1A1E4A'); g.addColorStop(0.55, '#101227'); g.addColorStop(1, C.ink);
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  // palabra gigante detrás (paralaje opuesto a la cámara)
  const k = E.outExpo(prog(t, 4.0, 0.55)), sc = lerp(1.4, 1, k);
  c.save(); c.translate(960 + lerp(70, -70, prog(t, 4, 1)), 540); c.scale(sc, sc);
  font(c, DEPTH.weight, DEPTH.size, DISPLAY, DEPTH.ls); c.fillStyle = C.red; c.textBaseline = 'alphabetic';
  c.fillText(DEPTH.str, -DEPTH.width / 2, DEPTH.cap / 2);
  c.restore();
  // blob raymarcheado
  const K = 0.0001 + E.outBack(prog(t, 4.0, 0.5), 2.2) * (1 - 0.22 * E.inCubic(prog(t, 4.72, 0.28)));
  const img = G.blob({ T: (t - 4.0) * 1.6 + 0.6, P: kickPulse(t), K, A: 0.35 + (t - 4.0) * 0.9, J: jit });
  c.drawImage(img, 0, 0);
  // llamadas técnicas tipo plano
  const callouts = [[1215, 365, 1490, 250, 'THIN-FILM IRIDESCENCE'], [720, 720, 380, 845, 'SDF · SMOOTH UNION k=.55']];
  callouts.forEach(([x0, y0, x1, y1, txt], i) => {
    const u = E.outExpo(prog(t, 4.18 + i * 0.1, 0.4)); if (u <= 0) return;
    const ux = lerp(x0, x1, u), uy = lerp(y0, y1, u);
    c.strokeStyle = rgba('paper', 0.8); c.lineWidth = 1.5; c.beginPath(); c.moveTo(x0, y0); c.lineTo(ux, uy); c.stroke();
    c.fillStyle = C.paper; c.beginPath(); c.arc(x0, y0, 4, 0, TAU); c.fill();
    font(c, 500, 15, MONO, 2); c.textAlign = i === 0 ? 'left' : 'right';
    const s = txt.slice(0, Math.floor(txt.length * prog(t, 4.3 + i * 0.1, 0.3)));
    c.fillText(s, x1 + (i === 0 ? 12 : -12), y1 + 5); c.textAlign = 'left';
  });
  // destello del drop
  const fl = t < 4.0 ? 1 : Math.exp(-(t - 4.0) * 13);   // subfotogramas previos al golpe: blanco pleno
  if (fl > 0.003) { c.fillStyle = `rgba(255,255,255,${fl})`; c.fillRect(0, 0, W, H); }
}

/* =====================================================================
   ESCENA 6 · 5.0–6.0 · PARTICLES — el blob estalla, flujo curl, forma "FORM"
   ===================================================================== */
const PN = 11000, PSTEP = 120, PT = 1.05, PS = Math.ceil(PT * PSTEP) + 1;
let PSIM, PART, PGS = 4;
function setupParticles() {
  const c = bctx; c.clearRect(0, 0, W, H);
  const L = layout('FORM', 900, 560, -8);
  font(c, 900, 560, DISPLAY, -8); c.fillStyle = '#fff'; c.fillText('FORM', (W - L.width) / 2, 540 + L.cap / 2);
  const img = c.getImageData(0, 0, W, H).data; c.clearRect(0, 0, W, H);
  let area = 0; for (let i = 3; i < img.length; i += 16) if (img[i] > 128) area += 4;
  const gs = Math.sqrt(area / PN) * 0.98, targets = []; PGS = gs;
  for (let y = gs / 2; y < H; y += gs) for (let x = gs / 2; x < W; x += gs) if (img[(Math.floor(y) * W + Math.floor(x)) * 4 + 3] > 128) targets.push([x, y]);
  const r = rng(42);
  for (let i = targets.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [targets[i], targets[j]] = [targets[j], targets[i]]; }
  PART = []; PSIM = new Float32Array(PN * PS * 2);
  const cols = ['paper', 'paper', 'paper', 'paper', 'paper', 'paper', 'paper', 'red', 'red', 'lime'];
  for (let i = 0; i < PN; i++) {
    const tg = targets[i % targets.length];
    const a = r() * TAU, rr = 300 * Math.sqrt(r());
    let x = 960 + Math.cos(a) * rr, y = 560 + Math.sin(a) * rr;
    const sp = 300 + 2100 * r() * r(), dir = a + (r() - 0.5) * 0.6;
    let vx = Math.cos(dir) * sp - Math.sin(dir) * sp * 0.35, vy = Math.sin(dir) * sp + Math.cos(dir) * sp * 0.35;
    const base = i * PS * 2;
    for (let s = 0; s < PS; s++) {
      PSIM[base + s * 2] = x; PSIM[base + s * 2 + 1] = y;
      const dt = 1 / PSTEP, tt = s * dt, sc = 1 / 520, e = 1;
      const n0 = noise3(x * sc, y * sc, tt * 0.8), nx = noise3((x + e) * sc, y * sc, tt * 0.8), ny = noise3(x * sc, (y + e) * sc, tt * 0.8);
      const cx = (ny - n0) / e, cy = -(nx - n0) / e;   // rotacional del potencial → flujo sin divergencia
      vx += cx * 2.0e6 * dt; vy += cy * 2.0e6 * dt;
      const drag = Math.exp(-2.4 * dt); vx *= drag; vy *= drag;
      x += vx * dt; y += vy * dt;
    }
    PART.push({ tx: tg[0], ty: tg[1], col: cols[Math.floor(r() * cols.length)], size: 2.2 + r() * 2.8, delay: (tg[0] / W) * 0.09 + r() * 0.04 });
  }
}
function drawScene6(c, t) {
  c.fillStyle = C.ink; c.fillRect(0, 0, W, H);
  const lt = clamp(t - 5.0, 0, PT - 1e-3), fs = lt * PSTEP, s0 = Math.floor(fs), fr = fs - s0;
  const zoom = 1 + 0.05 * E.inOutCubic(prog(t, 5.5, 0.5));
  c.save(); c.translate(960, 540); c.scale(zoom, zoom); c.translate(-960, -540);
  // onda de choque
  const u = prog(t, 5.0, 0.6);
  if (u > 0 && u < 1) { c.strokeStyle = rgba('paper', 0.7 * (1 - u)); c.lineWidth = 4 * (1 - u) + 1; c.beginPath(); c.arc(960, 560, 300 + 1300 * E.outExpo(u), 0, TAU); c.stroke(); }
  const paths = { paper: new Path2D(), red: new Path2D(), lime: new Path2D(), blue: new Path2D() };
  for (let i = 0; i < PN; i++) {
    const p = PART[i], b = i * PS * 2 + s0 * 2;
    const sx = PSIM[b] + (PSIM[b + 2] - PSIM[b]) * fr, sy = PSIM[b + 1] + (PSIM[b + 3] - PSIM[b + 1]) * fr;
    const w = E.inOutCubic(prog(t, 5.26 + p.delay, 0.42));
    const x = lerp(sx, p.tx, w), y = lerp(sy, p.ty, w), s = lerp(p.size, PGS * 0.82, w);
    paths[p.col].rect(x - s / 2, y - s / 2, s, s);
  }
  for (const k in paths) { c.fillStyle = C[k]; c.fill(paths[k]); }
  c.restore();
  const fl = t < 5.0 ? 0.9 : 0.9 * Math.exp(-(t - 5.0) * 18);
  if (fl > 0.003) { c.fillStyle = `rgba(255,255,255,${fl})`; c.fillRect(0, 0, W, H); }
}

/* =====================================================================
   ESCENA 7 · 6.0–7.0 · RHYTHM & EDIT — cuatro cortes a corchea
   ===================================================================== */
let W_FLUID, W_BUILD, W_LOOP, W_CODE, CODE_LINES, ARCS;
const pushIn = (c, t, t0, amt = 0.08) => { const s = lerp(1 + amt, 1, E.outExpo(prog(t, t0, 0.3))); c.translate(960, 540); c.scale(s, s); c.translate(-960, -540); };
function drawScene7a(c, t, jit) {
  c.drawImage(G.liquid({ T: 2.0 + (t - 6.0) * 5, J: jit }), 0, 0);
  c.save(); pushIn(c, t, CUT[0], 0.12);
  font(c, W_FLUID.weight, W_FLUID.size, DISPLAY, W_FLUID.ls, 'italic'); c.fillStyle = C.paper;
  c.fillText(W_FLUID.str, (W - W_FLUID.width) / 2, 540 + W_FLUID.cap / 2);
  c.restore();
}
function drawScene7b(c, t) {
  c.fillStyle = C.paper; c.fillRect(0, 0, W, H);
  c.save(); pushIn(c, t, CUT[1]);
  const N = 9, cw = 52, cx = 1200, cy = 250;
  const cells = []; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) cells.push([i, j]);
  cells.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  for (const [i, j] of cells) {
    const d = Math.hypot(i - 4, j - 4), hgt = 24 + 190 * (0.5 + 0.5 * Math.sin(d * 0.95 - t * 16));
    const x = cx + (i - j) * cw, y = cy + (i + j) * cw * 0.5, k = cw * 0.9, kh = k * 0.5;
    const poly = (pts, col) => { c.beginPath(); pts.forEach(([px, py], q) => q ? c.lineTo(px, py) : c.moveTo(px, py)); c.closePath(); c.fillStyle = col; c.fill(); };
    poly([[x - k, y - hgt], [x, y + kh - hgt], [x, y + kh], [x - k, y]], C.red);
    poly([[x, y + kh - hgt], [x + k, y - hgt], [x + k, y], [x, y + kh]], '#B0230B');
    poly([[x, y - kh - hgt], [x + k, y - hgt], [x, y + kh - hgt], [x - k, y - hgt]], '#FF7D5E');
  }
  font(c, W_BUILD.weight, W_BUILD.size, DISPLAY, W_BUILD.ls); c.fillStyle = C.ink;
  c.fillText(W_BUILD.str, 90, 985);
  c.restore();
}
function drawScene7c(c, t) {
  c.fillStyle = C.red; c.fillRect(0, 0, W, H);
  c.save(); pushIn(c, t, CUT[2], 0.1);
  const lt = t - CUT[2]; c.lineCap = 'round';
  for (const a of ARCS) {
    const ang = a.a0 + a.w * lt + a.dir * (1 - E.outExpo(prog(lt, 0, 0.35))) * 2.6;
    c.strokeStyle = a.col; c.lineWidth = a.lw; c.beginPath(); c.arc(960, 540, a.r, ang, ang + a.len); c.stroke();
  }
  c.lineCap = 'butt';
  font(c, W_LOOP.weight, W_LOOP.size, DISPLAY, W_LOOP.ls); c.fillStyle = C.ink;
  c.fillText(W_LOOP.str, (W - W_LOOP.width) / 2, 540 + W_LOOP.cap / 2);
  c.restore();
}
function drawScene7d(c, t) {
  c.fillStyle = C.ink; c.fillRect(0, 0, W, H);
  const lt = t - CUT[3], q = Math.round(t * FPS), r = rng(q * 977 + 13);
  c.save(); pushIn(c, t, CUT[3], 0.06);
  // el propio código fuente de este vídeo, desplazándose
  font(c, 400, 17, MONO, 0); c.fillStyle = rgba('lime', 0.34);
  for (let col = 0; col < 2; col++) {
    const x = col ? 1010 : 70, off = (lt * (col ? 700 : 520)) % 26;
    for (let k = 0; k < 44; k++) { const n = CODE_LINES.length, line = CODE_LINES[(((k + col * 23 + Math.floor(lt * (col ? 27 : 20))) % n) + n) % n]; c.fillText(line.slice(0, 74), x, k * 26 - off); }
  }
  // texto con separación RGB en el buffer, luego rebanadas desplazadas
  const b = bctx; b.clearRect(0, 0, W, H);
  font(b, W_CODE.weight, W_CODE.size, DISPLAY, W_CODE.ls); b.textBaseline = 'alphabetic';
  const x = (W - W_CODE.width) / 2, y = 540 + W_CODE.cap / 2, dx = 6 + 22 * r();
  b.globalCompositeOperation = 'lighter';
  b.fillStyle = C.red; b.fillText(W_CODE.str, x - dx, y);
  b.fillStyle = C.blue; b.fillText(W_CODE.str, x + dx, y + 2);
  b.globalCompositeOperation = 'source-over';
  b.fillStyle = C.paper; b.fillText(W_CODE.str, x, y);
  let yy = 0;
  while (yy < H) {
    const hh = 8 + Math.floor(r() * 70), glitch = r() < 0.32, off = glitch ? (r() - 0.5) * 260 : 0;
    c.drawImage(bufCanvas, 0, yy, W, hh, off, yy, W, hh); yy += hh;
  }
  c.fillStyle = C.lime;
  for (let k = 0; k < 4; k++) if (r() < 0.6) c.fillRect(r() * W, r() * H, 20 + r() * 260, 4 + r() * 14);
  c.restore();
  c.fillStyle = 'rgba(0,0,0,0.18)'; for (let yl = 0; yl < H; yl += 4) c.fillRect(0, yl, W, 1.5);
}

/* =====================================================================
   ESCENA 8 · 7.0–8.0 · IDENTITY — cierre
   ===================================================================== */
let NAME, SUB_TXT, FOOT;
function drawScene8(c, t) {
  c.fillStyle = C.paper; c.fillRect(0, 0, W, H);
  const D = 200, gap = 54, total = D + gap + NAME.width, gx = (W - total) / 2, cyy = 500;
  // anillos de eco del golpe final
  for (let k = 0; k < 2; k++) {
    const u = prog(t, 7.0 + k * 0.08, 0.8); if (u <= 0 || u >= 1) continue;
    c.strokeStyle = rgba('red', 0.8 * (1 - u)); c.lineWidth = 3 * (1 - u) + 0.5;
    c.beginPath(); c.arc(960, cyy, 100 + 900 * E.outExpo(u), 0, TAU); c.stroke();
  }
  // el círculo (callback a la pelota del inicio)
  const pop = E.outBack(prog(t, 7.0, 0.42), 2.4), mv = easeSig(prog(t, 7.16, 0.5));
  const bx = lerp(960, gx + D / 2, mv), breath = 0.05 * wobble(t - 7.45, 2.2, 5);
  c.save(); c.translate(bx, cyy); c.scale(1 + breath, 1 - breath); c.fillStyle = C.red; c.beginPath(); c.arc(0, 0, D / 2 * pop, 0, TAU); c.fill(); c.restore();
  // nombre que emerge de su máscara; el borde izquierdo de la máscara es el propio círculo (el logo "empuja" el texto)
  const tx = gx + D + gap, base = cyy + NAME.cap / 2, mL = Math.max(tx - 20, bx + D / 2 * pop + 14);
  c.save(); c.beginPath(); c.rect(mL, base - NAME.size * 1.2, tx + NAME.width + 40 - mL, NAME.size * 1.2 + 6); c.clip();
  c.fillStyle = C.ink;
  for (let i = 0; i < NAME.str.length; i++) { const u = E.outExpo(prog(t, 7.26 + i * 0.035, 0.55)); if (u <= 0) continue; drawChar(c, NAME, i, tx, base + (1 - u) * NAME.size * 1.1); }
  c.restore();
  // filete y subtítulo tecleado
  const ly = base + 64, la = E.outExpo(prog(t, 7.38, 0.55));
  c.fillStyle = C.ink; c.fillRect(gx, ly, total * la, 2);
  font(c, 500, 24, MONO, 6); c.fillStyle = C.ink;
  const n = Math.floor(clamp((t - 7.45) / 0.014, 0, SUB_TXT.length)), s = SUB_TXT.slice(0, n);
  c.fillText(s, gx, ly + 52);
  if (t > 7.45 && (n < SUB_TXT.length || Math.floor(t * 4) % 2 === 0)) { const w = c.measureText(s).width; c.fillStyle = C.red; c.fillRect(gx + w + 4, ly + 30, 13, 26); }
  // créditos de método
  font(c, 500, 15, MONO, 3); c.fillStyle = rgba('ink', 0.55 * E.outCubic(prog(t, 7.62, 0.3)));
  c.textAlign = 'center'; c.fillText(FOOT, 960, H - 120); c.textAlign = 'left';
  // fotograma de impacto: rojo pleno que se disuelve en 4 fotogramas
  const fl = t < 7.0 ? 1 : Math.exp(-(t - 7.0) * 20);
  if (fl > 0.003) { c.fillStyle = rgba('red', fl); c.fillRect(0, 0, W, H); }
}

/* ---------------- tabla de escenas ---------------- */
const SCENES = [
  { s: 0.0, e: 1.0, idx: 1, label: 'SQUASH & STRETCH', hud: C.paper, draw: drawScene1, post: { bloom: 0.35, vig: 0.4 } },
  { s: 1.0, e: 1.9, idx: 2, label: 'KINETIC TYPE', hud: C.ink, draw: drawScene2, post: { bloom: 0, vig: 0.12 } },
  { s: 1.9, e: 3.0, idx: 3, label: 'GRID SYSTEMS', hud: C.paper, draw: drawScene3, post: { bloom: 0.12, vig: 0.3 } },
  { s: 3.0, e: 4.0, idx: 4, label: 'ANTICIPATION', hud: C.paper, draw: drawScene3, post: { bloom: 0.55, vig: 0.45 } },
  { s: 4.0, e: 5.0, idx: 5, label: '3D · SHADING', hud: C.paper, draw: drawScene5, post: { bloom: 0.9, vig: 0.45 } },
  { s: 5.0, e: 6.0, idx: 6, label: 'PARTICLES', hud: C.paper, draw: drawScene6, post: { bloom: 0.3, vig: 0.45 } },
  { s: CUT[0], e: CUT[1], idx: 7, label: 'RHYTHM · FLUID', hud: C.paper, draw: drawScene7a, post: { bloom: 0.25, vig: 0.3 } },
  { s: CUT[1], e: CUT[2], idx: 7, label: 'RHYTHM · VOLUME', hud: C.ink, draw: drawScene7b, post: { bloom: 0, vig: 0.12 } },
  { s: CUT[2], e: CUT[3], idx: 7, label: 'RHYTHM · LOOP', hud: C.ink, draw: drawScene7c, post: { bloom: 0.1, vig: 0.2 } },
  { s: CUT[3], e: 7.0, idx: 7, label: 'RHYTHM · GLITCH', hud: C.lime, draw: drawScene7d, post: { bloom: 0.5, vig: 0.4 } },
  { s: 7.0, e: 9.0, idx: 8, label: 'IDENTITY', hud: C.ink, draw: drawScene8, post: { bloom: 0, vig: 0.1 } },
];
const sceneAt = tf => SCENES.find(s => tf >= s.s - 1e-6 && tf < s.e - 1e-6);

function shake(t) {
  let x = 0, y = 0;
  SHAKES.forEach(([ti, a], i) => { if (t < ti) return; const k = a * Math.exp(-(t - ti) * 11); x += k * noise3(t * 28, i * 3.1, 0.5); y += k * noise3(t * 28, i * 3.1, 7.5); });
  return [x * 1.8, y * 1.8];
}

/* ---------------- render de un fotograma ---------------- */
const HALTON = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
function renderFrame(f, sub = 8) {
  const tf = f / FPS, sc = sceneAt(tf), shutter = 0.5 / FPS;
  POST.begin();
  for (let k = 0; k < sub; k++) {
    const ts = sub === 1 ? tf : tf + ((k + 0.5) / sub - 0.5) * shutter;
    const jit = sub === 1 ? [0, 0] : [HALTON(k + 1, 2) - 0.5, HALTON(k + 1, 3) - 0.5];
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.save();
    const [sx, sy] = shake(ts);
    ctx.translate(sx + jit[0] * 0.7, sy + jit[1] * 0.7);
    sc.draw(ctx, ts, jit);
    ctx.restore();
    hud(ctx, ts, f, sc);
    POST.add(sceneCanvas, 1 / sub);
  }
  let ca = 0.8; for (const [ti, a] of CA_HITS) if (tf >= ti) ca += a * Math.exp(-(tf - ti) * 11);
  if (sc.draw === drawScene7d) ca += 6;
  POST.finish({ ca, bloom: sc.post.bloom, vig: sc.post.vig, grain: 0.035, seed: f + 1 });
  return true;
}

/* ---------------- arranque ---------------- */
window.READY = (async () => {
  await document.fonts.ready;
  setupScene2();
  setupGrid();
  DEPTH = layout('DEPTH', 900, 470, -12);
  W_FLUID = layout('FLUID', 900, 400, -10, DISPLAY, 'italic');
  W_BUILD = layout('BUILD', 900, 300, -8);
  W_LOOP = layout('LOOP', 900, 330, -8);
  W_CODE = layout('CODE ONLY', 900, 250, -6);
  NAME = layout('Claude', 700, 210, -7);
  SUB_TXT = 'MOTION DESIGNER — SHOWREEL 2026';
  FOOT = '240 FRAMES · 0 IMAGES · 0 SAMPLES · 100% CODE';
  CODE_LINES = [spring, cubicBezier, superPath, ball, noise3, renderFrame].flatMap(fn => fn.toString().split('\n')).map(s => s.trim()).filter(s => s.length > 6);
  { const r = rng(5); ARCS = []; for (let k = 0; k < 16; k++) { const n = 1 + Math.floor(r() * 3); for (let q = 0; q < n; q++) ARCS.push({ r: 150 + k * 56, a0: r() * TAU, len: 0.3 + r() * 2.4, w: (r() < 0.5 ? -1 : 1) * (2 + r() * 4), dir: r() < 0.5 ? -1 : 1, lw: 10 + r() * 22, col: r() < 0.18 ? C.lime : C.paper }); } }
  setupParticles();
  return true;
})();
window.renderFrame = renderFrame;
