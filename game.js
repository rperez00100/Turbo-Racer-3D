'use strict';
/* ===== TURBO RACER 3D — Fórmula 1 · game.js =====
   1 Utilidades · 2 Persistência · 3 Circuitos · 4 Construção da pista (spline, linha ideal, cenário)
   5 Física do carro · 6 IA (steering behaviors) · 7 Corrida e loop · 8 Câmera e cena 3D (Three.js) · 9 Menus */

/* ---------- 1. Utilidades ---------- */
const $ = id => document.getElementById(id), cv = $('game');
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
let seed = 7; // gerador determinístico: árvores e público ficam sempre nos mesmos lugares de cada pista
const R = (a = 1, b) => { seed = seed * 16807 % 2147483647; const r = seed / 2147483647; return b === undefined ? r * a : a + r * (b - a); };
if (typeof THREE === 'undefined') { document.body.innerHTML = '<p style="padding:2em;color:#fff;font-family:sans-serif">Não foi possível carregar o Three.js (CDN). Verifique a conexão com a internet e recarregue a página.</p>'; throw new Error('Three.js não carregado'); }
// Renderer WebGL no lugar do contexto 2D: 1 unidade 3D = 1 px da simulação; cores em sRGB, tone mapping ACES, sombras suaves
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance' }), scene = new THREE.Scene(), cam3 = new THREE.PerspectiveCamera(58, 1, 10, 5000);
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
let PR = 2;   // limite do devicePixelRatio (a qualidade adaptativa pode baixar para 1)
function resize() { renderer.setPixelRatio(Math.min(devicePixelRatio || 1, PR)); renderer.setSize(innerWidth, innerHeight, false); cam3.aspect = innerWidth / innerHeight; cam3.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

const GRID = 20, MAXLV = 8, DS = 28;          // carros no grid, nível máximo de upgrade, espaçamento das amostras da pista (px)
const WB = 30, VS = 260, GRIP_RATE = 12; const PIT_V = 200; /* limitador no pit lane (px/s ≈ 120 km/h) */ const NITRO_M = 1.6, NITRO_FUEL = 3.5; /* nitro: empuxo ×1,6 e combustível queimando 3,5× mais rápido */      // entre-eixos (px), velocidade em que o esterçamento cai à metade, rigidez lateral dos pneus
const PRIZES = [1500, 1200, 1000, 850, 720, 600, 500, 420, 350, 300, 260, 220, 190, 170, 150, 135, 120, 110, 105, 100]; // moedas por posição (1º…20º)
const cost = l => 200 * (l + 1) + 25 * l * l; // preço do próximo nível de upgrade
const TEAMS = ['#1e5bc6', '#ff8000', '#00a19b', '#6c3fb5', '#2e9e44', '#e6c200', '#2b2f3a', '#e0568c', '#7a8a99', '#14b8e8'];
const FANS = ['#e8c547', '#d9534f', '#4a90d9', '#f5f5f0', '#3aa66a', '#c56bd1'], TREE = ['#1c5a2a', '#257a36', '#144a22'];

/* ---------- 2. Persistência (save.php, com localStorage como reserva) ---------- */
const pid = localStorage.pid || (localStorage.pid = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join(''));
const DEFAULT = { coins: 0, engine: 0, tires: 0, color: '#d62828' };
const fresh = () => ({ ...DEFAULT, stats: { pick: 0, laps: {} } });   // stats: moedas coletadas na pista (total) e melhor volta de cada pista (s)
let save = fresh();
function mergeStats() {   // junta as estatísticas do save.php com as do localStorage (guardadas à parte, caso o servidor ignore campos novos): maior total de moedas, menor tempo por pista
  const a = save.stats && typeof save.stats === 'object' ? save.stats : {}; let b = {}; try { b = JSON.parse(localStorage.stats) || {}; } catch (e) { }
  const laps = {}, ok = v => typeof v === 'number' && v > 5 && v < 3600;
  for (let k = 0; k < 3; k++) { const c = [a.laps && a.laps[k], b.laps && b.laps[k]].filter(ok); if (c.length) laps[k] = Math.min(...c); }
  save.stats = { pick: Math.max(a.pick | 0, b.pick | 0, 0), laps };
}
async function loadSave() {
  try { const r = await fetch('save.php?id=' + pid); if (!r.ok) throw 0; save = await r.json(); }
  catch (e) { try { save = JSON.parse(localStorage.save) } catch (e2) { } }
  save = { ...fresh(), ...save }; mergeStats();
  save.engine = clamp(save.engine | 0, 0, MAXLV); save.tires = clamp(save.tires | 0, 0, MAXLV);
  refreshGarage(); refreshStats();
}
async function persist() {
  localStorage.save = JSON.stringify(save); localStorage.stats = JSON.stringify(save.stats);
  try { await fetch('save.php?id=' + pid, { method: 'POST', body: JSON.stringify(save) }); } catch (e) { }
}

/* ---------- 3. Circuitos ----------
   Traçados ESTILIZADOS a partir da sequência real de curvas (não são dados de GPS): pontos de controle em px,
   suavizados por spline. k = escala; w = largura do asfalto; margin = distância do asfalto até o muro; pitSide = lado dos boxes.
   O primeiro ponto é a linha de largada; a ordem dos pontos define o sentido (horário/anti-horário). */
const TRACKS = [
  { name: 'Interlagos', w: 104, margin: 90, k: 1.2, pitSide: 1, seed: 11, grass: '#2c7234', ground: '#3b8a41',
    ctrl: [[2600, 3700], [3150, 3700], [3420, 3640], [3600, 3490], [3680, 3300], [3780, 3130], [3950, 3030], [4180, 2960], [4400, 2790], [4470, 2520], [4370, 2270], [4130, 2110], [3600, 2050], [2800, 2000], [2000, 1980], [1250, 2010], [800, 2120], [560, 2310], [450, 2530], [460, 2760], [540, 2960], [700, 3120], [920, 3190], [1130, 3200], [1250, 3290], [1370, 3240], [1480, 3290], [1580, 3420], [1700, 3590], [1900, 3680], [2200, 3700]] },
  { name: 'Spa-Francorchamps', w: 104, margin: 90, k: 1.45, pitSide: -1, seed: 23, grass: '#245f31', ground: '#2f7a3d',
    ctrl: [[2500, 3900], [1900, 3880], [1550, 3860], [1380, 3790], [1310, 3700], [1330, 3620], [1450, 3570], [1650, 3560], [1950, 3550], [2150, 3520], [2330, 3420], [2500, 3380], [2650, 3280], [2900, 3050], [3500, 2600], [4200, 2150], [4650, 1930], [4850, 1890], [5000, 1960], [5150, 1950], [5350, 2000], [5550, 2100], [5680, 2300], [5750, 2520], [5680, 2720], [5500, 2830], [5250, 2870], [5020, 2960], [4900, 3150], [4920, 3350], [5000, 3480], [5080, 3580], [4990, 3690], [4800, 3780], [4500, 3850], [4200, 3880], [3900, 3900], [3780, 3990], [3630, 3990], [3500, 3900], [3000, 3900]] },
  { name: 'Monza', w: 104, margin: 90, k: 1.2, pitSide: -1, seed: 37, grass: '#3a8a3c', ground: '#4a9d4a',
    ctrl: [[800, 4300], [800, 3300], [830, 2500], [870, 2150], [990, 2020], [960, 1880], [880, 1760], [910, 1600], [990, 1330], [1230, 1100], [1600, 990], [2000, 1020], [2330, 1170], [2500, 1200], [2620, 1180], [2740, 1280], [2850, 1330], [3050, 1400], [3200, 1550], [3250, 1750], [3180, 1950], [3020, 2080], [2850, 2300], [2750, 2550], [2740, 2700], [2810, 2880], [2730, 3060], [2790, 3240], [2780, 3450], [2780, 3900], [2780, 4600], [2740, 5050], [2560, 5450], [2200, 5750], [1700, 5880], [1260, 5730], [950, 5400], [820, 4900]] }
];

/* ---------- 4. Construção da pista ---------- */
function build(T) {
  if (T.pts) return T;
  seed = T.seed;
  // 4.1 Spline Catmull-Rom fechada:  P(t) = ½[2p1 + (p2−p0)t + (2p0−5p1+4p2−p3)t² + (3p1−p0−3p2+p3)t³]
  const C = T.ctrl.map(([x, y]) => [x * T.k, y * T.k]), dense = [];
  for (let i = 0; i < C.length; i++) {
    const p0 = C[(i - 1 + C.length) % C.length], p1 = C[i], p2 = C[(i + 1) % C.length], p3 = C[(i + 2) % C.length];
    for (let s = 0; s < 32; s++) {
      const t = s / 32, t2 = t * t, t3 = t2 * t, f = q => .5 * (2 * p1[q] + (p2[q] - p0[q]) * t + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * t2 + (3 * p1[q] - p0[q] - 3 * p2[q] + p3[q]) * t3);
      dense.push({ x: f(0), y: f(1) });
    }
  }
  // 4.2 Reamostragem por comprimento de arco: pontos igualmente espaçados (a cada ~DS px) = "caminho" usado por IA, voltas e câmera
  const cum = [0];
  for (let i = 1; i <= dense.length; i++) { const a = dense[i - 1], b = dense[i % dense.length]; cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y)); }
  const tot = cum[dense.length], N = Math.round(tot / DS), pts = [];
  for (let k = 0, j = 0; k < N; k++) {
    const s = k * tot / N; while (cum[j + 1] < s) j++;
    const a = dense[j], b = dense[(j + 1) % dense.length], f = (s - cum[j]) / (cum[j + 1] - cum[j]);
    pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  const P = T.pts = pts, hw = T.hw = T.w / 2, bar = T.bar = hw + T.margin; T.ds = tot / N; T.len = tot;
  pts.forEach((p, i) => { // t = ângulo da tangente; (nx,ny) = normal apontando para a DIREITA de quem anda na pista
    const n = pts[(i + 1) % N], q = pts[(i - 1 + N) % N];
    p.t = Math.atan2(n.y - q.y, n.x - q.x); p.nx = -Math.sin(p.t); p.ny = Math.cos(p.t);
  });
  const md = i => (i % N + N) % N, at = (j, d) => { const p = P[md(j)]; return [p.x + p.nx * d, p.y + p.ny * d]; };
  const bb = q => [Math.min(...q.map(a => a[0])), Math.min(...q.map(a => a[1])), Math.max(...q.map(a => a[0])), Math.max(...q.map(a => a[1]))];
  const far = (x, y, d) => { const d2 = d * d; for (const q of P) { const dx = q.x - x, dy = q.y - y; if (dx * dx + dy * dy < d2) return false; } return true; };

  // 4.3 Linha ideal (racing line): relaxamento que minimiza a curvatura  → off_i ← off_i + 0,6·(proj_n[(q_{i−1}+q_{i+1})/2 − p_i] − off_i)
  //     q_i = p_i + n_i·off_i ; o limite |off| ≤ hw−24 mantém o carro dentro do asfalto (resultado: fora–dentro–fora nas curvas)
  const lim = hw - 24, off = T.off = new Float32Array(N);
  for (let it = 0; it < 300; it++) for (let i = 0; i < N; i++) {
    const ia = md(i - 1), ib = md(i + 1), a = P[ia], b = P[ib];
    const mx = (a.x + a.nx * off[ia] + b.x + b.nx * off[ib]) / 2, my = (a.y + a.ny * off[ia] + b.y + b.ny * off[ib]) / 2;
    off[i] = clamp(off[i] + .6 * ((mx - P[i].x) * P[i].nx + (my - P[i].y) * P[i].ny - off[i]), -lim, lim);
  }
  // Curvatura da linha:  κ = |Δθ| / ds  (ângulo entre segmentos vizinhos / comprimento médio), suavizada 3×
  const lx = i => P[i].x + P[i].nx * off[i], ly = i => P[i].y + P[i].ny * off[i];
  let kap = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = md(i - 1), b = md(i + 1);
    kap[i] = Math.abs(wrap(Math.atan2(ly(b) - ly(i), lx(b) - lx(i)) - Math.atan2(ly(i) - ly(a), lx(i) - lx(a)))) / ((Math.hypot(lx(i) - lx(a), ly(i) - ly(a)) + Math.hypot(lx(b) - lx(i), ly(b) - ly(i))) / 2);
  }
  for (let r = 0; r < 3; r++) kap = kap.map((_, i) => (kap[md(i - 1)] + 2 * kap[i] + kap[md(i + 1)]) / 4);
  T.kap = kap; T.kAh = kap.map((_, i) => { let m = 0; for (let k = 0; k < 12; k++) m = Math.max(m, kap[md(i + k)]); return m; });

  // 4.4 Curvas da pista central → zebras (kerbs) e áreas de escape de asfalto (só visuais)
  const ang = pts.map((_, i) => wrap(pts[md(i + 2)].t - pts[md(i - 2)].t));
  const sm = ang.map((_, i) => (ang[md(i - 1)] + 2 * ang[i] + ang[md(i + 1)]) / 4);
  const runs = (thr, min) => { const out = []; let a = 0, s = 0;
    for (let i = 0; i <= N; i++) { const sg = i < N && Math.abs(sm[i]) > thr ? Math.sign(sm[i]) : 0;
      if (sg !== s) { if (s && i - a >= min) out.push({ a: a - 1, b: i, s }); a = i; s = sg; } }
    return out; };
  const strip = (r, d, ext = 0) => { const p = []; for (let j = r.a - ext; j <= r.b + ext; j++) p.push(at(j, d)); return { p, bb: bb(p) }; };
  T.kerbs = runs(.09, 3).map(r => strip(r, r.s * (hw + 2)));                 // zebra no lado de dentro da curva
  T.runoffs = runs(.2, 4).map(r => strip(r, -r.s * (hw + 8 + 28), 3));       // asfalto de escape no lado de fora

  // 4.5 Pit lane + boxes na reta principal. Visual (fora do asfalto) + pontos usados pelo pit stop:
  //     T.lane = deslocamento lateral do centro da faixa · T.park = vaga dentro do box · T.boxS/T.boxPos = posição de cada um dos 20 boxes
  const ps = T.pitSide, pa = T.pa = -22, pb = T.pb = 34, lane = [], wall = [], boxes = [];
  T.lane = ps * (hw + 28); T.park = ps * (hw + 64); T.boxS = []; T.boxPos = [];
  for (let j = pa; j <= pb; j++) { lane.push(at(j, T.lane)); wall.push(at(j, ps * (hw + 7))); }
  for (let k = 0; k < GRID; k++) {
    const j = pa + Math.round(k * (pb - pa - 2) / (GRID - 1)), jc = j + 1, b = at(jc, T.park);
    boxes.push({ q: [at(j, ps * (hw + 50)), at(j + 2, ps * (hw + 50)), at(j + 2, ps * (hw + 80)), at(j, ps * (hw + 80))], door: [at(j, ps * (hw + 50)), at(j + 2, ps * (hw + 50)), at(j + 2, ps * (hw + 57)), at(j, ps * (hw + 57))], col: TEAMS[k % TEAMS.length] });
    T.boxS.push(md(jc) * T.ds); T.boxPos.push({ x: b[0], y: b[1], a: P[md(jc)].t });
  }
  const en = at(pa - 6, ps * (hw + 16)); T.entry = { x: en[0], y: en[1], a: P[md(pa - 6)].t };   // seta piscante de entrada do pit
  T.pit = { lane, wall, boxes, bb: bb(lane.concat(...boxes.map(b => b.q))) };

  // 4.6 Arquibancadas com público (fora do muro). Só entram se estiverem longe de QUALQUER outro trecho da pista
  const stands = T.stands = [];
  const addStand = (a, b, s, d0) => {
    const D = 44;
    for (let j = a; j <= b; j += 2) for (const d of [d0, d0 + D]) { const [x, y] = at(j, s * d); if (!far(x, y, bar + 8)) return; }
    const quad = [at(a, s * d0), at(b, s * d0), at(b, s * (d0 + D)), at(a, s * (d0 + D))], fans = [];
    for (let j = a; j < b; j++) { const p = P[md(j)]; for (let u = 0; u < 4; u++) for (let r = 0; r < 6; r++) { const d = d0 + 5 + r * 6.6;
      fans.push({ x: p.x + p.nx * s * d + Math.cos(p.t) * u * 7, y: p.y + p.ny * s * d + Math.sin(p.t) * u * 7, c: R(6) | 0, ph: (j * 4 + u) * .45 + r * .15 }); } }
    stands.push({ quad, fans, bb: bb(quad) });
  };
  addStand(-12, 16, -ps, bar + 14);                                              // reta principal, lado oposto aos boxes
  const used = [], cand = sm.map((v, i) => [Math.abs(v), i]).sort((a, b) => b[0] - a[0]);
  for (const [v, i] of cand) { if (v < .12 || used.length >= 7) break;           // nas curvas mais fortes, no lado de fora
    if (used.some(u => Math.min(Math.abs(u - i), N - Math.abs(u - i)) < 30)) continue;
    used.push(i); addStand(i - 6, i + 6, -Math.sign(sm[i]), bar + 14); }

  // 4.7 Árvores (fora do muro, longe de qualquer trecho da pista e das arquibancadas) — sem colisão
  T.trees = [];
  for (let i = 0; i < N; i += 2) for (const s of [-1, 1]) {
    if (R() < .25) continue;
    const d = bar + R(26, 230), r = R(14, 27), p = P[i], x = p.x + p.nx * s * d + R(-20, 20), y = p.y + p.ny * s * d + R(-20, 20);
    if (far(x, y, bar + r + 6) && !stands.some(st => x > st.bb[0] - 30 && x < st.bb[2] + 30 && y > st.bb[1] - 30 && y < st.bb[3] + 30)) T.trees.push({ x, y, r, c: R(3) | 0 });
  }

  // 4.8 Grid de largada e texturas
  T.slots = [];                               // duas colunas em zigue-zague, a 62 px entre fileiras; k=0 é a pole
  for (let k = 0; k < GRID; k++) {
    const back = 40 + (k >> 1) * 62 + (k & 1) * 30, f = N - back / T.ds, i0 = Math.floor(f), t = f - i0, p = P[md(i0)], q = P[md(i0 + 1)], lat = (k & 1 ? 1 : -1) * 22;
    T.slots.push({ x: p.x + (q.x - p.x) * t + p.nx * lat, y: p.y + (q.y - p.y) * t + p.ny * lat, a: p.t, i: md(Math.round(f)) });
  }
  const pat = (base, c1, c2) => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 700; i++) { g.fillStyle = R() < .5 ? c1 : c2; g.fillRect(R(256), R(256), R(2, 5), R(2, 5)); }
    for (let y = 0; y < 256; y += 64) { g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(0, y, 256, 32); }   // faixas de corte da grama
    return c; };   // (edição permitida) devolve o canvas offscreen; o 3D o transforma em textura
  T.grassPat = pat(T.grass, 'rgba(0,0,0,.14)', 'rgba(255,255,255,.07)'); T.groundPat = pat(T.ground, 'rgba(0,0,0,.1)', 'rgba(255,255,255,.08)');
  T.asphalt = '#3a3d43';

  // 4.9 Minimapa pré-desenhado (180×180)
  const mini = T.mini = document.createElement('canvas'); mini.width = mini.height = 180;
  const m = mini.getContext('2d'), x0 = Math.min(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y)), x1 = Math.max(...pts.map(p => p.x)), y1 = Math.max(...pts.map(p => p.y));
  T.ms = Math.min(156 / (x1 - x0), 156 / (y1 - y0)); T.mx = (180 - (x1 - x0) * T.ms) / 2 - x0 * T.ms; T.my = (180 - (y1 - y0) * T.ms) / 2 - y0 * T.ms;
  const mpath = () => { m.beginPath(); pts.forEach((p, i) => { const X = p.x * T.ms + T.mx, Y = p.y * T.ms + T.my; i ? m.lineTo(X, Y) : m.moveTo(X, Y); }); m.closePath(); };
  m.lineJoin = m.lineCap = 'round'; mpath(); m.lineWidth = 9; m.strokeStyle = '#000'; m.stroke(); mpath(); m.lineWidth = 5; m.strokeStyle = '#d9dce2'; m.stroke();
  m.save(); m.translate(pts[0].x * T.ms + T.mx, pts[0].y * T.ms + T.my); m.rotate(pts[0].t); m.fillStyle = '#d62828'; m.fillRect(-2, -8, 4, 16); m.restore();
  m.beginPath(); lane.forEach((q, i) => { const X = q[0] * T.ms + T.mx, Y = q[1] * T.ms + T.my; i ? m.lineTo(X, Y) : m.moveTo(X, Y); });
  m.lineWidth = 3; m.strokeStyle = '#ffc300'; m.stroke();                      // pit lane no minimapa
  return T;
}

/* ---------- 5. Física do carro ---------- */
// Estado: posição (x,y), ângulo a, velocidade (vx,vy). A velocidade é decomposta no referencial do carro
// (vf = frente, vl = lateral); o ângulo é atualizado DEPOIS de recompor (vx,vy) — por isso o carro gira e a velocidade "demora" a acompanhar (drift).
function stepCar(c, dt, thr, str, hb, nit) {
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  let vf = c.vx * fx + c.vy * fy, vl = -c.vx * fy + c.vy * fx;
  const sp = Math.abs(vf);
  if (c.fuel <= 0 && thr > .15) thr = .15;
  c.nitro = !!(nit && thr > 0 && c.fuel > .05 && !c.pit);   // nitro só com acelerador, com reserva de combustível e fora do pit      // sem combustível: só 15% de potência ⇒ velocidade terminal = vmax·√0,15 ≈ 39%
  // (1) Longitudinal:  a = F_motor − F_arrasto − F_rolagem
  //     F_motor = acc·thr (ou brake·thr ao frear, thr<0) · arrasto = cd·v·|v| com cd = acc/vmax²  ⇒ velocidade terminal = vmax com acelerador total
  //     fora do asfalto a resistência de rolagem sobe (grama/brita)
  //     NITRO: F_motor = acc·thr·1,6  ⇒  velocidade terminal = vmax·√1,6 ≈ 1,26·vmax (e aceleração 60% maior), mas o combustível sai 3,5× mais rápido
  let a = thr > 0 ? c.acc * thr * (c.nitro ? NITRO_M : 1) : thr < 0 ? (vf > 5 ? c.brake * thr : c.acc * .5 * thr) : 0;
  //     esteira de ar (slipstream) logo atrás de outro carro, ou DRS do bot em ultrapassagem na reta: cd ×0,8 (velocidade terminal ≈ +12%)
  a -= c.acc / (c.max * c.max) * (c.draft ? .8 : 1) * vf * sp + vf * (c.off ? 1.4 : .04);
  vf = Math.max(vf + a * dt, -c.max * .25);
  // (2) Limite de aderência:  A_max = A0·(1 + 0,6·(v/vmax)²)  [downforce]  · 0,6 fora da pista  · √(1 − 0,5·u²)  [círculo de atrito, u = fração usada em frenagem/aceleração]
  const u = Math.min(1, Math.abs(a) / c.brake);
  const Amax = c.A * (1 + .6 * (sp / c.max) ** 2) * (c.off ? .6 : 1) * (hb ? .35 : 1) * Math.sqrt(1 - .5 * u * u) * (1 - .38 * (1 - c.tire));
  //     desgaste dos pneus: A_efetivo = A·(1 − 0,38·desgaste), desgaste = 1 − c.tire (0 = novos, 1 = carecas) ⇒ perde até 38% da aderência
  // (3) Força lateral dos pneus ∝ velocidade lateral, saturada em A_max (acima disso o carro escorrega = sub/sobreesterço)
  vl -= clamp(vl * Math.min(1, GRIP_RATE * dt), -Amax * dt, Amax * dt);
  // (4) Esterçamento (modelo bicicleta):  δ = δmax·str/(1+(v/VS)²)  ·  ω = v·tan(δ)/L  ·  perde eficácia quando o carro já está deslizando
  const delta = c.dmax * str / (1 + (vf / VS) ** 2);
  const w = vf * Math.tan(delta) / WB / (1 + (vl / 160) ** 2);
  // (5) Consumo e desgaste (parados no box não gastam):
  //     combustível:  Δf = v·(0,5 + 0,5·acelerador)·dt / alcance_do_tanque          (alcance do tanque = 2,2 a 3 voltas, conforme o tamanho da corrida)
  //     pneus:        Δt = v·(0,35 + 1,1·min(1, a_lat/A) + 0,5·freio)·dt / vida_do_pneu  (curva forte e frenagem gastam mais)
  if (!c.pit || c.pit.ph !== 'stop') {
    c.fuel = Math.max(0, c.fuel - sp * (.5 + .5 * Math.max(thr, 0)) * (c.nitro ? NITRO_FUEL : 1) * dt / c.fuelRange);   // nitro: ×3,5 no consumo
    c.tire = Math.max(0, c.tire - sp * (.35 + 1.1 * Math.min(1, Math.abs(vf * w) / c.A) + .5 * Math.min(1, Math.max(-thr, 0))) * (hb && sp > 40 ? 9 : 1) * dt / c.tireRange);   // freio de mão: multiplicador 9 ⇒ na prática ≈ 4× mais desgaste em curva (o carro desliza e perde carga lateral)
  }
  c.vx = fx * vf - fy * vl; c.vy = fy * vf + fx * vl;
  c.a += w * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.speed = Math.hypot(c.vx, c.vy);
}

// Amostra da linha central mais próxima (janela em torno do último índice; busca total só se o carro "sumiu")
function nearest(c) {
  const P = track.pts, N = P.length; let best = 1e18, bi = c.i;
  const test = i => { i = (i + N) % N; const d = (P[i].x - c.x) ** 2 + (P[i].y - c.y) ** 2; if (d < best) { best = d; bi = i; } };
  for (let k = -6; k <= 18; k++) test(c.i + k);
  if (best > (track.bar * 1.2) ** 2) { best = 1e18; for (let i = 0; i < N; i++) test(i); }
  c.d = Math.sqrt(best); return bi;
}
const wrapS = d => ((d % track.len) + track.len * 1.5) % track.len - track.len / 2;   // diferença de posição ao longo da pista, em (−L/2, L/2]

// Coordenadas da pista (s = ao longo, l = lateral, + = direita), voltas, "fora da pista" e muro
function collideWorld(c) {
  const T = track, P = T.pts, N = P.length, ni = nearest(c), p = P[ni];
  c.cross = false;
  if (c.i > N * .8 && ni < N * .2) { c.lap++; c.cross = true; } else if (c.i < N * .2 && ni > N * .8) c.lap--;
  c.i = ni;
  const dx = c.x - p.x, dy = c.y - p.y;
  c.l = dx * p.nx + dy * p.ny; c.s = ni * T.ds + dx * Math.cos(p.t) + dy * Math.sin(p.t);
  c.off = !c.pit && c.d > T.hw + 6;                      // zebra conta como pista; além disso (grama ou asfalto de escape) = fora
  if (c.d > T.bar) {                           // muro: reposiciona no limite e remove a velocidade contra ele
    const nx = dx / c.d, ny = dy / c.d;
    c.x = p.x + nx * T.bar; c.y = p.y + ny * T.bar; c.d = T.bar;
    const vn = c.vx * nx + c.vy * ny; if (vn > 0) { c.vx -= 1.6 * vn * nx; c.vy -= 1.6 * vn * ny; }
    c.vx *= .85; c.vy *= .85;
  }
}

// Colisão carro×carro: cada carro = 2 círculos (frente e traseira, raio 12). Separa e troca impulso: j = −0,55·(v_rel·n)
function carCollisions() {
  for (const c of cars) { c.cs = Math.cos(c.a); c.sn = Math.sin(c.a); }
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 > 3600) continue;
    for (const ka of [-12, 12]) for (const kb of [-12, 12]) {
      const dx = b.x + b.cs * kb - a.x - a.cs * ka, dy = b.y + b.sn * kb - a.y - a.sn * ka, d = Math.hypot(dx, dy);
      if (d < 24 && d > .01) {
        const nx = dx / d, ny = dy / d, o = (24 - d) / 2;
        a.x -= nx * o; a.y -= ny * o; b.x += nx * o; b.y += ny * o;
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) { const q = -rv * .55; a.vx -= q * nx; a.vy -= q * ny; b.vx += q * nx; b.vy += q * ny; }
      }
    }
  }
}

/* ---------- 6. IA (steering behaviors) ---------- */
// Perfil de velocidade ao longo da linha ideal, por carro:
//   v_curva = √(A·(1+0,6(v0/vmax)²) / κ)      [aceleração lateral máxima ÷ curvatura, com downforce]
//   frenagem (passada para trás):  v_i = min(v_i, √(v_{i+1}² + 2·a_freio·Δs))   — assim o bot começa a frear ANTES da curva
function buildProfile(c) {
  const T = track, N = T.pts.length, pr = new Float32Array(N), A = c.A * (c.safe || .95), bk = c.brake * (c.bkf || .8);
  for (let i = 0; i < N; i++) {
    const r = 1 / Math.max(T.kap[i], 1e-5), v0 = Math.sqrt(A * r);
    pr[i] = Math.min(c.max * .995, Math.sqrt(A * (1 + .6 * (v0 / c.max) ** 2) * r));
    // limite de esterçamento: precisa de δ = atan(L·κ) e o carro só dispõe de δmax/(1+(v/VS)²)  ⇒  v ≤ VS·√(δmax/(1,1·δ) − 1)
    pr[i] = Math.min(pr[i], Math.max(70, VS * Math.sqrt(Math.max(0, c.dmax / (1.1 * Math.atan(WB * T.kap[i]) + 1e-9) - 1))));
  }
  for (let pass = 0; pass < 2; pass++) for (let i = N - 1; i >= 0; i--) { const j = (i + 1) % N, l = Math.sqrt(pr[j] * pr[j] + 2 * bk * T.ds); if (pr[i] > l) pr[i] = l; }
  c.prof = pr;
}

// Curvatura ASSINADA da linha ideal (+ = curva para a direita) e "a curva mais forte nos próximos 26 amostras" — usado para escolher o lado de dentro ao ultrapassar/defender
function aiTrack(T) {
  if (T.turn) return;
  const P = T.pts, N = P.length, off = T.off, md = i => (i % N + N) % N, lx = i => P[i].x + P[i].nx * off[i], ly = i => P[i].y + P[i].ny * off[i];
  let ks = new Float32Array(N);
  for (let i = 0; i < N; i++) { const a = md(i - 1), b = md(i + 1); ks[i] = wrap(Math.atan2(ly(b) - ly(i), lx(b) - lx(i)) - Math.atan2(ly(i) - ly(a), lx(i) - lx(a))) / T.ds; }
  for (let r = 0; r < 3; r++) ks = ks.map((_, i) => (ks[md(i - 1)] + 2 * ks[i] + ks[md(i + 1)]) / 4);
  T.turn = ks.map((_, i) => { let b = 0; for (let k = 0; k < 26; k++) { const v = ks[md(i + k)]; if (Math.abs(v) > Math.abs(b)) b = v; } return b; });
}

function aiDrive(c, dt) {
  const T = track, P = T.pts, N = P.length, lim = T.hw - 20, i = c.i, vf = c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a); aiTrack(T);
  const straight = T.kAh[i] < 1 / 450, turn = T.turn[i], corner = Math.abs(turn) > 1 / 380 ? Math.sign(turn) : 0;   // corner: lado de dentro da próxima curva forte (+1 direita, −1 esquerda, 0 = reta)
  if (run.t < c.react) return [0, 0, false];                    // reação à largada: cada piloto sai num instante diferente (os melhores reagem mais rápido)
  if (c.nitLap !== c.lap) { c.nitLap = c.lap; c.nitL = 0; c.lapPace = 1 + rnd(-1, 1) * (.004 + .016 * (1 - c.cons)); }   // a cada volta: orçamento de nitro zerado e ritmo da volta sorteado (consistência)
  if (c.nitro) c.nitL += dt;
  // --- Sensores (coordenadas da pista): bloqueador à frente na mesma faixa, perseguidor logo atrás e carros "colados" dos lados
  let blk = null, bd = 1e9, fol = null, fd = 1e9, left = false, right = false;
  for (const o of cars) {
    if (o === c || (o.pit && o.pit.ph === 'stop')) continue;      // carro parado no box não bloqueia a pista
    const ds = wrapS(o.s - c.s), dl = o.l - c.l;
    if (ds > 0 && ds < 210 && Math.abs(dl) < 46 && ds < bd) { bd = ds; blk = o; }
    if (ds < -26 && ds > -130 && Math.abs(dl) < 42 && -ds < fd && !o.pit) { fd = -ds; fol = o; }
    if (Math.abs(ds) < 58) { if (dl > 0 && dl < 64) right = true; else if (dl < 0 && dl > -64) left = true; }
  }
  // --- Fila no pit: quem quer parar mas vê carros lentos ainda entrando/parando no pit lane logo à frente NÃO começa a manobra de entrada (segue na pista e tenta na volta seguinte);
  //     só avalia ANTES da rampa de entrada começar (28 amostras antes do pit); depois disso o piloto se compromete
  const hold = c.wantPit && relIdx(i) < T.pa - 28 && cars.some(o => o !== c && ((o.pit && o.pit.ph !== 'out' && wrapS(o.s - c.s) > -20 && wrapS(o.s - c.s) < 420) || (o.wantPit && wrapS(o.s - c.s) > 0 && wrapS(o.s - c.s) < 260 && o.speed < 170)));
  c.blkT = blk && !c.ov && bd < 90 ? c.blkT + dt : Math.max(0, c.blkT - 2 * dt);   // tempo preso atrás de alguém (alimenta a decisão de "undercut" no pit)
  // --- Ultrapassagem (máquina de estados): sou mais rápido que o bloqueador (com esteira de ar conta +7% na reta) e há espaço → desvio lateral até estar 55 px à frente.
  //     Lado: o de DENTRO da próxima curva, se couber; senão o oposto ao do bloqueador. Emergência (bloqueador quase parado, ex.: rodado): desvia mesmo em curva.
  c.cool -= dt; c.defCool -= dt; c.defT -= dt; c.errT -= dt;
  if (c.ov) { c.ovT -= dt; if (wrapS(c.ovCar.s - c.s) < -55 || c.ovT <= 0) { c.ov = 0; c.cool = 1.5; } }
  else if (blk && !c.wantPit && c.cool <= 0 && run.t > 6) {
    const emerg = blk.speed < 70 && bd < 140 && c.speed > blk.speed + 40;
    if (emerg || (straight && c.prof[i] * (c.draft ? 1.07 : 1) > blk.speed + 10 && bd < (c.draft ? 140 : 100) + 90 * c.aggr)) {
      let side = blk.l > c.l + 6 ? -1 : blk.l < c.l - 6 ? 1 : (blk.l < 0 ? 1 : -1);
      if (corner && Math.abs(blk.l + corner * 52) <= lim) side = corner;
      if ((side > 0 && right) || (side < 0 && left)) side = -side;
      if (!((side > 0 && right) || (side < 0 && left))) { c.ov = side; c.ovCar = blk; c.ovT = emerg ? 4 : 8; c.defT = 0; }
    }
  }
  // --- Defesa (uma manobra por ataque, como no regulamento): perseguidor mais rápido colado atrás na reta → cobre a linha dele (ou fecha a parte de dentro da curva que vem aí)
  if (!c.ov && fol && c.defCool <= 0 && !c.wantPit && run.t > 6 && fd < 120 && fol.speed > c.speed - 8) {
    c.defCool = 5;                                              // tenta de novo só daqui a 5 s, defendendo ou não
    if (rnd() < c.defend) { c.defT = 2.2; c.defL = corner ? corner * lim * .8 : clamp(fol.l, -lim, lim); }
  }
  // --- Separação: o desvio desejado é limitado para nunca entrar em cima de quem está ao lado; taxa lateral limitada (120 px/s ultrapassando, 70 px/s defendendo/voltando)
  let want = c.ov ? clamp(c.ovCar.l + c.ov * 52, -lim, lim) - T.off[i] : c.defT > 0 ? clamp(c.defL, -lim, lim) - T.off[i] : 0;
  if ((want > c.shift && right) || (want < c.shift && left)) want = c.shift;
  const rate = c.ov ? 120 : 70; c.shift += clamp(want - c.shift, -rate * dt, rate * dt);
  // --- Seguir a linha (pure pursuit): ponto-alvo a Ld = 45 + 0,5·v px à frente na linha ideal (+ desvio + preferência pessoal de faixa nas retas);
  //     ângulo de esterço  δ = atan(2·L·sin α / Ld)  (α = ângulo entre o carro e o alvo), normalizado pelo limite de esterço atual
  const Ld = clamp(45 + .5 * Math.abs(vf), 60, 280), j = (i + Math.max(2, Math.round(Ld / T.ds))) % N, q = P[j];
  let lat = clamp(T.off[j] + c.shift + c.lp * clamp(1 - T.kAh[j] * 450, 0, 1) - (c.errT > 0 ? Math.sign(T.turn[j]) * 26 : 0), -lim, lim);   // durante um erro, abre ~26 px para o lado de fora da curva
  if (c.wantPit && !hold) {                                     // indo para o pit: rampa suave da linha ideal até o centro do pit lane (16 amostras antes da entrada)
    const rj = relIdx(j);
    if (rj >= T.pa - 16 && rj <= T.pa + 12) { const u = clamp((rj - (T.pa - 16)) / 16, 0, 1), sm = u * u * (3 - 2 * u); lat = T.off[j] * (1 - sm) + T.lane * sm; }
  }
  const tx = q.x + q.nx * lat, ty = q.y + q.ny * lat;
  const alpha = wrap(Math.atan2(ty - c.y, tx - c.x) - c.a);
  const str = clamp(Math.atan(2 * WB * Math.sin(alpha) / Ld) / (c.dmax / (1 + (vf / VS) ** 2)), -1, 1);
  // --- Erros de pilotagem: ao entrar numa zona de frenagem, sorteia um "travou a roda / frenou tarde": entra 9–22% rápido demais e abre na curva.
  //     Chance cresce com pneus gastos e com pressão (colado em alguém) e cai com a consistência do piloto.
  const braking = vf > 120 && c.prof[(i + 4) % N] < vf * .88;
  if (braking && !c.inBz) { c.inBz = true; if (c.errT <= 0 && rnd() < (1 - c.cons) * .2 * (1 + 1.2 * (1 - c.tire) + (blk && bd < 50 ? .6 : 0) + (fol && fd < 60 ? .5 : 0))) { c.errT = rnd(.9, 1.6); c.errK = rnd(1.09, 1.22); } } else if (!braking) c.inBz = false;
  // --- Velocidade: alvo do perfil × ritmo da volta; atrás de um carro, v_alvo = v_líder + 2,5·(gap − gap_desejado)  (gap desejado cresce com a velocidade)
  let vt = c.prof[(i + 2) % N] * c.lapPace;
  if (vt < c.max * .99) vt *= Math.sqrt(1 - .38 * (1 - c.tire));   // pneus gastos: curvas mais lentas (v ∝ √A)
  if (c.errT > 0) vt *= c.errK;
  if (c.off && !c.wantPit) vt = Math.min(vt, 150 + 40 * c.sk);    // fora da pista: volta devagar para a linha (a aproximação do pit não conta: a faixa do pit está "fora" até o carro ser capturado)
  if (c.wantPit && !hold) { const rr = relIdx(i); if (rr >= T.pa - 16 && rr <= T.pa + 2) vt = Math.min(vt, Math.max(PIT_V, PIT_V + 25 * (T.pa - rr))); }   // freia até o limitador antes de entrar
  if (blk && (!c.ov || Math.abs(blk.l - c.l) < 30)) vt = Math.min(vt, blk.speed + clamp((bd - (run.t < 5 ? 38 : 56 + .12 * Math.abs(vf))) * 2.5, -90, 150));
  if (c.draft && straight) vt *= 1.07;                          // na esteira/DRS em reta, o bot aceita passar do perfil
  const thr = clamp((vt - vf) * .05, -1, 1);                    // controlador proporcional de velocidade
  // --- Anti-travamento: se ficar parado, recoloca na linha
  c.stuck = c.speed < 20 && run.t > 3 ? c.stuck + dt : 0;
  if (c.stuck > 2) { const p = P[i]; c.x = p.x; c.y = p.y; c.a = p.t; c.vx = c.vy = 0; c.stuck = 0; c.shift = 0; c.ov = 0; c.defT = 0; }
  // --- Nitro tático (3º valor), só em reta, com combustível de sobra (nitroOK) e no máximo 2,6 s por volta: nos 2 s iniciais de uma ultrapassagem,
  //     para defender uma posição de perseguidor muito próximo, ou colado atrás de um rival no ritmo (pilotos agressivos)
  let nit = false;
  if (T.kAh[i] < 1 / 600 && c.nitL < 2.6 && nitroOK(c)) nit = (c.ov && c.ovT > 5.5) || (c.defT > 0 && fol && fd < 90 && c.aggr > .5) || (!c.ov && blk && bd < 70 && c.prof[i] > blk.speed - 5 && c.aggr > .6);
  return [thr, str, nit];
}

/* ---------- 6b. Pit stop ----------
   Fluxo: o carro entra no pit lane (jogador dirigindo; bots por conta própria quando combustível/pneus pedem) →
   piloto automático leva ao box (limitador PIT_V) → PARADO 3 s (combustível e pneus voltam a 100%) → sai e se reintegra à pista.
   Parada obrigatória: ninguém conclui a corrida sem ter parado ao menos uma vez. */
// Bot só usa nitro se o combustível restante cobre: 1,6 volta de tanque (para chegar ao pit) e, depois da parada, o que falta para terminar + folga
const nitroOK = c => c.fuel > 1.6 / c.cap && (c.stops === 0 || c.fuel > (cfg.laps - (c.lap + c.s / track.len)) / c.cap + .08);
const relIdx = i => i > track.pts.length / 2 ? i - track.pts.length : i;             // índice relativo à linha de largada (negativo = antes dela)
const needPit = c => c.fuel < .85 || c.tire < .85 || (c.stops === 0 && c.lap >= cfg.laps - 1);   // vale a pena parar (o jogador é "capturado" ao entrar no pit lane)
const pitAlert = c => c.fuel < .4 || c.tire < .4 || (c.stops === 0 && c.lap >= cfg.laps - 1);   // urgente: pisca o pit e mostra o aviso

function chooseBox(c) {                       // box próprio se estiver à frente e livre; senão, o próximo livre à frente; senão para onde está
  const T = track, busy = k => cars.some(o => o !== c && o.pit && o.pit.box === k), ahead = k => wrapS(T.boxS[k] - c.s);
  if (ahead(c.slot) > 25 && !busy(c.slot)) return c.slot;
  let best = -1, bd = 1e9;
  for (let k = 0; k < GRID; k++) { const d = ahead(k); if (d > 25 && d < bd && !busy(k)) { bd = d; best = k; } }
  return best;
}

function pitDrive(c, dt) {                    // controle automático dentro do pit (vale para bots e para o jogador)
  const T = track, P = T.pts, N = P.length, pit = c.pit, i = c.i, vf = c.vx * Math.cos(c.a) + c.vy * Math.sin(c.a);
  const sm = u => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
  pit.age += dt;
  if (pit.ph === 'stop') {                    // PARADO: contagem regressiva de 3 s; abastece e troca pneus de forma gradual
    pit.t -= dt; const pr = 1 - clamp(pit.t / 3, 0, 1);
    c.fuel = pit.f0 + (1 - pit.f0) * pr; c.tire = pit.w0 + (1 - pit.w0) * pr;
    if (pit.t <= 0) { c.fuel = c.tire = 1; c.stops++; pit.ph = 'out'; pit.s0 = c.s; }
    return [0, 0];
  }
  const Ld = clamp(35 + .4 * Math.abs(vf), 45, 140), j = (i + Math.max(2, Math.round(Ld / T.ds))) % N, q = P[j], rj = relIdx(j);
  let lat = T.lane, vt = PIT_V;
  if (pit.ph === 'in') {                      // velocidade para parar em cima do box:  v ≤ √(2·a·distância), a = 450 px/s²
    const dist = pit.box >= 0 ? wrapS(T.boxS[pit.box] - c.s) : 0;
    vt = Math.min(PIT_V, Math.sqrt(2 * 450 * Math.max(dist - 2, 0)));
    if (pit.box >= 0) lat = T.lane + (T.park - T.lane) * sm(1 - dist / 150);   // entra de lado na vaga nos últimos 150 px
    if (dist < 3 && Math.abs(vf) < 12) { pit.ph = 'stop'; pit.t = 3; pit.f0 = c.fuel; pit.w0 = c.tire; }
  } else {                                    // saída: volta ao centro da faixa e, no fim do pit lane, se reintegra à linha ideal
    lat = T.park + (T.lane - T.park) * sm(wrapS(c.s - pit.s0) / 90);
    if (rj > T.pb) lat = T.lane + (T.off[j] - T.lane) * sm((rj - T.pb) / 8);
    vt = PIT_V + Math.max(0, rj - T.pb - 2) * 40;
    if (relIdx(i) >= T.pb + 6 || pit.age > 60) { c.pit = null; c.shift = 0; c.ov = 0; c.cool = 2; }
  }
  let blk = null, bd = 1e9;                   // não bate em quem está na mesma faixa do pit
  for (const o of cars) { if (o === c) continue; const ds = wrapS(o.s - c.s); if (ds > 0 && ds < 110 && Math.abs(o.l - c.l) < 26 && ds < bd) { bd = ds; blk = o; } }
  if (blk) vt = Math.min(vt, blk.speed + clamp((bd - 58) * 2, -80, 100));
  const alpha = wrap(Math.atan2(q.y + q.ny * lat - c.y, q.x + q.nx * lat - c.x) - c.a);
  const str = clamp(Math.atan(2 * WB * Math.sin(alpha) / Ld) / (c.dmax / (1 + (vf / VS) ** 2)), -1, 1);
  return [clamp((vt - vf) * .06, -1, 1), str];
}

/* ---------- 7. Corrida e loop ---------- */
let track, cars = [], player, coinsList = [], run = { t: 0, coins: 0, order: [] }, state = 'menu', cdown = 0, cdTotal = 5, goT = 0, lastTrack = 0;
const cam = { x: 0, y: 0, z: 1, px: 0, py: 0, a: 0 };
const keys = {}, held = (...c) => c.some(x => keys[x]);
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Escape' && (state === 'race' || state === 'count')) quit();
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => keys[e.code] = false);
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
const DIFF = { easy: { spd: .98, corner: .85, aggr: .5, cons: -.12, def: .35 }, normal: { spd: 1, corner: .93, aggr: .75, cons: 0, def: .7 }, hard: { spd: 1.06, corner: 1, aggr: 1, cons: .06, def: 1 } };   // cons: consistência (menos erros) · def: disposição a defender posição
const cfg = { diff: 'normal', laps: 3 };

function startRace(ti) {
  track = build(TRACKS[ti]); lastTrack = ti;
  const T = track, N = T.pts.length, D = DIFF[cfg.diff]; cars = [];
  // habilidade sorteada (0..1) por piloto; o grid é o "treino classificatório": habilidade + sorte (±0,3), então há muita ultrapassagem
  const sk = Array.from({ length: GRID - 1 }, () => rnd()), qual = sk.map((v, i) => [v + rnd(-.3, .3), i]).sort((a, b) => b[0] - a[0]), skillAt = qual.map(q => sk[q[1]]);
  for (let k = 0; k < GRID; k++) {
    const pl = k === GRID - 1, s = pl ? 0 : skillAt[k], sl = T.slots[k]; // s = habilidade do piloto desta vaga do grid (jogador sempre largando em último)
    const c = { pl, num: k + 1, x: sl.x, y: sl.y, a: sl.a, vx: 0, vy: 0, i: sl.i, lap: -1, s: 0, l: 0, d: 0, off: false, fin: false, finT: 0, stuck: 0, speed: 0,
      shift: 0, ov: 0, ovT: 0, ovCar: null, cool: 0, col: pl ? save.color : TEAMS[k % TEAMS.length], cs: 1, sn: 0,
      fuel: 1, tire: 1, stops: 0, slot: k, pit: null, wantPit: false, pitJ: rnd(0, .5), pitT: rnd(.3, .45), defT: 0, defCool: rnd(0, 3), defL: 0, errT: 0, errK: 1, inBz: false, blkT: 0, lapPace: 1, nitL: 0, nitLap: -1, cons: .6, defend: .5, lp: 0, react: 0, sk: .5, bkf: .8, cap: clamp(cfg.laps * .7, 2.2, 3) / .93, cross: false, owe: false,   // pit stop: tanque/pneus 0..1
      fuelRange: T.len * clamp(cfg.laps * .7, 2.2, 3), tireRange: T.len * cfg.laps * .8 * (pl ? 1 + .06 * save.tires : 1) };   // alcance do tanque; vida dos pneus (upgrade de pneus dura mais)
    if (pl) Object.assign(c, { max: 330 * (1 + .06 * save.engine), acc: 300 * (1 + .05 * save.engine), A: 360 * (1 + .06 * save.tires), dmax: .7 * (1 + .03 * save.tires), brake: 560 });
    else { // bots SEMPRE mais fortes que o carro sem upgrades: vmax ≥ 335 (jogador 330), acc ≥ 313 (300), aderência ≥ 371 (360), esterço .78 (.70), freio 600 (560)
      const f = .95 + .1 * s;
      Object.assign(c, { max: 360 * f * D.spd, acc: 330 * f, A: 395 * (.94 + .12 * s), dmax: .78, brake: 600, safe: D.corner * (.96 + .04 * s), aggr: D.aggr * (.6 + .4 * s),
        sk: s, cons: clamp(.5 + .42 * s + rnd(-.12, .12) + D.cons, .3, .99), defend: clamp(D.def * (.3 + .5 * s + rnd(0, .3)), 0, 1), lp: rnd(-14, 14), react: rnd(.05, .45) * (1.2 - .7 * s), bkf: .72 + .1 * s + rnd(-.02, .04) });   // personalidade: consistência, defesa, faixa preferida, reação na largada, ponto de frenagem
      buildProfile(c);
    }
    cars.push(c);
  }
  player = cars[GRID - 1];
  coinsList = []; const nc = Math.floor(T.len / 560);
  for (let m = 0; m < nc; m++) { const p = T.pts[(30 + Math.floor(m * N / nc)) % N], o = rnd(-.3, .3) * T.w; coinsList.push({ x: p.x + p.nx * o, y: p.y + p.ny * o, got: false }); }
  run = { t: 0, coins: 0, order: [] }; state = 'count'; cdTotal = 5 + rnd(.4, 1.6); cdown = cdTotal; setLights(0); $('lights').classList.remove('hide', 'go'); $('count').textContent = '';   // semáforo: 5 luzes, uma por segundo, e apagam após uma espera aleatória (0,4–1,6 s)
  cam.x = player.x; cam.y = player.y; cam.z = 1;
  cv.classList.remove('hide'); $('hud').classList.remove('hide'); showScreen(null);
}

function update(dt) {
  for (const c of cars) {
    let thr = 0, str = 0, hb = false, nit = false;
    if (c.pit) [thr, str] = pitDrive(c, dt);
    else if (c.pl) {
      thr = (held('ArrowUp', 'KeyW') ? 1 : 0) - (held('ArrowDown', 'KeyS') ? 1 : 0);
      str = (held('ArrowRight', 'KeyD') ? 1 : 0) - (held('ArrowLeft', 'KeyA') ? 1 : 0); hb = !!keys.Space; nit = !!(keys.ShiftLeft || keys.ShiftRight || keys.KeyN);   // Shift (ou N) = nitro
    } else [thr, str, nit] = aiDrive(c, dt);
    c.draft = false;                                   // esteira: há um carro a ≤110 px à frente, na mesma faixa (±24 px)?
    for (const o of cars) if (o !== c) { const ds = wrapS(o.s - c.s); if (ds > 0 && ds < 110 && Math.abs(o.l - c.l) < 24) { c.draft = true; break; } }
    if (!c.pl && c.ov && track.kAh[c.i] < 1 / 600) c.draft = true;   // DRS dos bots durante a ultrapassagem (só em reta)
    stepCar(c, dt, thr, str, hb, nit);
    collideWorld(c);
    if (c.pit && c.pit.ph === 'stop') {          // parado no box: trava o carro na vaga
      c.vx = c.vy = 0; c.speed = 0;
      if (c.pit.box >= 0) { const b = track.boxPos[c.pit.box]; c.x += (b.x - c.x) * .2; c.y += (b.y - c.y) * .2; c.a += wrap(b.a - c.a) * .2; }
    }
    // bots decidem sozinhos quando ir ao pit; o jogador decide dirigindo para dentro do pit lane
    if (!c.pl && !c.pit && !c.wantPit && (c.tire < c.pitT || (c.stops === 0 && c.fuel < 1.1 / c.cap) || (c.stops > 0 && c.fuel < (cfg.laps - (c.lap + c.s / track.len)) / c.cap + .03) || (c.stops === 0 && c.lap + c.s / track.len >= Math.max(.5, cfg.laps - c.cap + c.pitJ)) || (c.stops === 0 && c.blkT > 6 && c.tire < .9 && c.lap + c.s / track.len > .9 && c.lap + c.s / track.len < cfg.laps - .9))) c.wantPit = true;   // + "undercut": preso atrás de um carro lento com pneus já gastos, antecipa a parada para pegar pista livre   // para quando 1 tanque cheio já basta para terminar (+ sorteio entre a 1ª e a 2ª passagem)
    if (!c.pit && (c.pl ? needPit(c) : c.wantPit)) {   // entrou no pit lane (faixa de dentro, entre a entrada e quase o fim)? o piloto automático assume
      const rel = relIdx(c.i), lp = c.l * track.pitSide;
      if (rel >= track.pa - 4 && rel <= track.pb - 8 && lp > track.hw + 14 && lp < track.hw + 62) { c.pit = { ph: 'in', box: chooseBox(c), t: 3, age: 0, f0: 0, w0: 0, s0: 0 }; c.wantPit = false; c.stuck = 0; }
    }
    // parada obrigatória: só conclui a corrida quem já parou. Se cruzar a linha final sem ter parado, fica devendo e termina assim que cumprir a parada
    if (c.cross && c.lap >= cfg.laps && c.stops === 0) c.owe = true;
    if (!c.fin && c.lap >= cfg.laps && c.stops > 0 && (c.cross || c.owe)) { c.fin = true; c.finT = run.t; run.order.push(c); }
  }
  carCollisions();
  for (const o of coinsList) if (!o.got && Math.hypot(o.x - player.x, o.y - player.y) < 28) { o.got = true; run.coins += 10; }
  if (player.fin) endRace();
}

const score = c => c.fin ? 1e9 - c.finT : c.lap * track.len + c.s;
const ranking = () => cars.slice().sort((a, b) => score(b) - score(a));
const fmt = t => `${String(t / 60 | 0).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function endRace() {
  lapWatch(); state = 'done';
  const place = run.order.indexOf(player) + 1, prize = PRIZES[place - 1];
  save.stats.pick += run.coins; save.coins += run.coins + prize; persist();
  $('rTitle').textContent = place === 1 ? 'Vitória!' : place + 'º lugar de ' + GRID;
  $('rInfo').textContent = `Tempo ${fmt(player.finT)} · Prêmio: ${prize} · Moedas da pista: ${run.coins} · Paradas: ${player.stops}${run.best ? ' · Melhor volta: ' + fmtLap(run.best) : ''} · Total: ${save.coins}`;
  $('rList').innerHTML = ranking().map((c, i) => `<li${c.pl ? ' class="me"' : ''}><b>${i + 1}</b><span>${c.pl ? 'Você' : 'Piloto ' + c.num}</span><em>${c.fin ? fmt(c.finT) : 'em pista'}</em></li>`).join('');
  showScreen('result');
}
function quit() { save.stats.pick += run.coins; save.coins += run.coins; persist(); toMenu(); }
function toMenu() { state = 'menu'; cv.classList.add('hide'); $('hud').classList.add('hide'); $('count').textContent = ''; $('lights').classList.add('hide'); showScreen('menu'); }

/* ---------- 8. Câmera e cena 3D ---------- */
// Câmera de perseguição: o estado (x, y, z) é o MESMO do 2D, com a mesma suavização exponencial  x ← x + (alvo − x)·(1 − e^(−5·dt)),  alvo = posição + 0,4·velocidade;
// o zoom z = clamp(1,05 − v/1500 − (nitro ? .05 : 0), .65, 1) (suavizado com 1 − e^(−2·dt)) vira DISTÂNCIA e ABERTURA (FOV) da câmera: z menor ⇒ mais longe e FOV maior.
// px,py = posição suavizada do carro (onde a câmera fica, atrás dele); a = ângulo suavizado do carro. A câmera só LÊ o estado do jogador.
function updateCam(dt, snap) {
  const k = snap ? 1 : 1 - Math.exp(-5 * dt), kz = snap ? 1 : 1 - Math.exp(-2 * dt), ka = snap ? 1 : 1 - Math.exp(-4 * dt);
  cam.px += (player.x - cam.px) * k; cam.py += (player.y - cam.py) * k;
  cam.x += (player.x + player.vx * .4 - cam.x) * k; cam.y += (player.y + player.vy * .4 - cam.y) * k;
  cam.z += (clamp(1.05 - player.speed / 1500 - (player.nitro ? .05 : 0), .65, 1) - cam.z) * kz;
  cam.a += wrap(player.a - cam.a) * ka;
}

const shade = (h, t) => { const n = parseInt(h.slice(1), 16), f = s => { const v = n >> s & 255; return Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t); }; return `rgb(${f(16)},${f(8)},${f(0)})`; };
// Carro de Fórmula 1 visto de cima, apontando para +x. Camadas: sombra > pneus/suspensão > carroceria > detalhes > cockpit > aerofólios
function drawCar(g, x, y, a, col, s = 1, nit = false) {
  const dk = shade(col, -.45), lt = shade(col, .4);
  g.save(); g.translate(x, y); g.rotate(a); g.scale(s, s); g.lineJoin = 'round';
  g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(-22, -11, 46, 26);
  g.strokeStyle = '#2a2d33'; g.lineWidth = 1.2; g.beginPath();
  g.moveTo(11, -3); g.lineTo(13, -8); g.moveTo(11, 3); g.lineTo(13, 8); g.moveTo(-11, -4); g.lineTo(-11, -8); g.moveTo(-11, 4); g.lineTo(-11, 8); g.stroke();
  for (const [wx, wy, wl, ww] of [[-17, -14, 12, 7], [-17, 7, 12, 7], [8, -13, 10, 5.5], [8, 7.5, 10, 5.5]]) {
    g.fillStyle = '#16181b'; g.beginPath(); g.roundRect(wx, wy, wl, ww, 2); g.fill();
    g.fillStyle = '#c9ccd2'; g.fillRect(wx + wl / 2 - 2, wy + ww / 2 - .8, 4, 1.6);
  }
  const U = [[24, 0], [17, -1.8], [10, -3.4], [5, -4], [3, -8.5], [-6, -8.5], [-10, -5.5], [-21, -2.6], [-22, 0]];
  g.beginPath(); U.forEach(([px, py], i) => i ? g.lineTo(px, py) : g.moveTo(px, py));
  for (let i = U.length - 2; i >= 1; i--) g.lineTo(U[i][0], -U[i][1]);
  g.closePath(); g.fillStyle = col; g.fill(); g.strokeStyle = dk; g.lineWidth = 1; g.stroke();
  g.fillStyle = lt; g.fillRect(-5, -7.6, 8, 1.8); g.fillRect(-5, 5.8, 8, 1.8);
  g.fillStyle = dk; g.fillRect(3, -8, 1.6, 3.2); g.fillRect(3, 4.8, 1.6, 3.2);
  g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(-20, -.9, 38, 1.8);
  g.fillStyle = dk; g.beginPath(); g.roundRect(-10, -2.4, 6, 4.8, 1.5); g.fill();
  g.fillStyle = '#0c0e11'; g.beginPath(); g.ellipse(1.5, 0, 5, 3, 0, 0, 7); g.fill();
  g.fillStyle = '#f5f5f0'; g.beginPath(); g.arc(1.5, 0, 2.3, 0, 7); g.fill();
  g.fillStyle = '#1b3a5c'; g.fillRect(2.6, -1.3, 1.5, 2.6);
  g.strokeStyle = '#2a2d33'; g.lineWidth = 1.3; g.beginPath(); g.moveTo(-3, -3.6); g.lineTo(5.5, 0); g.lineTo(-3, 3.6); g.stroke();
  g.fillStyle = '#16181b'; g.fillRect(-25, -12, 6, 24);
  g.fillStyle = col; g.fillRect(-26, -12.5, 8, 1.6); g.fillRect(-26, 10.9, 8, 1.6);
  g.fillStyle = lt; g.fillRect(-24, -1.2, 4, 2.4);
  g.fillStyle = '#ff2222'; g.fillRect(-26.6, -1.2, 1.2, 2.4);
  g.fillStyle = '#16181b'; g.fillRect(19, -12.5, 5, 25);
  g.fillStyle = col; g.fillRect(18, -13.5, 7, 1.6); g.fillRect(18, 11.9, 7, 1.6);
  g.fillStyle = lt; g.fillRect(22, -11.5, 1.4, 23);
  if (nit) {                                                    // chama do nitro atrás do aerofólio traseiro (tamanho oscila a cada quadro)
    const L = 16 + Math.random() * 10;
    g.fillStyle = '#ff7a00'; g.beginPath(); g.moveTo(-27, -4); g.lineTo(-27 - L, 0); g.lineTo(-27, 4); g.closePath(); g.fill();
    g.fillStyle = '#6fd3ff'; g.beginPath(); g.moveTo(-27, -2.2); g.lineTo(-27 - L * .6, 0); g.lineTo(-27, 2.2); g.closePath(); g.fill();
    g.fillStyle = '#fff'; g.fillRect(-29, -.8, 3, 1.6);
  }
  g.restore();
}


/* ---------- 8b. Cena 3D (Three.js) ----------
   Mapeamento: (x, y) da simulação → (X = x, Y = altura, Z = y). Ângulo a → rotation.y = −a (o modelo do carro aponta para +X; frente = (cos a, 0, sin a)).
   A pista 3D é montada UMA vez por circuito (T.g3, a partir dos dados de build()) e reaproveitada; os 20 carros 3D são reaproveitados a cada corrida.
   Tudo aqui só LÊ o estado da simulação: nada é escrito de volta. */
const R3 = (() => { let s = 20241107; return () => (s = s * 16807 % 2147483647) / 2147483647; })();   // gerador SEPARADO de R(): só para texturas visuais do 3D
const WALL_H = 12, WALL_T = 6, WALL_OFF = 0;   // muro: altura, espessura e deslocamento para fora (0 = face interna exatamente em T.bar, onde collideWorld barra o CENTRO do carro; use ~13 para o casco não entrar no muro)
const SUN = [250, 330, 150];                   // direção do sol (relativa ao jogador)
const ANISO = renderer.capabilities.getMaxAnisotropy();
scene.background = new THREE.Color(0xb4d3f0); scene.fog = new THREE.Fog(0xb4d3f0, 1500, 4300);
const hemi = new THREE.HemisphereLight(0xd6e8ff, 0xa4ad94, 1.7), sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -.0004; sun.shadow.normalBias = .6;
Object.assign(sun.shadow.camera, { left: -320, right: 320, top: 320, bottom: -320, near: 10, far: 900 }); sun.shadow.camera.updateProjectionMatrix();
scene.add(hemi, sun, sun.target);
let hiCam = false; addEventListener('keydown', e => { if (e.code === 'KeyC' && !e.repeat) hiCam = !hiCam; });   // C: alterna câmera alta (estilo 2D)

const mkCv = (w, h, fn) => { const c = document.createElement('canvas'); c.width = w; c.height = h; fn(c.getContext('2d'), w, h); return c; };
const mkTex = (c, rep) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = ANISO; if (rep) t.repeat.set(rep, rep); return t; };
const layer = (m, L) => { m.polygonOffset = true; m.polygonOffsetFactor = -L; m.polygonOffsetUnits = -L; return m; };   // camadas coplanares: quanto maior L, mais "por cima"
// Faixas (ribbons): strip(A, B, uv, fechada) liga duas linhas de vértices [x,y,z]; uv(vértice, índice_da_linha, lado 0|1) → [u,v]
function mesher() {
  const P = [], U = [], I = []; let n = 0;
  return {
    strip(A, B, f, closed) {
      const m = A.length, base = n;
      for (let i = 0; i < m; i++) for (const [q, s] of [[A[i], 0], [B[i], 1]]) { P.push(q[0], q[1], q[2]); const t = f(q, i, s); U.push(t[0], t[1]); n++; }
      for (let i = 0, e = closed ? m : m - 1; i < e; i++) { const a = base + 2 * i, b = base + 2 * ((i + 1) % m); I.push(a, a + 1, b, a + 1, b + 1, b); }
    },
    mesh(mat) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      g.setIndex(I); g.computeVertexNormals(); return new THREE.Mesh(g, mat);
    }
  };
}

function makeTrack3d(T) {
  const P = T.pts, N = P.length, hw = T.hw, bar = T.bar, g = new THREE.Group(), DS = THREE.DoubleSide;
  const at3 = (i, d, y) => { const p = P[(i % N + N) % N]; return [p.x + p.nx * d, y, p.y + p.ny * d]; };    // ponto a d px da linha central (+ = direita)
  const rows = (f0, f1, y) => { const A = [], B = []; for (let i = 0; i < N; i++) { A.push(at3(i, f0(i), y)); B.push(at3(i, f1(i), y)); } return [A, B]; };
  const wuv = sc => q => [q[0] / sc, q[2] / sc];                                                             // UV em coordenadas do mundo (sobreposições não "brigam")
  const put = (M, mat, cast) => { const o = M.mesh(mat); o.receiveShadow = true; o.castShadow = !!cast; g.add(o); return o; };
  const p3 = (p, y) => [p[0], y, p[1]], lift = (A, y) => A.map(p => [p[0], y, p[2]]), flat = () => [0, 0];
  // Faixa de largura 2h ao longo de uma polilinha 2D [x,y] (zebras, escapes, pit lane, muro do pit); devolve as bordas esquerda/direita em 3D
  const ribbon = (M, q, h, y, mode) => {
    const A = [], B = [], U = []; let s = 0;
    q.forEach((p, j) => {
      const a = q[Math.max(j - 1, 0)], b = q[Math.min(j + 1, q.length - 1)], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1, nx = -ty / l * h, ny = tx / l * h;
      if (j) s += Math.hypot(p[0] - q[j - 1][0], p[1] - q[j - 1][1]);
      A.push([p[0] - nx, y, p[1] - ny]); B.push([p[0] + nx, y, p[1] + ny]); U.push(s);
    });
    M.strip(A, B, mode === 'k' ? (_, i, sd) => [U[i] / 26, sd] : mode === 'w' ? wuv(160) : flat);
    return [A, B];
  };
  const grain = base => mkCv(256, 256, (c, w, h) => { c.fillStyle = base; c.fillRect(0, 0, w, h); for (let i = 0; i < 1600; i++) { c.fillStyle = R3() < .5 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.13)'; c.fillRect(R3() * w, R3() * h, 1 + R3() * 2, 1 + R3() * 2); } });
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of P) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }

  // 1. Grama externa: plano gigante (a névoa esconde a borda) com a textura de T.grass; piso da zona de escape (largura w + 2·margin) com T.ground
  const size = Math.max(x1 - x0, y1 - y0) + 9000;
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: mkTex(T.grassPat, size / 256), roughness: 1 }));
  grass.position.set((x0 + x1) / 2, 0, (y0 + y1) / 2); grass.receiveShadow = true; g.add(grass);
  let M = mesher(); M.strip(...rows(() => -bar, () => bar, .03), wuv(256), true);
  put(M, layer(new THREE.MeshStandardMaterial({ map: mkTex(T.groundPat), roughness: 1, side: DS }), 1));

  // 5. Pista: linhas brancas (w + 8), asfalto com grão, faixa de "borracha" na linha ideal (30 de largura, preto ~12%)
  M = mesher(); M.strip(...rows(() => -(hw + 4), () => hw + 4, .08), () => [0, 0], true);
  put(M, layer(new THREE.MeshStandardMaterial({ color: 0xe9e9e9, roughness: .7, side: DS }), 2));
  const asf = grain(T.asphalt);
  M = mesher(); M.strip(...rows(() => -hw, () => hw, .12), wuv(160), true);
  put(M, layer(new THREE.MeshStandardMaterial({ map: mkTex(asf), roughness: .92, side: DS }), 3));
  M = mesher(); M.strip(...rows(i => T.off[i] - 15, i => T.off[i] + 15, .16), () => [0, 0], true);
  put(M, layer(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .12, depthWrite: false, side: DS }), 4)).receiveShadow = false;

  // 6. Zebras (T.kerbs): blocos de 13 vermelho #d62828 / branco #f2f2f2, levemente elevadas, lado de dentro das curvas
  M = mesher(); for (const k of T.kerbs) ribbon(M, k.p, 4.5, .35, 'k');
  const kt = mkTex(mkCv(64, 16, c => { c.fillStyle = '#d62828'; c.fillRect(0, 0, 32, 16); c.fillStyle = '#f2f2f2'; c.fillRect(32, 0, 32, 16); }));
  put(M, layer(new THREE.MeshStandardMaterial({ map: kt, roughness: .6, side: DS }), 6));

  // 7. Linha de largada em P[0]: xadrez 2 colunas × (w/13) linhas de 13; grid: 20 retângulos 48×26 (k = 0 é a pole)
  const chk = mkCv(32, 128, c => { for (let q = 0; q < 8; q++) for (let r = 0; r < 2; r++) { c.fillStyle = (q + r) % 2 ? '#fff' : '#111'; c.fillRect(r * 16, q * 16, 16, 16); } });
  const ct = mkTex(chk); ct.wrapS = ct.wrapT = THREE.ClampToEdgeWrapping; ct.magFilter = THREE.NearestFilter;
  const st = new THREE.Mesh(new THREE.PlaneGeometry(26, T.w).rotateX(-Math.PI / 2), layer(new THREE.MeshStandardMaterial({ map: ct, roughness: .8, side: DS }), 5));
  st.position.set(P[0].x, .2, P[0].y); st.rotation.y = -P[0].t; st.receiveShadow = true; g.add(st);
  const slotT = mkTex(mkCv(96, 52, c => { c.strokeStyle = 'rgba(255,255,255,.65)'; c.lineWidth = 4; c.strokeRect(2, 2, 92, 48); }));
  slotT.wrapS = slotT.wrapT = THREE.ClampToEdgeWrapping;
  const sl = new THREE.InstancedMesh(new THREE.PlaneGeometry(48, 26).rotateX(-Math.PI / 2), layer(new THREE.MeshBasicMaterial({ map: slotT, transparent: true, depthWrite: false, side: DS }), 5), GRID), dm = new THREE.Object3D();
  T.slots.forEach((s, k) => { dm.position.set(s.x, .24, s.y); dm.rotation.set(0, -s.a, 0); dm.updateMatrix(); sl.setMatrixAt(k, dm.matrix); });
  sl.instanceMatrix.needsUpdate = true; sl.frustumCulled = false; g.add(sl);

  // 2. Muros nas duas bordas, a T.bar do centro (onde collideWorld barra o carro). Trechos que ficariam DENTRO da pista (curvas fechadas, onde a borda "dobra") são descartados:
  //    só vale o ponto cuja amostra mais próxima da linha central está a ≥ T.bar — exatamente o critério de collideWorld.
  const near2 = (x, z) => { let m = 1e18; for (let i = 0; i < N; i++) { const dx = P[i].x - x, dz = P[i].y - z, d = dx * dx + dz * dz; if (d < m) m = d; } return m; };
  const wc = mkCv(128, 64, (c, w, h) => { c.fillStyle = '#cfd2d8'; c.fillRect(0, 0, w, h); c.fillStyle = '#b3b8c0'; c.fillRect(0, 22, w, 12); c.fillStyle = '#979ca5'; c.fillRect(0, 0, 2, h); c.fillStyle = 'rgba(255,255,255,.25)'; c.fillRect(0, 40, w, 3); });
  M = mesher();
  for (const s of [-1, 1]) {
    const d0 = s * (bar + WALL_OFF), d1 = s * (bar + WALL_OFF + WALL_T), ok = [];
    for (let i = 0; i < N; i++) { const q = at3(i, d0, 0); ok.push(near2(q[0], q[2]) >= (bar - 2) ** 2); }
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N; if (!ok[i] || !ok[j]) continue;
      const f = (_, r, sd) => [(i + r) * T.ds / 96, sd], row = (d, y) => [at3(i, d, y), at3(j, d, y)];
      M.strip(row(d0, 0), row(d0, WALL_H), f); M.strip(row(d0, WALL_H), row(d1, WALL_H), f); M.strip(row(d1, WALL_H), row(d1, 0), f);   // face interna, topo, face externa
    }
  }
  put(M, new THREE.MeshStandardMaterial({ map: mkTex(wc), roughness: .9, side: DS }), true);
  // 3. Escapes de asfalto (T.runoffs): faixa de 56 de largura (#5b5f66) no lado de fora das curvas
  M = mesher(); for (const r of T.runoffs) ribbon(M, r.p, 28, .06, 'w');
  put(M, layer(new THREE.MeshStandardMaterial({ map: mkTex(grain('#5b5f66')), roughness: .95, side: DS }), 2));

  // 4. Pit lane: borda branca de 40 (pisca em amarelo quando "hot") + asfalto #43464e de 36, muro do pit e 20 boxes/garagens abertas na frente (o carro estaciona DENTRO da vaga T.park)
  M = mesher(); ribbon(M, T.pit.lane, 20, .09, 'f');
  const border = layer(new THREE.MeshStandardMaterial({ color: 0xe8e8e8, emissive: 0x000000, roughness: .7, side: DS }), 2); put(M, border);
  M = mesher(); ribbon(M, T.pit.lane, 18, .11, 'f'); put(M, layer(new THREE.MeshStandardMaterial({ color: 0x43464e, roughness: .9, side: DS }), 3));
  const concrete = new THREE.MeshStandardMaterial({ color: 0x7b7f87, roughness: .9, side: DS });
  { const [WL, WR] = ribbon(mesher(), T.pit.wall, 2, 0, 'f'), WM = mesher(), WT = mesher();                          // muro do pit: baixo (6), topo branco
    WM.strip(lift(WL, 0), lift(WL, 6), flat); WM.strip(lift(WR, 6), lift(WR, 0), flat); WT.strip(lift(WL, 6), lift(WR, 6), flat);
    put(WM, new THREE.MeshStandardMaterial({ color: 0xaeb3bb, roughness: .9, side: DS }), true); put(WT, new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: .8, side: DS }), true); }
  // Garagens: piso cinza + faixa do time no chão (como no 2D) na vaga aberta, e um prédio baixo ao fundo (fachada clara de 18, telhado, portão escuro e faixa do time em cada vaga)
  const lerp2 = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], pS = T.pitSide;
  const FAC = mesher(), ROOF = mesher(), GATE = mesher(), FLOOR = mesher(), tm = TEAMS.map(() => mesher()), fA = [], fB = [], rA = [], rB = [];
  for (let j = T.pa; j <= T.pb; j++) { fA.push(at3(j, pS * (hw + 80), 0)); fB.push(at3(j, pS * (hw + 80), 18)); rA.push(at3(j, pS * (hw + 80), 18)); rB.push(at3(j, pS * (hw + 88), 18)); }
  FAC.strip(fA, fB, flat); ROOF.strip(rA, rB, flat);
  T.pit.boxes.forEach((b, k) => {
    const [q0, q1, q2, q3] = b.q, d = b.door, T1 = tm[k % TEAMS.length], ux = q0[0] - q3[0], uy = q0[1] - q3[1], ul = Math.hypot(ux, uy) || 1, ix = ux / ul * .35, iy = uy / ul * .35;
    const pa = lerp2(q3, q2, .08), pb = lerp2(q3, q2, .92), a2 = [pa[0] + ix, pa[1] + iy], b2 = [pb[0] + ix, pb[1] + iy];   // 0,35 px à frente da fachada (não "briga" com ela)
    FLOOR.strip([p3(q0, .2), p3(q1, .2)], [p3(q3, .2), p3(q2, .2)], flat);                                              // piso da vaga
    T1.strip([p3(d[0], .24), p3(d[1], .24)], [p3(d[3], .24), p3(d[2], .24)], flat);                                      // faixa da "porta" no chão, cor do time
    GATE.strip([p3(a2, 0), p3(b2, 0)], [p3(a2, 11), p3(b2, 11)], flat);                                                   // portão escuro
    T1.strip([p3(a2, 11), p3(b2, 11)], [p3(a2, 17.5), p3(b2, 17.5)], flat);                                              // faixa do time acima do portão
  });
  put(FAC, new THREE.MeshStandardMaterial({ color: 0xb4b9c1, roughness: .9, side: DS }), true); put(ROOF, new THREE.MeshStandardMaterial({ color: 0x8a8f97, roughness: .9, side: DS }), true);
  put(GATE, new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: .9, side: DS })); put(FLOOR, concrete);
  tm.forEach((m, i) => put(m, new THREE.MeshStandardMaterial({ color: TEAMS[i], roughness: .6, side: DS })));
  // Placa "PIT STOP": painel amarelo grande sobre o prédio dos boxes, de frente para quem chega (aponta para o lado do pit, sem névoa: dá para ver de longe) — pisca junto com o alerta de pit
  const ps0 = pS > 0, stx = mkCv(512, 128, (c, w, h) => {
    c.fillStyle = '#ffc300'; c.fillRect(0, 0, w, h); c.fillStyle = '#111'; c.fillRect(0, 0, w, 9); c.fillRect(0, h - 9, w, 9); c.fillRect(0, 0, 9, h); c.fillRect(w - 9, 0, 9, h);
    c.font = 'italic 900 70px "Arial Black", Impact, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('PIT STOP', w / 2, h / 2 + 4);
    for (const x of [50, w - 50]) { c.beginPath(); if (ps0) { c.moveTo(x - 18, h / 2 - 27); c.lineTo(x + 18, h / 2); c.lineTo(x - 18, h / 2 + 27); } else { c.moveTo(x + 18, h / 2 - 27); c.lineTo(x - 18, h / 2); c.lineTo(x + 18, h / 2 + 27); } c.closePath(); c.fill(); }
  });
  const signM = new THREE.MeshBasicMaterial({ map: mkTex(stx), toneMapped: false, fog: false, side: DS }), sign = new THREE.Mesh(new THREE.PlaneGeometry(130, 32), signM), sp = at3(T.pa + 3, pS * (hw + 88), 36), st0 = P[((T.pa + 3) % N + N) % N].t;
  sign.position.set(sp[0], sp[1], sp[2]); sign.rotation.y = Math.atan2(-Math.cos(st0), -Math.sin(st0)); g.add(sign);       // a frente da placa olha contra o sentido da corrida
  const e = T.entry, tri = new THREE.BufferGeometry();                                                                   // seta de entrada do pit (só visível quando "hot")
  tri.setAttribute('position', new THREE.Float32BufferAttribute([22, 0, 0, -8, 0, -18, -8, 0, 18], 3));
  const arrow = new THREE.Mesh(tri, new THREE.MeshBasicMaterial({ color: 0xffc300, transparent: true, depthWrite: false, toneMapped: false, side: DS }));
  arrow.position.set(e.x, .45, e.y); arrow.rotation.y = -(e.a + T.pitSide * Math.PI / 2); arrow.scale.setScalar(1.5); arrow.visible = false; g.add(arrow);

  // 8. Arquibancadas em degraus (6 degraus, 40 de altura) que SEGUEM A CURVA da pista + torcida: 1 InstancedMesh com todos os torcedores (a "ola" só atualiza as arquibancadas perto da câmera).
  //    O contorno de cada arquibancada é reconstruído a partir dos cantos do quad de build() (índices de partida/chegada e lado), todas começam a bar + 14 e têm 44 de profundidade.
  const FH = 40, TI = 6, SD = 44, D0 = bar + 14, S1 = mesher(), S2 = mesher(), fa = [], sinfo = [];
  const findQ = q => { for (const s of [-1, 1]) for (let i = 0; i < N; i++) { const a = at3(i, s * D0, 0); if (Math.abs(a[0] - q[0]) < .01 && Math.abs(a[2] - q[1]) < .01) return [i, s]; } return null; };
  for (const st of T.stands) {
    const f0 = findQ(st.quad[0]), f1 = findQ(st.quad[1]), i0 = fa.length;
    if (f0 && f1) {
      const ia = f0[0], s = f0[1], cnt = Math.max(1, (f1[0] - ia + N) % N), cs = (j, dd, y) => at3(ia + j, s * dd, y), rw = (dd, y) => Array.from({ length: cnt + 1 }, (_, j) => cs(j, dd, y));
      for (let r = 0; r < TI; r++) {
        const dd0 = D0 + r * SD / TI, dd1 = D0 + (r + 1) * SD / TI, h0 = r * FH / TI, h = (r + 1) * FH / TI;
        S1.strip(rw(dd0, h), rw(dd1, h), flat);                                                                          // piso do degrau
        S2.strip(rw(dd0, h0), rw(dd0, h), flat);                                                                         // espelho (frente) do degrau
        for (const j of [0, cnt]) S2.strip([cs(j, dd0, 0), cs(j, dd1, 0)], [cs(j, dd0, h), cs(j, dd1, h)], flat);         // laterais
      }
      S2.strip(rw(D0 + SD, 0), rw(D0 + SD, FH), flat);                                                                    // fundo
    }
    st.fans.forEach((f, k) => fa.push({ x: f.x, z: f.y, y: (k % 6 + 1) * FH / TI, ph: f.ph, c: f.c, up: false }));       // build() gera os torcedores em ordem j → u → r: k % 6 = fileira = degrau
    sinfo.push({ bb: st.bb, i0, i1: fa.length });
  }
  put(S1, new THREE.MeshStandardMaterial({ color: 0xa3a7af, roughness: .85, side: DS })); put(S2, new THREE.MeshStandardMaterial({ color: 0x80848c, roughness: .9, side: DS }));
  const fans = new THREE.InstancedMesh(mergeC([[new THREE.BoxGeometry(2.6, 4, 2.6).translate(0, 2, 0)], [new THREE.SphereGeometry(1.4, 6, 4).translate(0, 5.3, 0)]]), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .8 }), Math.max(fa.length, 1));
  const dm2 = new THREE.Object3D();
  fa.forEach((f, k) => { dm2.position.set(f.x, f.y, f.z); dm2.updateMatrix(); fans.setMatrixAt(k, dm2.matrix); fans.setColorAt(k, new THREE.Color(FANS[f.c])); });
  fans.instanceMatrix.needsUpdate = true; if (fans.instanceColor) fans.instanceColor.needsUpdate = true; fans.frustumCulled = false; fans.count = fa.length; g.add(fans);

  // 9. Árvores (T.trees: x, y, r, c): tronco + copa na cor TREE[c], altura 2,5–3,5 × r (sorteada com R3, sem tocar em R()); sem colisão
  const nT = T.trees.length, cm = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .95, flatShading: true }), Math.max(nT, 1));
  const tk = new THREE.InstancedMesh(new THREE.CylinderGeometry(.14, .2, 1, 6).translate(0, .5, 0), new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 }), Math.max(nT, 1));
  T.trees.forEach((t, k) => {
    const H = t.r * (2.5 + R3()), th = t.r * .9, ry = (H - th) / 2;
    dm2.position.set(t.x, th + ry, t.y); dm2.rotation.set(0, R3() * 6.28, 0); dm2.scale.set(t.r, ry, t.r); dm2.updateMatrix(); cm.setMatrixAt(k, dm2.matrix); cm.setColorAt(k, new THREE.Color(TREE[t.c]));
    dm2.position.set(t.x, 0, t.y); dm2.rotation.set(0, 0, 0); dm2.scale.set(t.r, th, t.r); dm2.updateMatrix(); tk.setMatrixAt(k, dm2.matrix);
  });
  for (const o of [cm, tk]) { o.instanceMatrix.needsUpdate = true; o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; o.count = nT; g.add(o); }
  if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
  g.userData = { border, arrow, fans, fa, sinfo, signM };
  return g;
}

/* Carro de F1 em 3D, fiel a drawCar(): coordenadas locais (X = frente, Y = altura, Z = lateral), nariz em +X, 1 unidade = 1 px.
   Geometrias são mescladas por material (cor do time / escuro / claro / detalhes com cor por vértice) e COMPARTILHADAS pelos 20 carros. */
function mergeC(parts) {
  const gs = parts.map(([g]) => g.index ? g.toNonIndexed() : g), n = gs.reduce((s, g) => s + g.attributes.position.count, 0);
  const P = new Float32Array(n * 3), Nm = new Float32Array(n * 3), C = new Float32Array(n * 3); let o = 0;
  gs.forEach((g, k) => {
    const c = new THREE.Color(parts[k][1] === undefined ? 0xffffff : parts[k][1]), m = g.attributes.position.count;
    P.set(g.attributes.position.array, o * 3); Nm.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < m; i++) { C[(o + i) * 3] = c.r; C[(o + i) * 3 + 1] = c.g; C[(o + i) * 3 + 2] = c.b; }
    o += m;
  });
  const r = new THREE.BufferGeometry(); r.setAttribute('position', new THREE.BufferAttribute(P, 3)); r.setAttribute('normal', new THREE.BufferAttribute(Nm, 3)); r.setAttribute('color', new THREE.BufferAttribute(C, 3)); return r;
}
function buildCarGeo() {
  const bx = (x0, y0, z0, x1, y1, z1) => new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  const mir = (x0, y0, z0, x1, y1, z1) => [bx(x0, y0, z0, x1, y1, z1), bx(x0, y0, -z1, x1, y1, -z0)];            // par simétrico (z>0 e z<0)
  const seg = (xa, za, xb, zb, y, w, h, hex) => { const l = Math.hypot(xb - xa, zb - za), g = new THREE.BoxGeometry(l, h, w); g.rotateY(-Math.atan2(zb - za, xb - xa)); g.translate((xa + xb) / 2, y, (za + zb) / 2); return [g, hex]; };
  const sym = h => h.concat(h.slice(1, -1).reverse().map(([x, z]) => [x, -z]));                                  // meio contorno → contorno fechado
  const ext = (pts, y0, y1) => { const sh = new THREE.Shape(); pts.forEach(([x, z], i) => i ? sh.lineTo(x, z) : sh.moveTo(x, z)); sh.closePath(); return new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0, 0); };
  const wheel = (r, w) => mergeC([[new THREE.CylinderGeometry(r, r, w, 22).rotateX(Math.PI / 2), 0x16181b], [new THREE.CylinderGeometry(r * .55, r * .55, w + .6, 14).rotateX(Math.PI / 2), 0xc9ccd2], [bx(-r * .5, -r * .09, -(w + .9) / 2, r * .5, r * .09, (w + .9) / 2), 0x2a2d33]]);
  const cone = r => new THREE.ConeGeometry(r, 1, 10).rotateZ(Math.PI / 2).translate(-.5, 0, 0);                    // chama: base em x = 0, ponta em x = −1 (escala em X = comprimento)
  const col = [ext(sym([[24, 0], [17, -1.8], [10, -3.4], [5, -4], [3, -8.5], [-6, -8.5], [-10, -5.5], [-21, -2.6], [-22, 0]]), 3, 7),                  // chassi: nariz fino, sidepods (meia-largura 8,5), traseira estreita
    ext(sym([[14, 0], [10, -2.4], [4, -3], [-6, -3], [-14, -2.2], [-20, -1], [-20.5, 0]]), 7, 9),                                                      // dorso central (airbox)
    ...mir(18, .8, 11.9, 25, 4.6, 13.5), ...mir(-26, 7.5, 10.9, -18, 12.5, 12.5)];                                                                     // endplates das asas, na cor do time
  const dk = [...mir(3, 4, 4.8, 4.6, 7.2, 8), bx(-10, 9, -2.4, -4, 10.6, 2.4)];                                                                       // entradas de ar escuras (shade −.45) e cobertura do motor
  const lt = [...mir(-5, 7, 5.8, 3, 7.35, 7.6), bx(22, 2.8, -11.5, 23.4, 3.1, 11.5), bx(-24, 7, -1.2, -20, 9.6, 1.2)];                                 // entradas claras (shade +.4), faixa da asa dianteira, pilar da asa traseira
  const det = mergeC([[bx(19, 2, -12.5, 24, 2.8, 12.5), 0x16181b], [bx(-25, 9.6, -12, -19, 10.4, 12), 0x16181b],                                         // asas dianteira (x 19..24, largura 25) e traseira (x −25..−19, largura 24)
    [new THREE.CylinderGeometry(1, 1, .5, 18).scale(5, 1, 3).translate(1.5, 9.25, 0), 0x0c0e11],                                                        // cockpit preto
    [new THREE.SphereGeometry(2.3, 14, 10).translate(1.5, 10.6, 0), 0xf5f5f0], [bx(2.8, 10.2, -1.3, 4.3, 11.2, 1.3), 0x1b3a5c],                        // capacete branco e viseira azul
    seg(-3, -3.6, 5.5, 0, 11.2, .9, .9, 0x2a2d33), seg(5.5, 0, -3, 3.6, 11.2, .9, .9, 0x2a2d33), [bx(5, 9, -.4, 6, 11.6, .4), 0x2a2d33],                // halo
    [bx(-20, 9.02, -.9, 14, 9.12, .9), 0xf2f2ee], [bx(14, 7.02, -.9, 18, 7.12, .9), 0xf2f2ee],                                                          // faixa branca central (x −20..18)
    seg(11, -3, 13, -7.5, 4.6, .8, .8, 0x2a2d33), seg(11, 3, 13, 7.5, 4.6, .8, .8, 0x2a2d33), seg(-11, -4, -11, -7, 5.5, .8, .8, 0x2a2d33), seg(-11, 4, -11, 7, 5.5, .8, .8, 0x2a2d33)]); // braços de suspensão
  return { col: mergeC(col.map(g => [g])), dk: mergeC(dk.map(g => [g])), lt: mergeC(lt.map(g => [g])), det, red: bx(-26.6, 7.8, -1.2, -25.4, 9.4, 1.2),
    wr: wheel(6, 7), wf: wheel(5, 5.5), f1: cone(3.6), f2: cone(2.2), f3: cone(1.1) };
}
const matCache = {}, MAT = {};
const mkTeamMats = col => ({
  c: new THREE.MeshPhysicalMaterial({ color: col, roughness: .38, metalness: .15, clearcoat: .8, clearcoatRoughness: .15, side: THREE.DoubleSide }),
  d: new THREE.MeshStandardMaterial({ color: shade(col, -.45), roughness: .6, side: THREE.DoubleSide }),
  l: new THREE.MeshStandardMaterial({ color: shade(col, .4), roughness: .5, side: THREE.DoubleSide }) });
const teamMats = col => matCache[col] || (matCache[col] = mkTeamMats(col));      // 3 materiais por cor de time (carroceria com clearcoat, partes escuras e claras via shade())
const setTeam = (t, col) => { t.c.color.set(col); t.d.color.set(shade(col, -.45)); t.l.color.set(shade(col, .4)); };
function ensureCars() { if (!CAR) initCars(); }
let CAR = null, views = null, sceneTrack = null, viewCars = null, sky = null, coinMesh = null;
function makeView() {
  const g = new THREE.Group(), shell = new THREE.Group(), v = { g, shell, ok: false };
  const mk = (geo, mat, cast) => { const m = new THREE.Mesh(geo, mat); m.castShadow = !!cast; return m; };
  v.mc = mk(CAR.col, MAT.det, 1); v.md = mk(CAR.dk, MAT.det); v.ml = mk(CAR.lt, MAT.det);
  shell.add(v.mc, v.md, v.ml, mk(CAR.det, MAT.det, 1), mk(CAR.red, MAT.red)); g.add(shell);
  v.wh = [[-11, 6, 10.5, CAR.wr, 0], [-11, 6, -10.5, CAR.wr, 0], [13, 5, 10.25, CAR.wf, 1], [13, 5, -10.25, CAR.wf, 1]].map(([x, y, z, geo, fr]) => {
    const p = new THREE.Group(), m = mk(geo, MAT.det, 1); p.position.set(x, y, z); p.add(m); g.add(p); return { p, m, r: fr ? 5 : 6, fr };
  });
  v.flg = new THREE.Group(); v.flg.position.set(-26.5, 6.5, 0); v.flg.visible = false;                              // chama do nitro atrás da asa traseira
  v.fl = [[CAR.f1, MAT.f1], [CAR.f2, MAT.f2], [CAR.f3, MAT.f3]].map(([geo, mat]) => { const m = mk(geo, mat); v.flg.add(m); return m; });
  shell.add(v.flg);
  v.paint = col => { const t = teamMats(col); v.mc.material = t.c; v.md.material = t.d; v.ml.material = t.l; };
  return v;
}
function initCars() {
  CAR = buildCarGeo();
  MAT.det = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: .1 });
  MAT.red = new THREE.MeshBasicMaterial({ color: 0xff2222, toneMapped: false });
  MAT.f1 = new THREE.MeshBasicMaterial({ color: 0xff7a00, toneMapped: false }); MAT.f2 = new THREE.MeshBasicMaterial({ color: 0x6fd3ff, toneMapped: false }); MAT.f3 = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  views = Array.from({ length: GRID }, makeView); views.forEach(v => scene.add(v.g));
  // Céu: cúpula com gradiente (horizonte = cor da névoa) que acompanha a câmera
  const sg = new THREE.SphereGeometry(4500, 24, 12), pos = sg.attributes.position, hz = new THREE.Color(0xb4d3f0), zn = new THREE.Color(0x4f8fd6), cl = new THREE.Color(), cs = [];
  for (let i = 0; i < pos.count; i++) { cl.copy(hz).lerp(zn, Math.pow(clamp(pos.getY(i) / 4500, 0, 1), .6)); cs.push(cl.r, cl.g, cl.b); }
  sg.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
  sky = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false })); sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky);
  // Moedas: discos dourados em pé (raio 9) que giram; somem quando o.got = true
  coinMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(9, 9, 2.6, 22).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffd23f, metalness: .2, roughness: .35, emissive: 0xb8860b, emissiveIntensity: .65 }), 64);
  coinMesh.frustumCulled = false; coinMesh.castShadow = true; scene.add(coinMesh);
}
// Pista e carros 3D só são (re)montados quando mudam: troca de circuito (cache em T.g3) ou nova corrida (cores dos carros)
function prepare3d() {
  ensureCars();
  if (sceneTrack !== track) { if (sceneTrack) scene.remove(sceneTrack.g3); if (!track.g3) track.g3 = makeTrack3d(track); scene.add(track.g3); sceneTrack = track; }
  if (viewCars !== cars) { viewCars = cars; cars.forEach((c, k) => { views[k].paint(c.col); views[k].ok = false; views[k].sk = null; }); fxReset(); Q.n = Q.t = Q.w = 0; }
}
// Animação só visual, calculada a partir do que o carro REALMENTE andou no quadro (parado = rodas paradas): giro das rodas, esterço (δ ≈ atan(ω·L/v)), rolagem e arfagem
function syncView(v, c, dt) {
  if (!v.ok) Object.assign(v, { ok: true, px: c.x, py: c.y, pa: c.a, vf0: 0, spin: 0, st: 0, rl: 0, pt: 0 });
  const dd = (c.x - v.px) * Math.cos(c.a) + (c.y - v.py) * Math.sin(c.a), w = wrap(c.a - v.pa) / dt, vf = dd / dt, af = (vf - v.vf0) / dt;
  v.px = c.x; v.py = c.y; v.pa = c.a; v.vf0 = vf; v.spin += dd;
  const ks = 1 - Math.exp(-14 * dt), kb = 1 - Math.exp(-8 * dt);
  v.st += ((Math.abs(vf) > 15 ? clamp(Math.atan(w * WB / vf), -.5, .5) : 0) - v.st) * ks;
  v.rl += (clamp(-vf * w * .00012, -.07, .07) - v.rl) * kb; v.pt += (clamp(af * .00004, -.04, .04) - v.pt) * kb;
  v.g.position.set(c.x, 0, c.y); v.g.rotation.y = -c.a; v.shell.rotation.set(v.rl, 0, v.pt);
  for (const h of v.wh) { h.p.rotation.y = h.fr ? -v.st : 0; h.m.rotation.z = -v.spin / h.r; }
  v.flg.visible = !!c.nitro;
  if (c.nitro) { const L = 16 + Math.random() * 10; v.fl[0].scale.x = L; v.fl[1].scale.x = L * .6; v.fl[2].scale.x = 3; }   // chama: comprimento oscila entre 16 e 26 a cada quadro
}

// Animações do cenário (só leem o estado): moedas girando, ola da torcida (só perto da câmera) e alertas de pit (borda piscando + seta)
const dmA = new THREE.Object3D(), WHITE = new THREE.Color(0xffffff);
function animScene(ts) {
  const ud = track.g3.userData, hot = state === 'race' && !player.pit && pitAlert(player), on = hot && Math.sin(ts * 6) > 0;
  ud.border.color.set(on ? 0xffc300 : 0xe8e8e8); ud.border.emissive.set(on ? 0xffc300 : 0x000000); ud.border.emissiveIntensity = .8;
  ud.signM.color.setScalar(hot && !on ? .5 : 1); ud.arrow.visible = hot; if (hot) ud.arrow.material.opacity = .55 + .45 * Math.sin(ts * 8);
  let ch = false;
  for (const s of ud.sinfo) {
    if (!(s.bb[2] > cam.x - 900 && s.bb[0] < cam.x + 900 && s.bb[3] > cam.y - 900 && s.bb[1] < cam.y + 900)) continue;
    for (let k = s.i0; k < s.i1; k++) {
      const f = ud.fa[k], up = Math.sin(ts * 3 + f.ph) > .8; if (up === f.up) continue;
      f.up = up; dmA.position.set(f.x, f.y + (up ? 1.2 : 0), f.z); dmA.updateMatrix(); ud.fans.setMatrixAt(k, dmA.matrix); ud.fans.setColorAt(k, up ? WHITE : new THREE.Color(FANS[f.c])); ch = true;
    }
  }
  if (ch) { ud.fans.instanceMatrix.needsUpdate = true; ud.fans.instanceColor.needsUpdate = true; }
  const n = Math.min(coinsList.length, 64); coinMesh.count = n;
  for (let k = 0; k < n; k++) { const o = coinsList[k]; dmA.position.set(o.x, 11 + Math.sin(ts * 3 + k) * 1.5, o.y); dmA.rotation.set(0, ts * 2.5 + k, 0); dmA.scale.setScalar(o.got ? 0 : 1); dmA.updateMatrix(); coinMesh.setMatrixAt(k, dmA.matrix); }
  dmA.rotation.set(0, 0, 0); dmA.scale.setScalar(1); coinMesh.instanceMatrix.needsUpdate = true;
}

let rts = 0;
function render(ts) {
  prepare3d();
  const raw = ts - rts, dt = clamp(raw, 1 / 240, .05); rts = ts; autoQuality(raw);
  cars.forEach((c, k) => syncView(views[k], c, dt));
  animScene(ts); fxStep(dt);
  // Sol com sombras: segue o jogador (posição arredondada a 8 px para as sombras não tremerem)
  const sx = Math.round(player.x / 8) * 8, sz = Math.round(player.y / 8) * 8;
  sun.position.set(sx + SUN[0], SUN[1], sz + SUN[2]); sun.target.position.set(sx, 0, sz);
  // Câmera: perseguição atrás do carro (z menor ⇒ mais longe e FOV maior); tecla C = câmera alta, igual à vista 2D (up = −Z, sem espelhar)
  const z = cam.z, dx = Math.cos(cam.a), dy = Math.sin(cam.a);
  if (hiCam) {
    cam3.up.set(0, 0, -1); cam3.fov = 50; cam3.position.set(cam.x, innerHeight / z / 2 / Math.tan(25 * Math.PI / 180), cam.y); cam3.lookAt(cam.x, 0, cam.y);
    scene.fog.near = 9000; scene.fog.far = 12000;
  } else {
    cam3.up.set(0, 1, 0); cam3.fov = 56 + (1 / z - 1) * 26;
    cam3.position.set(cam.px - dx * 135 / z, 58 / z, cam.py - dy * 135 / z); cam3.lookAt(cam.x + dx * 50, 4, cam.y + dy * 50);
    scene.fog.near = 1500; scene.fog.far = 4300;
  }
  cam3.updateProjectionMatrix(); sky.position.copy(cam3.position); FXU.value = renderer.domElement.height / (2 * Math.tan(cam3.fov * Math.PI / 360));
  renderer.render(scene, cam3);
}

/* ---------- 8c. Efeitos visuais (só LEEM o estado dos carros: c.vx, c.vy, c.a, c.off, c.d, freio de mão) ----------
   Marcas de pneu (faixas num buffer circular), fumaça ao derrapar / usar o freio de mão, poeira fora da pista e faíscas ao bater no muro. Só perto do jogador (800 px) e só durante a corrida. */
const blobTex = new THREE.CanvasTexture(mkCv(64, 64, c => { const g = c.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.5, 'rgba(255,255,255,.5)'); g.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g; c.fillRect(0, 0, 64, 64); }));
const FXU = { value: 600 };                                        // pixels por unidade a 1 de distância (atualizado a cada quadro)
function mkParticles(n, blend, grav) {                             // pool circular de partículas (THREE.Points com shader próprio: tamanho e transparência por partícula)
  const g = new THREE.BufferGeometry(), P = new Float32Array(n * 3), S = new Float32Array(n), A = new Float32Array(n), C = new Float32Array(n * 3);
  const V = new Float32Array(n * 3), L = new Float32Array(n), L0 = new Float32Array(n), S0 = new Float32Array(n), GR = new Float32Array(n), A0 = new Float32Array(n); let h = 0;
  const at = [['position', P, 3], ['aSize', S, 1], ['aAlpha', A, 1], ['aCol', C, 3]].map(([k, a, m]) => { const b = new THREE.BufferAttribute(a, m); g.setAttribute(k, b); return b; });
  const m = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: blend, uniforms: { uTex: { value: blobTex }, uScale: FXU },
    vertexShader: 'attribute float aSize; attribute float aAlpha; attribute vec3 aCol; uniform float uScale; varying float vA; varying vec3 vC; void main(){ vA = aAlpha; vC = aCol; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = max(aSize * uScale / -mv.z, 0.0); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform sampler2D uTex; varying float vA; varying vec3 vC; void main(){ float a = texture2D(uTex, gl_PointCoord).a * vA; if (a < 0.003) discard; gl_FragColor = vec4(vC, a); }' });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 2;
  const dirty = () => at.forEach(b => b.needsUpdate = true);
  return { pts,
    emit(x, y, z, vx, vy, vz, life, size, grow, r, gg, b, a) {
      const i = h; h = (h + 1) % n; P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z; V[i * 3] = vx; V[i * 3 + 1] = vy; V[i * 3 + 2] = vz;
      L[i] = L0[i] = life; S0[i] = size; GR[i] = grow; A0[i] = a; C[i * 3] = r; C[i * 3 + 1] = gg; C[i * 3 + 2] = b;
    },
    step(dt) {
      for (let i = 0; i < n; i++) {
        if (L[i] > 0) { L[i] -= dt; const k = L[i] > 0 ? L[i] / L0[i] : 0; P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] = Math.max(0, P[i * 3 + 1] + V[i * 3 + 1] * dt); P[i * 3 + 2] += V[i * 3 + 2] * dt; V[i * 3 + 1] -= grav * dt; S[i] = S0[i] + GR[i] * (1 - k); A[i] = A0[i] * k; }
        else A[i] = 0;
      }
      dirty();
    },
    clear() { L.fill(0); A.fill(0); dirty(); } };
}
const smoke = mkParticles(260, THREE.NormalBlending, -6), sparks = mkParticles(200, THREE.AdditiveBlending, 380);
const SKN = 6000, skP = new Float32Array(SKN * 12), skG = new THREE.BufferGeometry(), skI = []; let skH = 0, skC = 0, skDirty = false;
for (let i = 0; i < SKN; i++) skI.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);
const skA = new THREE.BufferAttribute(skP, 3); skG.setAttribute('position', skA); skG.setIndex(skI); skG.setDrawRange(0, 0);
const skM = new THREE.Mesh(skG, layer(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .5, depthWrite: false, side: THREE.DoubleSide }), 5.5)); skM.frustumCulled = false; skM.renderOrder = 1;
scene.add(skM, smoke.pts, sparks.pts);
function skid(x0, z0, x1, z1) {                                    // um trecho de marca (faixa de 3 px) entre duas posições da roda
  const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz); if (l < .4 || l > 40) return;
  const nx = -dz / l * 1.5, nz = dx / l * 1.5; skP.set([x0 - nx, .21, z0 - nz, x0 + nx, .21, z0 + nz, x1 - nx, .21, z1 - nz, x1 + nx, .21, z1 + nz], skH * 12);
  skH = (skH + 1) % SKN; skC = Math.min(skC + 1, SKN); skG.setDrawRange(0, skC * 6); skDirty = true;
}
function fxReset() { skH = skC = 0; skG.setDrawRange(0, 0); smoke.clear(); sparks.clear(); }
const rr = (a, b) => a + Math.random() * (b - a);
function fxStep(dt) {
  const T = track, live = state === 'race';
  cars.forEach((c, k) => {
    const v = views[k], dx = c.x - player.x, dy = c.y - player.y;
    if (!live || dx * dx + dy * dy > 640000) { v.sk = null; return; }
    const co = Math.cos(c.a), si = Math.sin(c.a), vl = -c.vx * si + c.vy * co, sp = c.speed, hbk = c.pl && keys.Space && sp > 40 && !c.pit ? 1 : 0;
    const sl = Math.max(sp > 70 ? clamp((Math.abs(vl) - 45) / 60, 0, 1) : 0, hbk), dust = c.off && sp > 90 && !c.pit ? clamp(sp / 300, 0, 1) : 0;
    const wh = [-1, 1].map(s => [c.x + co * -11 - si * s * 10.5, c.y + si * -11 + co * s * 10.5]);          // rodas traseiras no mundo
    if (sl > .15 && !c.off && !c.pit) { if (v.sk) wh.forEach((w, i) => skid(v.sk[i][0], v.sk[i][1], w[0], w[1])); v.sk = wh; } else v.sk = null;
    v.fa = (v.fa || 0) + (sl > .15 ? sl * (hbk ? 70 : 45) : 0) * dt; v.fd = (v.fd || 0) + dust * 40 * dt;
    for (; v.fa >= 1; v.fa--) { const w = wh[Math.random() < .5 ? 0 : 1]; smoke.emit(w[0], 2, w[1], c.vx * .12 + rr(-5, 5), rr(6, 14), c.vy * .12 + rr(-5, 5), rr(.7, 1.2), 9, 26, .86, .86, .88, .5); }
    for (; v.fd >= 1; v.fd--) { const w = wh[Math.random() < .5 ? 0 : 1]; smoke.emit(w[0], 2, w[1], c.vx * .1 + rr(-10, 10), rr(8, 18), c.vy * .1 + rr(-10, 10), rr(.7, 1.2), 8, 22, .52, .47, .33, .45); }
    if (c.d >= T.bar - .01 && sp > 50) {                                                                 // bateu no muro: faíscas
      const p = T.pts[c.i], nx = (c.x - p.x) / c.d, ny = (c.y - p.y) / c.d; v.fs = (v.fs || 0) + 150 * dt;
      for (; v.fs >= 1; v.fs--) sparks.emit(c.x + nx * 8, 4, c.y + ny * 8, c.vx * .25 - nx * 40 + rr(-90, 90), rr(40, 160), c.vy * .25 - ny * 40 + rr(-90, 90), rr(.25, .55), 2.4, 0, 1, .72, .25, 1);
    }
  });
  smoke.step(dt); sparks.step(dt);
  if (skDirty) { skA.needsUpdate = true; skDirty = false; }
}

/* Qualidade adaptativa: se a média de quadros ficar abaixo de ~42 fps (depois de 240 quadros de aquecimento), baixa a resolução (DPR 1) e, se preciso, o mapa de sombras (1024) */
const Q = { n: 0, t: 0, w: 0, lvl: 0 };
function autoQuality(raw) {
  if (raw > .2) return; if (Q.w < 240) { Q.w++; return; }
  Q.t += raw; if (++Q.n < 120) return;
  const avg = Q.t / Q.n; Q.n = 0; Q.t = 0;
  if (avg > 1 / 42 && Q.lvl < 2) { Q.lvl++; if (Q.lvl === 1) { PR = 1; resize(); } else { sun.shadow.mapSize.set(1024, 1024); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } } }
}

/* Prévia 3D da Garagem: segundo renderer pequeno no canvas #prev (240×130), só desenha com a Garagem aberta; a cor muda ao vivo (materiais próprios, sem acumular cache) */
let prev3;
function initPrev() {
  try {
    ensureCars();
    const r = new THREE.WebGLRenderer({ canvas: $('prev'), antialias: true, alpha: true }), sc = new THREE.Scene(), cm = new THREE.PerspectiveCamera(28, 240 / 130, 10, 600), view = makeView(), mats = mkTeamMats(save.color);
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r.setSize(240, 130); r.toneMapping = THREE.ACESFilmicToneMapping; r.outputColorSpace = THREE.SRGBColorSpace;
    view.mc.material = mats.c; view.md.material = mats.d; view.ml.material = mats.l;
    const sl = new THREE.DirectionalLight(0xfff1d6, 2.4); sl.position.set(120, 200, 90);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(44, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .3 })); disc.position.y = .1;
    sc.add(view.g, disc, sl, new THREE.HemisphereLight(0xd6e8ff, 0xa4ad94, 1.7)); cm.position.set(0, 44, 112); cm.lookAt(0, 6, 0);
    return { r, sc, cm, view, mats };
  } catch (e) { return null; }
}
function renderPrev(ts) {
  if (!prev3 || !$('garage').classList.contains('on')) return;
  prev3.view.g.rotation.y = ts * .6; prev3.r.render(prev3.sc, prev3.cm);
}
function drawMini() { // minimapa: contorno pré-desenhado + todos os carros (jogador = seta amarela)
  const m = $('mini').getContext('2d'); m.clearRect(0, 0, 180, 180); m.drawImage(track.mini, 0, 0);
  for (const c of cars) if (!c.pl) { m.beginPath(); m.arc(c.x * track.ms + track.mx, c.y * track.ms + track.my, 3, 0, 7); m.fillStyle = c.col; m.fill(); m.lineWidth = 1; m.strokeStyle = '#000'; m.stroke(); }
  m.save(); m.translate(player.x * track.ms + track.mx, player.y * track.ms + track.my); m.rotate(player.a);
  m.beginPath(); m.moveTo(9, 0); m.lineTo(-6, -6); m.lineTo(-3, 0); m.lineTo(-6, 6); m.closePath();
  m.fillStyle = '#ffc300'; m.fill(); m.lineWidth = 2; m.strokeStyle = '#000'; m.stroke(); m.restore();
}
// Velocímetro (SVG 512×512): dígitos = km/h (zeros à esquerda em cinza); ponteiro 0–10 = velocidade ÷ (vmax·√1,6, o teto com nitro) × 10 — a zona vermelha 8–10 é o território do nitro e da esteira de ar;
// marcha no centro: D (verde) ou R (vermelho) em marcha à ré. Só LÊ o estado do jogador.
let needleV = 0;
function speedo() {
  const s = String(Math.min(Math.round(player.speed * .6), 999)).padStart(3, '0'), nz = s.search(/[1-9]/), lead = nz < 0 ? 3 : nz;
  $('spZ').textContent = s.slice(0, lead); $('spN').textContent = s.slice(lead);
  needleV += (clamp(player.speed / (player.max * Math.sqrt(NITRO_M)) * 10, 0, 10) - needleV) * .35;
  $('spNeedle').setAttribute('transform', `rotate(${(-121.7 + 20.4 * needleV).toFixed(1)} 245 265)`);
  const rev = player.vx * Math.cos(player.a) + player.vy * Math.sin(player.a) < -5, col = rev ? '#ff4040' : '#5dff80';
  $('spGear').textContent = rev ? 'R' : 'D'; $('spGear').setAttribute('fill', col); $('spRing').setAttribute('stroke', col);
}
function hud() {
  $('hPos').textContent = (ranking().indexOf(player) + 1) + '/' + GRID;
  $('hLap').textContent = `Volta ${Math.min(Math.max(player.lap, 0) + 1, cfg.laps)}/${cfg.laps}`;
  $('hTime').textContent = fmt(run.t); $('hCoins').textContent = run.coins + ' moedas';
  speedo();
  const gauge = (id, v) => { const el = $(id + 'Bar'); el.style.width = v * 100 + '%'; el.className = v < .25 ? 'lo' : v < .5 ? 'mid' : ''; $(id + 'Txt').textContent = Math.round(v * 100) + '%'; };
  gauge('fuel', player.fuel); gauge('tire', player.tire);
  const pit = player.pit, pm = $('pitMsg');
  const msg = pit ? (pit.ph === 'stop' ? `PIT STOP · ${Math.max(0, pit.t).toFixed(1)}s` : pit.ph === 'in' ? 'ENTRANDO NO BOX · limitador ativo' : 'SAÍDA DO PIT · limitador ativo')
    : player.owe ? 'PARADA OBRIGATÓRIA PENDENTE · ENTRE NO PIT PARA TERMINAR'
    : player.stops === 0 && player.lap >= cfg.laps - 1 ? 'PARADA OBRIGATÓRIA · ENTRE NO PIT'
    : player.fuel < .4 ? 'COMBUSTÍVEL BAIXO · ENTRE NO PIT' : player.tire < .4 ? 'PNEUS GASTOS · ENTRE NO PIT' : '';
  $('nitro').className = player.nitro ? 'on' : (player.fuel < .05 || player.pit ? 'no' : '');   // nitro ativo / indisponível
  pm.textContent = msg; pm.className = msg ? (pit ? 'on' : 'on warn') : '';
  drawMini();
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(.033, (now - last) / 1000); last = now;
  if (state === 'count') {
    cdown -= dt; setLights(cdown > 0 ? Math.min(5, Math.floor(cdTotal - cdown)) : 0);
    if (cdown <= 0) { state = 'race'; goT = 1.2; setLights(5); $('lights').classList.add('go'); $('count').textContent = 'VAI!'; }   // largada: todas as luzes ficam VERDES por 1,2 s
  } else if (state === 'race') {
    run.t += dt;
    for (let s = 0; s < 2 && state === 'race'; s++) update(dt / 2);    // 2 sub-passos por quadro: física e IA mais estáveis
    lapWatch();
    if (goT > 0 && (goT -= dt) <= 0) { $('count').textContent = ''; $('lights').classList.add('hide'); }
  }
  if (state === 'count' || state === 'race' || state === 'done') { updateCam(dt, state === 'count'); render(now / 1000); if (state !== 'done') hud(); }
  renderPrev(now / 1000);   // prévia 3D da garagem (só desenha com a Garagem aberta)
  requestAnimationFrame(loop);
}

/* ---------- 9. Menus ---------- */
function showScreen(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); if (id === 'menu') refreshStats(); }
function setLights(n) { document.querySelectorAll('#lights .lt').forEach((e, k) => e.classList.toggle('on', k < n)); }          // acende as n primeiras luzes do semáforo
const fmtLap = t => `${t / 60 | 0}:${(t % 60).toFixed(2).padStart(5, '0')}`;
function refreshStats() {   // tabelinha do menu: melhor volta em cada pista e total de moedas coletadas
  const s = save.stats || { pick: 0, laps: {} };
  $('stBody').innerHTML = TRACKS.map((T, k) => `<tr><td>${T.name}</td><td>${+s.laps[k] > 0 ? fmtLap(+s.laps[k]) : '--:--.--'}</td></tr>`).join('') + `<tr class="sum"><td>Moedas coletadas</td><td>${s.pick | 0}</td></tr>`;
}
// Volta rápida do jogador: tempo entre duas passagens consecutivas pela linha de largada (inclui voltas com pit stop); salva a melhor de cada pista
let lapRun = null, lapSeen = -1, lapT0 = 0;
function lapWatch() {
  if (lapRun !== run) { lapRun = run; lapSeen = player.lap; lapT0 = 0; run.best = 0; }
  if (player.lap === lapSeen) return;
  if (player.lap > lapSeen && lapSeen >= 0) { const lt = run.t - lapT0; if (lt > 8) { run.best = run.best ? Math.min(run.best, lt) : lt; const old = save.stats.laps[lastTrack]; if (!(old > 0) || lt < old) save.stats.laps[lastTrack] = lt; } }
  lapSeen = player.lap; lapT0 = run.t;
}
function refreshGarage() {
  $('gCoins').textContent = save.coins; $('color').value = save.color;
  for (const [k, id] of [['engine', 'E'], ['tires', 'T']]) {
    const l = save[k]; $('lv' + id).innerHTML = '<i></i>'.repeat(l) + '<u></u>'.repeat(MAXLV - l);
    const b = $('up' + id); b.textContent = l >= MAXLV ? 'Nível máximo' : `Melhorar · ${cost(l)} moedas`; b.disabled = l >= MAXLV || save.coins < cost(l);
  }
  drawPreview();
}
function drawPreview() {   // prévia da garagem: carro 3D girando, cor ao vivo; se o WebGL falhar, mantém o drawCar 2D original
  if (prev3 === undefined) prev3 = initPrev();
  if (prev3) { setTeam(prev3.mats, save.color); return; }
  const p = $('prev').getContext('2d'); p.clearRect(0, 0, 240, 130); drawCar(p, 120, 65, -.25, save.color, 3);
}
function buy(k) { const l = save[k]; if (l >= MAXLV || save.coins < cost(l)) return; save.coins -= cost(l); save[k]++; persist(); refreshGarage(); }
function markOpts() {
  document.querySelectorAll('[data-diff]').forEach(b => b.classList.toggle('sel', b.dataset.diff === cfg.diff));
  document.querySelectorAll('[data-laps]').forEach(b => b.classList.toggle('sel', +b.dataset.laps === cfg.laps));
}
document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.go === 'menu') toMenu();
  else if (b.dataset.go) { showScreen(b.dataset.go); if (b.dataset.go === 'garage') refreshGarage(); }
  else if (b.dataset.track !== undefined) startRace(+b.dataset.track);
  else if (b.dataset.diff) { cfg.diff = b.dataset.diff; markOpts(); }
  else if (b.dataset.laps) { cfg.laps = +b.dataset.laps; markOpts(); }
  else if (b.id === 'upE') buy('engine');
  else if (b.id === 'upT') buy('tires');
  else if (b.id === 'again') startRace(lastTrack);
  else if (b.id === 'reset' && confirm('Apagar moedas, melhorias, recordes e cor do carro?')) { save = fresh(); persist(); refreshGarage(); refreshStats(); }
});
$('color').addEventListener('input', e => { save.color = e.target.value; drawPreview(); });
$('color').addEventListener('change', persist);
markOpts(); loadSave(); requestAnimationFrame(loop);
