'use strict';
/* ============================================================
 * タイフーンドッジ
 * 年を選んで、その年の台風シーズン（気象庁ベストトラック実データ）
 * を日本列島を動かして生き延びるゲーム。オリジナル実装（MIT）。
 * ============================================================ */

// ---------- 画面座標系（メルカトル） ----------
const W = 420, H = 700;                 // 論理キャンバスサイズ
const LON_C = 160, LON_W = 120;         // 中心経度・表示経度幅
const LAT_C = 30;                       // 中心緯度
const merc = lat => {
  const r = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
};
const invMerc = y => Math.atan(Math.sinh(y)) * 180 / Math.PI;
const MERC_HALF = (H / W) * (LON_W * Math.PI / 180) / 2;
const LAT_TOP = invMerc(merc(LAT_C) + MERC_HALF);
const LAT_BOT = invMerc(merc(LAT_C) - MERC_HALF);
const wrapLon = lon => {
  while (lon < LON_C - 180) lon += 360;
  while (lon >= LON_C + 180) lon -= 360;
  return lon;
};
const X = lon => W / 2 + (wrapLon(lon) - LON_C) * (W / LON_W);
const Y = lat => (merc(LAT_TOP) - merc(lat)) / (merc(LAT_TOP) - merc(LAT_BOT)) * H;
const pxPerKm = lat => (Y(lat - 0.5) - Y(lat + 0.5)) / 110.6;

// ---------- ゲーム定数 ----------
const HOURS_PER_SEC = 24;               // 1秒 = 1日
const FF_MULT = 12;                     // 台風のいない期間の早送り倍率
const FF_GAP = 30;                      // 次の発生までこの時間以上空いたら早送り
const JAPAN_K = 1.6;                    // 日本列島の表示スケール
const JAPAN_SPEED = W * 0.23;           // px/s
const FORECAST_H = 24;                  // 予報円の先読み時間
const JP_HOME = { lon: 137.0, lat: 36.0 };

const radiusKm = p => Math.max(130, Math.min(700, (1010 - p) * 7 + 100));

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');
const hudEl = $('hud'), dateEl = $('date'), daysEl = $('days'), activeEl = $('active'), ffEl = $('ff');
const yearScreen = $('yearScreen'), yearGrid = $('yearGrid'), yearInfo = $('yearInfo');
const popup = $('popup'), ptitle = $('ptitle'), ptext = $('ptext');
const pbtnMain = $('pbtnMain'), pbtnSub = $('pbtnSub'), sharebtn = $('sharebtn');
const pad = $('pad'), knob = $('knob'), ticker = $('ticker');
const menubtn = $('menubtn'), menu = $('menu');

// ---------- 状態 ----------
let DPR = 1, SC = 1, TX = 0, TY = 0, VW = 0, VH = 0;
let mapData = null, yearIndex = null;
let landBodies = [];                    // 押しのけ可能な大陸
let jpRings = [], jpVerts = [];         // 日本列島（ローカル座標 + 経緯度）
const G = {
  screen: 'boot',   // boot | year | play | over | clear
  year: 0, storms: [], t: 0, tStart: 0, tEnd: 0,
  jp: { x: 0, y: 0 }, vx: 0, vy: 0,
  hit: null, closestKm: Infinity, overAt: 0,
  ff: false, lastTs: 0,
};

// ============================================================
// データ読み込み
// ============================================================
async function boot() {
  try {
    const [m, idx] = await Promise.all([
      fetch('data/map.json').then(r => r.json()),
      fetch('data/tracks/index.json').then(r => r.json()),
    ]);
    mapData = m; yearIndex = idx.years;
    buildLand(); buildJapan();
    buildYearGrid();
    G.screen = 'year';
  } catch (e) {
    yearGrid.innerHTML = '<p class="loading">データの読み込みに失敗しました。再読み込みしてください。</p>';
    console.error(e);
  }
  resize();
  requestAnimationFrame(loop);
}

// ---------- 地図の構築 ----------
function buildLand() {
  landBodies = [];
  for (const poly of mapData.land) {
    const path = new Path2D();
    const outers = [];
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    poly.forEach((ring, ri) => {
      let prev = null, started = false, cur = [];
      for (const c of ring) {
        const lon = wrapLon(c[0]), x = X(lon), y = Y(c[1]);
        if (!started || (prev !== null && Math.abs(lon - prev) > 180)) {
          if (started) path.closePath();
          path.moveTo(x, y); started = true;
          if (ri === 0) { cur = []; outers.push(cur); }
        } else path.lineTo(x, y);
        prev = lon;
        if (ri === 0) {
          cur.push([x, y]);
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      path.closePath();
    });
    landBodies.push({ path, outers: outers.filter(r => r.length > 2), minX, minY, maxX, maxY, ox: 0, oy: 0, vx: 0, vy: 0 });
  }
}

function buildJapan() {
  jpRings = []; jpVerts = [];
  const cx = X(JP_HOME.lon), cy = Y(JP_HOME.lat);
  for (const poly of mapData.japan) {
    for (const ring of poly) {
      const out = ring.map(c => {
        const p = [(X(c[0]) - cx) * JAPAN_K, (Y(c[1]) - cy) * JAPAN_K, c[0], c[1]];
        jpVerts.push(p);
        return p;
      });
      jpRings.push(out);
    }
  }
}

// ---------- 年選択 ----------
function buildYearGrid() {
  yearGrid.innerHTML = '';
  for (const y of yearIndex) {
    const b = document.createElement('button');
    b.innerHTML = `${y.y}<small>${y.n}個${y.named.length ? ' ★' : ''}</small>`;
    if (y.named.length) {
      b.classList.add('named');
      b.title = y.named.join('・');
    }
    b.onclick = () => startYear(y.y);
    yearGrid.appendChild(b);
  }
}

// ============================================================
// ゲーム開始・終了
// ============================================================
async function startYear(year) {
  yearInfo.classList.remove('hidden');
  yearInfo.textContent = `${year}年のデータを読み込み中…`;
  let data;
  try {
    data = await fetch(`data/tracks/${year}.json`).then(r => r.json());
  } catch (e) {
    yearInfo.textContent = '読み込みに失敗しました。別の年を選んでください。';
    return;
  }
  for (const b of landBodies) { b.ox = b.oy = b.vx = b.vy = 0; }
  G.year = year;
  G.storms = data.storms;
  const t0 = Math.min(...data.storms.map(s => s.pts[0][0]));
  const t1 = Math.max(...data.storms.map(s => s.pts[s.pts.length - 1][0]));
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  G.t = Math.max(0, t0 - 72);
  G.tStart = G.t;
  G.tEnd = Math.min(t1 + 24, (leap ? 8784 : 8760) - 1);
  G.jp = { x: X(JP_HOME.lon), y: Y(JP_HOME.lat) };
  G.vx = G.vy = 0;
  G.hit = null; G.closestKm = Infinity;
  G.ff = false;
  for (const s of G.storms) { s._gen = false; s._gone = false; }
  ticker.innerHTML = ''; updateRows();
  yearScreen.classList.add('hidden');
  popup.classList.add('hidden');
  hudEl.classList.remove('hidden');
  pad.classList.remove('hidden');
  G.screen = 'play';
  const named = data.storms.filter(s => s.jp).map(s => s.jp);
  news(`${year}年の台風シーズンが始まります（対象 ${data.storms.length} 個）`, 'blue', '開始');
  if (named.length) news(`この年には「${named.join('」「')}」が記録されています`, 'yellow', '注目');
}

function gameOver(storm, pos, vert) {
  G.screen = 'over';
  G.hit = { storm, region: regionOf(vert[2], vert[3]) };
  G.overAt = performance.now();
  releaseStick();
  news(`台風${storm.num}号が${G.hit.region}に上陸しました`, 'red', '上陸');
  setTimeout(showOverPopup, 1400);
}

function clearGame() {
  G.screen = 'clear';
  releaseStick();
  showPopup(
    `${G.year}年 クリア！`,
    `台風シーズンを生き延びました。\n` +
    `対象台風: ${G.storms.length}個\n` +
    `最接近: ${G.closestKm === Infinity ? '---' : Math.max(0, Math.round(G.closestKm)) + 'km'}\n` +
    `${G.storms.some(s => s.jp) ? '命名台風の年を制覇！' : ''}`,
    'もう一度遊ぶ', () => startYear(G.year), true
  );
}

function showOverPopup() {
  if (G.screen !== 'over') return;
  const s = G.hit.storm;
  const name = s.jp ? `${s.jp}（${s.name || ''}）` : (s.name ? `（${s.name}）` : '');
  showPopup(
    fmtDate(G.t),
    `台風${s.num}号${name}が\n${G.hit.region}に上陸しました。\n` +
    `記録: ${Math.floor((G.t - G.tStart) / 24) + 1}日間生存 / 全${G.storms.length}個中${G.storms.filter(x => x._gen).length}個が発生済み`,
    'もう一度挑戦', () => startYear(G.year), true
  );
}

function showPopup(title, text, mainLabel, mainFn, shareable) {
  ptitle.textContent = title;
  ptext.textContent = text;
  pbtnMain.textContent = mainLabel;
  pbtnMain.onclick = mainFn;
  pbtnSub.textContent = '年を選ぶ';
  pbtnSub.onclick = backToYears;
  sharebtn.classList.toggle('hidden', !shareable);
  popup.classList.remove('hidden');
}

function backToYears() {
  G.screen = 'year';
  popup.classList.add('hidden');
  hudEl.classList.add('hidden');
  pad.classList.add('hidden');
  menu.classList.remove('open');
  yearInfo.classList.add('hidden');
  yearScreen.classList.remove('hidden');
}

// ============================================================
// 台風の状態
// ============================================================
function posAt(s, t) {
  const pts = s.pts;
  if (t < pts[0][0] || t > pts[pts.length - 1][0]) return null;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; (pts[m][0] <= t) ? lo = m : hi = m; }
  const a = pts[lo], b = pts[hi];
  const f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
  return {
    lon: (a[2] + (b[2] - a[2]) * f) / 10,
    lat: (a[1] + (b[1] - a[1]) * f) / 10,
    p: a[3] + (b[3] - a[3]) * f,
  };
}

const stormName = s => s.jp ? `${s.jp}` : (s.name ? `${s.name}` : '');

function regionOf(lon, lat) {
  if (lat >= 41.4) return '北海道';
  if (lat < 30.8) return '南西諸島';
  if (lon >= 140.9 && lat >= 36.9) return '東北地方';
  if (lon >= 138.9 && lat >= 34.6) return '関東地方';
  if (lon >= 132.3 && lon <= 134.9 && lat >= 32.6 && lat < 34.7) return '四国地方';
  if (lon >= 136.8) return '中部地方';
  if (lon >= 134.0) return '近畿地方';
  if (lon >= 130.9 && lat >= 34.0) return '中国地方';
  return '九州地方';
}

// ============================================================
// 更新
// ============================================================
function update(dt) {
  // --- 時間進行（いない期間は早送り） ---
  let anyActive = false, nextGen = Infinity;
  for (const s of G.storms) {
    const t0 = s.pts[0][0], t1 = s.pts[s.pts.length - 1][0];
    if (G.t >= t0 && G.t <= t1) anyActive = true;
    if (t0 > G.t && t0 < nextGen) nextGen = t0;
  }
  G.ff = !anyActive && (nextGen - G.t > FF_GAP);
  G.t += HOURS_PER_SEC * (G.ff ? FF_MULT : 1) * dt;

  if (G.t >= G.tEnd) { clearGame(); return; }

  // --- 日本列島の移動 ---
  G.jp.x = Math.max(24, Math.min(W - 24, G.jp.x + G.vx * JAPAN_SPEED * dt));
  G.jp.y = Math.max(24, Math.min(H - 24, G.jp.y + G.vy * JAPAN_SPEED * dt));

  pushLand(dt);
  slideLand(dt);

  // --- イベント＆衝突 ---
  let activeCount = 0;
  for (const s of G.storms) {
    const t0 = s.pts[0][0], t1 = s.pts[s.pts.length - 1][0];
    if (!s._gen && G.t >= t0) {
      s._gen = true;
      const nm = stormName(s);
      news(`台風${s.num}号${nm ? `（${nm}）` : ''}が発生しました`, 'red', '発生');
    }
    if (!s._gone && G.t > t1) {
      s._gone = true;
      if (s._gen) news(`台風${s.num}号は消滅しました`, 'yellow', '消滅');
    }
    const pos = posAt(s, G.t);
    if (!pos) continue;
    const sx = X(pos.lon), sy = Y(pos.lat);
    if (sx < -90 || sx > W + 90 || sy < -90 || sy > H + 90) continue;
    activeCount++;
    const core = Math.max(6, radiusKm(pos.p) * pxPerKm(pos.lat)) * 0.5;
    for (const v of jpVerts) {
      const dx = G.jp.x + v[0] - sx, dy = G.jp.y + v[1] - sy;
      const d = Math.hypot(dx, dy);
      const gapKm = d / pxPerKm(pos.lat) - core / pxPerKm(pos.lat);
      if (gapKm < G.closestKm) G.closestKm = gapKm;
      if (d < core) { gameOver(s, pos, v); return; }
    }
  }
  G.activeCount = activeCount;
}

// ---------- 大陸の押しのけ ----------
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pushLand(dt) {
  for (const B of landBodies) {
    if (G.jp.x + 130 < B.minX + B.ox || G.jp.x - 130 > B.maxX + B.ox ||
        G.jp.y + 130 < B.minY + B.oy || G.jp.y - 130 > B.maxY + B.oy) continue;
    let sx = 0, sy = 0, n = 0;
    for (const v of jpVerts) {
      const qx = G.jp.x + v[0] - B.ox, qy = G.jp.y + v[1] - B.oy;
      if (qx < B.minX || qx > B.maxX || qy < B.minY || qy > B.maxY) continue;
      for (const ring of B.outers) {
        if (pointInRing(qx, qy, ring)) { sx += v[0]; sy += v[1]; n++; break; }
      }
    }
    if (n) {
      const d = Math.hypot(sx, sy) || 1;
      B.vx = sx / d * JAPAN_SPEED; B.vy = sy / d * JAPAN_SPEED;
    }
  }
}

function slideLand(dt) {
  const k = Math.pow(0.12, dt);
  for (const B of landBodies) {
    if (!B.vx && !B.vy) continue;
    B.ox += B.vx * dt; B.oy += B.vy * dt;
    B.vx *= k; B.vy *= k;
    if (Math.abs(B.vx) < 0.5 && Math.abs(B.vy) < 0.5) B.vx = B.vy = 0;
  }
}

// ============================================================
// 描画
// ============================================================
function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#0d1c38'; ctx.fillRect(0, 0, VW, VH);
  ctx.setTransform(DPR * SC, 0, 0, DPR * SC, TX * DPR, TY * DPR);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  ctx.fillStyle = '#16305b'; ctx.fillRect(0, 0, W, H);

  // 大陸
  ctx.fillStyle = '#46655a'; ctx.strokeStyle = '#7c9a86'; ctx.lineWidth = 0.7;
  for (const B of landBodies) {
    ctx.save(); ctx.translate(B.ox, B.oy);
    ctx.fill(B.path); ctx.stroke(B.path);
    ctx.restore();
  }

  // 日本列島
  ctx.save();
  ctx.translate(G.jp.x, G.jp.y);
  ctx.fillStyle = '#8fbf7f'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2;
  for (const ring of jpRings) {
    ctx.beginPath();
    ring.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();

  // 台風
  if (G.screen === 'play' || G.screen === 'over') {
    for (const s of G.storms) drawStorm(s);
  }
  ctx.restore();
}

function drawStorm(s) {
  const pos = posAt(s, G.t);
  if (!pos) return;
  const cx = X(pos.lon), cy = Y(pos.lat);
  if (cx < -120 || cx > W + 120 || cy < -120 || cy > H + 120) return;
  const ppk = pxPerKm(pos.lat);
  const r = Math.max(6, radiusKm(pos.p) * ppk);
  const core = r * 0.5;

  // 実績トラック（過去）
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.4; ctx.setLineDash([]);
  ctx.beginPath();
  let started = false;
  for (const p of s.pts) {
    if (p[0] > G.t) break;
    const x = X(p[2] / 10), y = Y(p[1] / 10);
    started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    started = true;
  }
  if (started) { ctx.lineTo(cx, cy); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (const p of s.pts) {
    if (p[0] > G.t) break;
    ctx.beginPath(); ctx.arc(X(p[2] / 10), Y(p[1] / 10), 2.2, 0, Math.PI * 2); ctx.fill();
  }

  // 24時間予報
  const fpos = posAt(s, Math.min(G.t + FORECAST_H, s.pts[s.pts.length - 1][0]));
  if (fpos) {
    const fx = X(fpos.lon), fy = Y(fpos.lat);
    const fr = Math.max(6, radiusKm(fpos.p) * pxPerKm(fpos.lat)) * 0.55;
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(240,70,80,0.65)'; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.arc(fx, fy, fr * 1.8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(fx, fy, 2.2, 0, Math.PI * 2); ctx.fill();
  }

  // 本体（外側=強風域、内側=核心）
  ctx.fillStyle = 'rgba(255,224,0,0.32)'; ctx.strokeStyle = '#ffe000'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(230,30,45,0.7)'; ctx.strokeStyle = '#e61e2d';
  ctx.beginPath(); ctx.arc(cx, cy, core, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // 渦巻き
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2;
  const rot = G.t * 1.5;
  for (let k = 0; k < 3; k++) {
    const a0 = rot + k * (Math.PI * 2 / 3);
    ctx.beginPath();
    ctx.arc(cx, cy, core * 0.62, a0, a0 + 1.5);
    ctx.stroke();
  }

  // 番号ラベル
  ctx.fillStyle = '#fff'; ctx.font = '600 11px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(`${s.num}号`, cx, cy - r - 5);
}

// ============================================================
// メインループ
// ============================================================
function loop(ts) {
  const dt = Math.min(0.05, (ts - (G.lastTs || ts)) / 1000);
  G.lastTs = ts;
  if (G.screen === 'play') {
    update(dt);
    updateHud();
  } else if (G.screen === 'over') {
    // ヒット後はスローで時間を流す
    for (const s of G.storms) { /* 位置はposAtが時刻から決まるので時刻だけ進める */ }
    G.t += HOURS_PER_SEC * 0.25 * dt;
    slideLand(dt);
  }
  draw();
  requestAnimationFrame(loop);
}

function updateHud() {
  dateEl.textContent = fmtDate(G.t);
  daysEl.textContent = `${Math.floor((G.t - G.tStart) / 24) + 1}日目`;
  activeEl.textContent = `台風 ${G.activeCount || 0}個`;
  ffEl.classList.toggle('hidden', !G.ff);
  document.documentElement.style.setProperty('--rows', ticker.children.length);
}

function fmtDate(tHour) {
  const d = new Date(G.year, 0, 1);
  d.setTime(d.getTime() + (tHour + 9) * 3600 * 1000); // 表示はJST
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// ============================================================
// ティッカー
// ============================================================
function updateRows() {
  document.documentElement.style.setProperty('--rows', ticker.children.length);
}
function news(msg, color, tag) {
  const row = document.createElement('div');
  row.className = 'row ' + color;
  row.innerHTML = `<div class="tag">${tag}</div><div class="track"><div class="ttext"></div></div>`;
  const tt = row.querySelector('.ttext'), tr = row.querySelector('.track');
  tt.textContent = msg;
  ticker.appendChild(row); updateRows();
  requestAnimationFrame(() => {
    const dist = tr.clientWidth + tt.offsetWidth;
    tt.style.setProperty('--dist', -dist + 'px');
    tt.style.animationDuration = (dist / 260) + 's';
  });
  tt.addEventListener('animationend', () => { row.remove(); updateRows(); });
  while (ticker.children.length > 3) ticker.firstChild.remove();
}

// ============================================================
// 入力（ドラッグ／仮想スティック／キーボード）
// ============================================================
let stickOn = false, stickId = null, anchorX = 0, anchorY = 0;
const KNOB_C = 44, KNOB_R = 44;

function setStick(ex, ey) {
  let dx = ex - anchorX, dy = ey - anchorY;
  const d = Math.hypot(dx, dy);
  if (d > KNOB_R) { dx = dx / d * KNOB_R; dy = dy / d * KNOB_R; }
  G.vx = dx / KNOB_R; G.vy = dy / KNOB_R;
  knob.style.left = (KNOB_C + dx) + 'px';
  knob.style.top = (KNOB_C + dy) + 'px';
}
function releaseStick() {
  stickOn = false; stickId = null; G.vx = G.vy = 0;
  knob.style.left = KNOB_C + 'px'; knob.style.top = KNOB_C + 'px';
}

const wrapEl = $('wrap');
wrapEl.addEventListener('pointerdown', e => {
  if (G.screen !== 'play' && G.screen !== 'over') return;
  if (e.target.closest('#ticker, #popup, #menubtn, #menu, #yearScreen')) return;
  if (stickOn) return;
  stickOn = true; stickId = e.pointerId;
  wrapEl.setPointerCapture(e.pointerId);
  const padHit = e.target.closest('#pad');
  if (padHit) {
    const r = pad.getBoundingClientRect();
    anchorX = r.left + r.width / 2; anchorY = r.top + r.height / 2;
  } else {
    anchorX = e.clientX; anchorY = e.clientY;
  }
  setStick(e.clientX, e.clientY);
  e.preventDefault();
});
wrapEl.addEventListener('pointermove', e => { if (stickOn && e.pointerId === stickId) setStick(e.clientX, e.clientY); });
wrapEl.addEventListener('pointerup', e => { if (e.pointerId === stickId) releaseStick(); });
wrapEl.addEventListener('pointercancel', e => { if (e.pointerId === stickId) releaseStick(); });

const keys = {};
function keyVel() {
  G.vx = (keys.ArrowRight || keys.d ? 1 : 0) - (keys.ArrowLeft || keys.a ? 1 : 0);
  G.vy = (keys.ArrowDown || keys.s ? 1 : 0) - (keys.ArrowUp || keys.w ? 1 : 0);
}
window.addEventListener('keydown', e => {
  if (G.screen !== 'play') return;
  keys[e.key] = true; keyVel();
});
window.addEventListener('keyup', e => { keys[e.key] = false; keyVel(); });

// ============================================================
// 共有・メニュー・リサイズ
// ============================================================
sharebtn.onclick = () => {
  const days = Math.floor((G.t - G.tStart) / 24) + 1;
  let text;
  if (G.screen === 'clear') {
    text = `【タイフーンドッジ】${G.year}年の台風シーズン（全${G.storms.length}個）を生き延びました！最接近 ${Math.max(0, Math.round(G.closestKm))}km`;
  } else if (G.hit) {
    const s = G.hit.storm;
    const nm = s.jp ? `（${s.jp}）` : (s.name ? `（${s.name}）` : '');
    text = `【タイフーンドッジ】${G.year}年${fmtDate(G.t).replace(`${G.year}年`, '')}、台風${s.num}号${nm}が${G.hit.region}に上陸。${days}日間生き延びました。`;
  } else return;
  text += `\n\n#タイフーンドッジ\n${location.href}`;
  window.open('https://x.com/intent/post?text=' + encodeURIComponent(text), '_blank');
};

menubtn.onclick = () => menu.classList.add('open');
$('menuclose').onclick = () => menu.classList.remove('open');
$('menuYearBtn').onclick = backToYears;

function resize() {
  DPR = window.devicePixelRatio || 1;
  VW = window.innerWidth; VH = window.innerHeight;
  cv.width = VW * DPR; cv.height = VH * DPR;
  SC = Math.min(VW / W, VH / H);
  TX = (VW - W * SC) / 2; TY = (VH - H * SC) / 2;
}
window.addEventListener('resize', resize);

boot();
