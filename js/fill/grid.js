/* =========================================================================
 * Yang-analyze web — fill/grid.js
 * 掃描頁表格結構偵測（純邏輯，不碰 DOM，Node 可測）。
 * 輸入二值影像 Bitmap {width,height,data: Uint8Array(1=墨,0=紙)}：
 *   1. 找出水平／垂直格線（容許 ≤3px 斷點、±1px 帶狀容許輕微歪斜），
 *      同列斷線橋接、T 字／轉角缺口延伸補齊 → 線遮罩；
 *   2. 線段各向外擴成「牆」，以列段（run）連通標記非牆像素：
 *      被牆包圍、不碰影像邊、夠大的區塊即為儲存格（天然處理合併儲存格）；
 *   3. 從每格最外側往四方向穿牆量測（多點取樣取最薄處，避開 T 字交會），
 *      同時得知牆另一側的鄰格 → 依相鄰關係分組成表格（相鄰但不相連的表格不會誤併；
 *      格內印章／小框視為巢狀而略過；小而墨點密集者視為印章剔除）；
 *   4. 由水平線投影估計歪斜角，校正後把牆中心分群成欄／列邊界 → 邏輯跨欄跨列。
 * 另提供：cellInk（格內去線墨跡框）、textLines（表格外文字列切割）、deskewAngle。
 * 全部使用 TypedArray 與列段運算，A4 200dpi 一頁約 30–100 ms（Node）。
 * 座標一律為像素、bbox 為含端點 {x0,y0,x1,y1}。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  var BIT_H = 1, BIT_V = 2;

  /* ---------------- 基本工具 ---------------- */
  function mm(v, dpi) { return v * dpi / 25.4; }

  /** 檢查 Bitmap；資料若不是 0/1 則轉成 0/1 副本 */
  function checkBitmap(bin) {
    if (!bin || !(bin.width >= 0) || !(bin.height >= 0) || !bin.data) {
      throw new Error("grid：輸入必須是 Bitmap {width, height, data}");
    }
    var w = bin.width | 0, h = bin.height | 0, n = w * h, d = bin.data;
    if (d.length < n) throw new Error("grid：Bitmap 資料長度不足（" + d.length + " < " + n + "）");
    var ok = d instanceof Uint8Array;
    if (ok) { for (var i = 0; i < n; i++) if (d[i] > 1) { ok = false; break; } }
    if (!ok) {
      var c = new Uint8Array(n);
      for (var j = 0; j < n; j++) c[j] = d[j] ? 1 : 0;
      d = c;
    }
    return { width: w, height: h, data: d };
  }

  /** 未給 dpi 時，由 A4/Letter 頁面尺寸推估；否則 200 */
  function guessDpi(w, h, opts) {
    if (opts && opts.dpi > 0) return +opts.dpi;
    var L = Math.max(w, h), S = Math.min(w, h);
    if (L >= 1500 && S > 0) {
      var ar = L / S;
      if (Math.abs(ar - 297 / 210) < 0.05) return L / (297 / 25.4);
      if (Math.abs(ar - 11 / 8.5) < 0.04) return L / 11;
    }
    return 200;
  }

  /** 依解析度換算各門檻（可由 opts 覆寫） */
  function params(w, h, opts) {
    opts = opts || {};
    var dpi = guessDpi(w, h, opts), k = dpi / 200;
    var P = {
      dpi: dpi,
      // 水平線最短長度 ≈ 頁寬 3.5%（限 6–9 mm 之間）；垂直線最短 ≈ 4.5 mm
      minH: Math.round(Math.max(mm(6, dpi), Math.min(0.035 * w, mm(9, dpi)))),
      minV: Math.round(mm(4.5, dpi)),
      gap: Math.max(2, Math.round(3 * k)),           // 線段內容許的斷點
      band: 1,                                       // ±1 列/欄帶狀容許（歪斜）
      cover: 0.2,                                    // 本列墨點至少佔段長 20%
      frag: Math.max(6, Math.round(12 * k)),        // 本列墨點平均每 frag px 多於 1 段 → 網點底紋，不是線
      bridge: Math.round(mm(1.6, dpi)),              // 同列兩段線之間 ≤ 此距離即補齊
      ext: Math.max(3, Math.round(mm(0.9, dpi))),    // 線端延伸找垂直線（T 字/轉角缺口）
      dil: Math.max(1, Math.round(2 * k)),           // 牆膨脹半徑
      minCell: Math.max(6, Math.round(mm(1.5, dpi))),// 儲存格內部最小寬高
      tol: Math.max(3, Math.round(mm(1.4, dpi))),    // 邊界分群容許
      maxWall: Math.max(12, Math.round(mm(6, dpi)))  // 量測牆厚時最多走這麼遠
    };
    ["minH", "minV", "gap", "band", "cover", "frag", "bridge", "ext", "dil", "minCell", "tol", "maxWall"].forEach(function (key) {
      if (opts[key] != null && isFinite(opts[key])) P[key] = +opts[key];
    });
    return P;
  }

  /* 可成長的 Int32 陣列 */
  function IntList(cap) { this.a = new Int32Array(Math.max(16, cap | 0)); this.n = 0; }
  IntList.prototype.push = function (v) {
    if (this.n >= this.a.length) { var b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  };

  /* ---------------- 1. 格線偵測 ---------------- */
  /** 墨點列段（每列連續墨點）；以 32 位元字組快速跳過空白 */
  function inkRuns(d, w, h) {
    var rs = new IntList(h * 8 + 64), re = new IntList(h * 8 + 64), rowStart = new Int32Array(h + 1);
    var d32 = (d.byteOffset & 3) === 0 ? new Uint32Array(d.buffer, d.byteOffset, d.length >> 2) : null;
    for (var y = 0; y < h; y++) {
      rowStart[y] = rs.n;
      var off = y * w, x = 0;
      while (x < w) {
        if (d32) {
          var p = off + x;
          while ((p & 3) === 0 && x + 4 <= w && d32[p >> 2] === 0) { x += 4; p += 4; }
          if (x >= w) break;
        }
        if (!d[off + x]) { x++; continue; }
        var s = x;
        while (x < w && d[off + x]) x++;
        rs.push(s); re.push(x - 1);
      }
    }
    rowStart[h] = rs.n;
    return { s: rs.a, e: re.a, n: rs.n, rowStart: rowStart, w: w, h: h };
  }

  /**
   * 回傳 {mask, h:{y,s,e,n}, v:{x,s,e,n}, rects}
   *  mask：墨點中屬於線者（bit1=水平、bit2=垂直）
   *  rects：牆的種子矩形 [x0,y0,x1,y1,...]（線段全長＋橋接＋端點延伸），之後膨脹成牆
   */
  function findLines(img, P, wantV) {
    var w = img.width, h = img.height, d = img.data;
    var RI = inkRuns(d, w, h), RS = RI.s, RE = RI.e, RW0 = RI.rowStart;
    var mask = new Uint8Array(w * h);
    var gap = P.gap, band = P.band, minH = P.minH, minV = P.minV, cover = P.cover;
    var hy = new IntList(1024), hs = new IntList(1024), he = new IntList(1024);
    var y, x, i, k, p, e, off;

    // 網點底紋（半色調）也會串成長段：其本列墨點碎成許多小段。真正的線（含歪斜、輕微斷線）
    // 本列墨段很少，故要求「平均每 frag 像素至多 1 段」。
    var frag = P.frag;

    // 水平線：y-band..y+band 三列墨段聯集（多路合併），斷點 ≤ gap 視為連續；本列墨點覆蓋率 ≥ cover
    var nb = 2 * band + 1, ptr = new Int32Array(nb), end = new Int32Array(nb);
    for (y = 0; y < h; y++) {
      var nl = 0;
      for (k = -band; k <= band; k++) {
        var yy = y + k;
        if (yy < 0 || yy >= h) continue;
        ptr[nl] = RW0[yy]; end[nl] = RW0[yy + 1]; nl++;
      }
      var cs = -1, ce = -2;
      for (;;) {
        var bi = -1, bs = 0;
        for (k = 0; k < nl; k++) if (ptr[k] < end[k] && (bi < 0 || RS[ptr[k]] < bs)) { bi = k; bs = RS[ptr[k]]; }
        if (bi >= 0 && cs >= 0 && bs - ce - 1 <= gap) {
          if (RE[ptr[bi]] > ce) ce = RE[ptr[bi]];
          ptr[bi]++;
          continue;
        }
        if (cs >= 0 && ce - cs + 1 >= minH) {
          // 本列覆蓋率與碎段數
          var own = 0, pieces = 0, j0 = RW0[y], j1 = RW0[y + 1];
          for (var j = j0; j < j1; j++) {
            if (RE[j] < cs) continue;
            if (RS[j] > ce) break;
            own += Math.min(RE[j], ce) - Math.max(RS[j], cs) + 1;
            pieces++;
          }
          var len = ce - cs + 1;
          if (own >= len * cover && !(frag > 0 && pieces * frag > len)) { hy.push(y); hs.push(cs); he.push(ce); }
        }
        if (bi < 0) break;
        cs = bs; ce = RE[ptr[bi]]; ptr[bi]++;
      }
    }

    // 垂直線：逐列處理墨段，每欄維持「目前段」狀態（只碰墨點附近的欄）
    var vx = new IntList(1024), vs = new IntList(1024), ve = new IntList(1024);
    if (wantV !== false) {
      var st = new Int32Array(w).fill(-1), lastY = new Int32Array(w), ownC = new Int32Array(w), ownN = new Int32Array(w);
      var ownLast = new Int32Array(w).fill(-2);
      var seen = new Int32Array(w).fill(-1);
      for (y = 0; y < h; y++) {
        var a0 = RW0[y], a1 = RW0[y + 1];
        for (i = a0; i < a1; i++) {
          var xa = RS[i] - band, xb = RE[i] + band;
          if (xa < 0) xa = 0;
          if (xb >= w) xb = w - 1;
          for (x = xa; x <= xb; x++) {
            if (seen[x] === y) continue;
            seen[x] = y;
            if (st[x] >= 0 && y - lastY[x] - 1 > gap) {
              var L0 = lastY[x] - st[x] + 1;
              if (L0 >= minV && ownC[x] >= L0 * cover && !(frag > 0 && ownN[x] * frag > L0)) { vx.push(x); vs.push(st[x]); ve.push(lastY[x]); }
              st[x] = -1;
            }
            if (st[x] < 0) { st[x] = y; ownC[x] = 0; ownN[x] = 0; }
            lastY[x] = y;
          }
        }
        for (i = a0; i < a1; i++) for (x = RS[i]; x <= RE[i]; x++) {
          ownC[x]++;
          if (ownLast[x] !== y - 1) ownN[x]++;       // 本欄新的一段墨點
          ownLast[x] = y;
        }
      }
      for (x = 0; x < w; x++) {
        if (st[x] < 0) continue;
        var L1 = lastY[x] - st[x] + 1;
        if (L1 >= minV && ownC[x] >= L1 * cover && !(frag > 0 && ownN[x] * frag > L1)) { vx.push(x); vs.push(st[x]); ve.push(lastY[x]); }
      }
    }
    // 垂直段依 (x, s) 排序
    var nv = vx.n, ord = new Array(nv);
    for (i = 0; i < nv; i++) ord[i] = i;
    ord.sort(function (a, b) { return (vx.a[a] - vx.a[b]) || (vs.a[a] - vs.a[b]); });
    var VX = new Int32Array(nv), VS = new Int32Array(nv), VE = new Int32Array(nv);
    for (i = 0; i < nv; i++) { VX[i] = vx.a[ord[i]]; VS[i] = vs.a[ord[i]]; VE[i] = ve.a[ord[i]]; }
    var HY = hy.a.subarray(0, hy.n), HS = hs.a.subarray(0, hy.n), HE = he.a.subarray(0, hy.n), nh = hy.n;

    // 遮罩：只標線段內的墨點
    for (i = 0; i < nh; i++) {
      off = HY[i] * w; e = off + HE[i];
      for (p = off + HS[i]; p <= e; p++) if (d[p]) mask[p] |= BIT_H;
    }
    for (i = 0; i < nv; i++) {
      x = VX[i]; e = VE[i];
      for (y = VS[i]; y <= e; y++) { p = y * w + x; if (d[p]) mask[p] |= BIT_V; }
    }

    var rects = new IntList((nh + nv) * 4 + 64);
    function rect(x0, y0, x1, y1) { rects.push(x0); rects.push(y0); rects.push(x1); rects.push(y1); }
    for (i = 0; i < nh; i++) rect(HS[i], HY[i], HE[i], HY[i]);
    for (i = 0; i < nv; i++) rect(VX[i], VS[i], VX[i], VE[i]);

    // 同列（同欄）相鄰兩段距離 ≤ bridge → 補齊（斷線）
    var br = P.bridge;
    for (i = 1; i < nh; i++) {
      if (HY[i] === HY[i - 1] && HS[i] - HE[i - 1] - 1 <= br && HS[i] > HE[i - 1] + 1) rect(HE[i - 1] + 1, HY[i], HS[i] - 1, HY[i]);
    }
    for (i = 1; i < nv; i++) {
      if (VX[i] === VX[i - 1] && VS[i] - VE[i - 1] - 1 <= br && VS[i] > VE[i - 1] + 1) rect(VX[i], VE[i - 1] + 1, VX[i], VS[i] - 1);
    }

    // 線端延伸：端點外 ext 內（含上下 ext）有垂直線 → 延伸至該處（T 字、轉角缺口）
    var ext = P.ext;
    // 在 [xa,xb]×[ya,yb] 內是否有垂直段（VX 已排序）
    function hasV(xa, xb, ya, yb) {
      var lo = 0, hi = nv;
      while (lo < hi) { var m = (lo + hi) >> 1; if (VX[m] < xa) lo = m + 1; else hi = m; }
      for (var q = lo; q < nv && VX[q] <= xb; q++) if (VS[q] <= yb && VE[q] >= ya) return true;
      return false;
    }
    function hasH(xa, xb, ya, yb) {
      var lo = 0, hi = nh;
      while (lo < hi) { var m = (lo + hi) >> 1; if (HY[m] < ya) lo = m + 1; else hi = m; }
      for (var q = lo; q < nh && HY[q] <= yb; q++) if (HS[q] <= xb && HE[q] >= xa) return true;
      return false;
    }
    var t;
    for (i = 0; i < nh; i++) {
      y = HY[i];
      for (t = 1; t <= ext && HS[i] - t >= 0; t++) {
        if (hasV(HS[i] - t, HS[i] - t, y - ext, y + ext)) { if (t > 1) rect(HS[i] - t + 1, y, HS[i] - 1, y); break; }
      }
      for (t = 1; t <= ext && HE[i] + t < w; t++) {
        if (hasV(HE[i] + t, HE[i] + t, y - ext, y + ext)) { if (t > 1) rect(HE[i] + 1, y, HE[i] + t - 1, y); break; }
      }
    }
    for (i = 0; i < nv; i++) {
      x = VX[i];
      for (t = 1; t <= ext && VS[i] - t >= 0; t++) {
        if (hasH(x - ext, x + ext, VS[i] - t, VS[i] - t)) { if (t > 1) rect(x, VS[i] - t + 1, x, VS[i] - 1); break; }
      }
      for (t = 1; t <= ext && VE[i] + t < h; t++) {
        if (hasH(x - ext, x + ext, VE[i] + t, VE[i] + t)) { if (t > 1) rect(x, VE[i] + 1, x, VE[i] + t - 1); break; }
      }
    }
    // 轉角缺口：水平線端點與垂直線端點彼此靠近（兩線都沒畫到轉角）→ 兩者都延伸到交點
    var e2 = 2 * ext;
    for (i = 0; i < nh; i++) {
      y = HY[i];
      for (var side = 0; side < 2; side++) {
        var xe = side ? HE[i] : HS[i], xa2 = side ? xe + 1 : xe - e2, xb2 = side ? xe + e2 : xe - 1;
        var lo = 0, hi = nv;
        while (lo < hi) { var m2 = (lo + hi) >> 1; if (VX[m2] < xa2) lo = m2 + 1; else hi = m2; }
        for (var q = lo; q < nv && VX[q] <= xb2; q++) {
          var up = VE[q] < y && y - VE[q] <= e2, down = VS[q] > y && VS[q] - y <= e2;
          if (!up && !down) continue;
          rect(Math.min(xe, VX[q]), y, Math.max(xe, VX[q]), y);
          if (up) rect(VX[q], VE[q], VX[q], y); else rect(VX[q], y, VX[q], VS[q]);
          break;
        }
      }
    }
    return { mask: mask, rects: rects.a.subarray(0, rects.n), ink: RI,
             h: { y: HY, s: HS, e: HE, n: nh }, v: { x: VX, s: VS, e: VE, n: nv } };
  }

  /** 牆＝種子矩形各向外擴 r（等同方形膨脹），直接塗入 */
  function paintWall(rects, w, h, r) {
    var wall = new Uint8Array(w * h);
    for (var i = 0; i < rects.length; i += 4) {
      var x0 = rects[i] - r, y0 = rects[i + 1] - r, x1 = rects[i + 2] + r, y1 = rects[i + 3] + r;
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 >= w) x1 = w - 1;
      if (y1 >= h) y1 = h - 1;
      if (x1 < x0) continue;
      for (var y = y0; y <= y1; y++) wall.fill(1, y * w + x0, y * w + x1 + 1);
    }
    return wall;
  }

  /* ---------------- 2. 列段連通標記 ---------------- */
  /** 擷取每列中值 = val（0 或 1，以 !!a[p] 判斷）的連續段 */
  function extractRuns(a, w, h, val) {
    var rs = new IntList(h * 4 + 64), re = new IntList(h * 4 + 64);
    var rowStart = new Int32Array(h + 1);
    var want = val ? 1 : 0;
    for (var y = 0; y < h; y++) {
      rowStart[y] = rs.n;
      var off = y * w, x = 0;
      while (x < w) {
        while (x < w && (a[off + x] ? 1 : 0) !== want) x++;
        if (x >= w) break;
        var s = x;
        while (x < w && (a[off + x] ? 1 : 0) === want) x++;
        rs.push(s); re.push(x - 1);
      }
    }
    rowStart[h] = rs.n;
    return { s: rs.a, e: re.a, n: rs.n, rowStart: rowStart, w: w, h: h };
  }
  /** 一次掃描同時取得牆（1）與非牆（0）列段；空白以字組快速跳過 */
  function wallRuns(wall, w, h) {
    var zs = new IntList(h * 16 + 64), ze = new IntList(h * 16 + 64), zr = new Int32Array(h + 1);
    var os = new IntList(h * 16 + 64), oe = new IntList(h * 16 + 64), or = new Int32Array(h + 1);
    var w32 = new Uint32Array(wall.buffer, wall.byteOffset, wall.length >> 2);
    for (var y = 0; y < h; y++) {
      zr[y] = zs.n; or[y] = os.n;
      var off = y * w, x = 0;
      while (x < w) {
        var s = x;
        for (;;) {
          var p = off + x;
          if ((p & 3) === 0 && x + 4 <= w && w32[p >> 2] === 0) { x += 4; continue; }
          if (x < w && !wall[p]) { x++; continue; }
          break;
        }
        if (x > s) { zs.push(s); ze.push(x - 1); }
        if (x >= w) break;
        s = x;
        while (x < w && wall[off + x]) x++;
        os.push(s); oe.push(x - 1);
      }
    }
    zr[h] = zs.n; or[h] = os.n;
    return { zero: { s: zs.a, e: ze.a, n: zs.n, rowStart: zr, w: w, h: h },
             one: { s: os.a, e: oe.a, n: os.n, rowStart: or, w: w, h: h } };
  }

  /** 列段聯集-查找標記；conn8=true 為 8 連通。回傳 {lab(每段標號), m(元件數)} */
  function labelRuns(R, conn8) {
    var n = R.n, par = new Int32Array(n), rs = R.s, re = R.e, rowStart = R.rowStart, h = R.h;
    var i, j, dlt = conn8 ? 1 : 0;
    for (i = 0; i < n; i++) par[i] = i;
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    for (var y = 1; y < h; y++) {
      i = rowStart[y - 1]; var iEnd = rowStart[y];
      j = rowStart[y]; var jEnd = rowStart[y + 1];
      while (i < iEnd && j < jEnd) {
        if (re[i] + dlt < rs[j]) { i++; continue; }
        if (re[j] + dlt < rs[i]) { j++; continue; }
        var ra = find(i), rb = find(j);
        if (ra !== rb) { if (ra < rb) par[rb] = ra; else par[ra] = rb; }
        if (re[i] < re[j]) i++; else j++;
      }
    }
    var lab = new Int32Array(n), m = 0;
    for (i = 0; i < n; i++) {
      var r = find(i);
      lab[i] = (r === i) ? m++ : lab[r];      // 根一定比子孫小（union 取小者）
    }
    return { lab: lab, m: m };
  }

  /** 各元件統計：bbox、面積、是否碰邊、第一段（光柵序最上最左） */
  function compStats(R, L, w, h) {
    var m = L.m, x0 = new Int32Array(m).fill(w), y0 = new Int32Array(m).fill(h);
    var x1 = new Int32Array(m).fill(-1), y1 = new Int32Array(m).fill(-1);
    var area = new Float64Array(m), border = new Uint8Array(m), first = new Int32Array(m).fill(-1);
    for (var y = 0; y < h; y++) {
      for (var i = R.rowStart[y]; i < R.rowStart[y + 1]; i++) {
        var c = L.lab[i], s = R.s[i], e = R.e[i];
        if (first[c] < 0) first[c] = i;
        if (s < x0[c]) x0[c] = s;
        if (e > x1[c]) x1[c] = e;
        if (y < y0[c]) y0[c] = y;
        if (y > y1[c]) y1[c] = y;
        area[c] += e - s + 1;
        if (y === 0 || y === h - 1 || s === 0 || e === w - 1) border[c] = 1;
      }
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, area: area, border: border, first: first, m: m };
  }

  /** 找出 (x,y) 所在的段索引；無則 -1 */
  function runAt(R, x, y) {
    if (y < 0 || y >= R.h) return -1;
    var lo = R.rowStart[y], hi = R.rowStart[y + 1] - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (R.e[mid] < x) lo = mid + 1;
      else if (R.s[mid] > x) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  /* ---------------- 歪斜角估計（水平線投影法） ---------------- */
  /** 由水平線段上的墨點取樣，於 ±3° 內找使投影最集中的角度（度） */
  function estimateSkew(L, img) {
    var w = img.width, h = img.height, d = img.data, H = L.h, i, x;
    var total = 0;
    for (i = 0; i < H.n; i++) total += H.e[i] - H.s[i] + 1;
    if (total < 300) return 0;
    var step = Math.max(1, Math.ceil(total / 40000));
    var xs = new IntList(total / step + 16), ys = new IntList(total / step + 16);
    for (i = 0; i < H.n; i++) {
      var off = H.y[i] * w;
      for (x = H.s[i]; x <= H.e[i]; x += step) if (d[off + x]) { xs.push(x); ys.push(H.y[i]); }
    }
    var n = xs.n;
    if (n < 200) return 0;
    var shift = Math.ceil(w * Math.tan(3.2 * Math.PI / 180)) + 2, len = h + 2 * shift + 2;
    var hist = new Int32Array(len);
    function score(deg) {
      var t = Math.tan(deg * Math.PI / 180), sc = 0, k;
      hist.fill(0);
      for (k = 0; k < n; k++) {
        var b = Math.round(ys.a[k] - xs.a[k] * t) + shift;
        if (b >= 0 && b < len) hist[b]++;
      }
      for (k = 0; k < len; k++) if (hist[k]) sc += hist[k] * hist[k];
      return sc;
    }
    var best = 0, bestS = -1, a, sv;
    for (a = -3; a <= 3.0001; a += 0.1) { sv = score(a); if (sv > bestS) { bestS = sv; best = a; } }
    var c = best;
    for (a = c - 0.12; a <= c + 0.1201; a += 0.02) { sv = score(a); if (sv > bestS) { bestS = sv; best = a; } }
    c = best;
    for (a = c - 0.02; a <= c + 0.0201; a += 0.005) { sv = score(a); if (sv > bestS) { bestS = sv; best = a; } }
    // 無明顯主方向（與 0° 相差 < 1%）視為 0
    if (bestS <= score(0) * 1.01) return 0;
    return Math.round(best * 1000) / 1000;
  }

  /* ---------------- 一維分群（單一連結） ---------------- */
  function cluster1d(vals, n, tol) {
    var idx = new Array(n), i;
    for (i = 0; i < n; i++) idx[i] = i;
    idx.sort(function (a, b) { return vals[a] - vals[b]; });
    var assign = new Int32Array(n), centers = [], sum = 0, cnt = 0, prev = -Infinity, k = -1;
    for (i = 0; i < n; i++) {
      var v = vals[idx[i]];
      if (k < 0 || v - prev > tol) {
        if (k >= 0) centers.push(sum / cnt);
        k++; sum = 0; cnt = 0;
      }
      sum += v; cnt++; prev = v; assign[idx[i]] = k;
    }
    if (k >= 0) centers.push(sum / cnt);
    return { centers: centers, assign: assign };
  }

  /* ---------------- 主程式：表格偵測 ---------------- */
  /**
   * detectTables(bin, opts?) → {
   *   mask: Uint8Array(w*h)  // bit1=水平線墨點、bit2=垂直線墨點（不含格內被誤判的文字筆畫）
   *   tables: [{ bbox, xs, ys, nRows, nCols, cells:[{r0,r1,c0,c1,bbox}] }]   // 由上而下
   *   angle,                 // 估計歪斜角（度，正 = 往右下傾）
   *   dpi,                   // 實際採用的 dpi（opts.dpi 或由頁面尺寸推估）
   *   nested: [bbox],        // 略過的格內巢狀結構（印章框等）
   *   dropped: [{bbox, reason: "nested"|"seal"}],
   *   stats: {ms, cells, comps, hLines, vLines}
   * }
   * opts: {dpi=200, angle（指定歪斜角、略過估計）, keepNested, keepSeals,
   *        以及門檻覆寫 minH, minV, gap, band, cover, bridge, ext, dil, minCell, tol, maxWall}
   */
  function detectTables(bin, opts) {
    var t0 = Date.now();
    opts = opts || {};
    var img = checkBitmap(bin), w = img.width, h = img.height;
    var P = params(w, h, opts);
    var empty = { mask: new Uint8Array(w * h), tables: [], angle: 0, dpi: P.dpi, nested: [], dropped: [],
                  stats: { ms: 0, cells: 0, comps: 0, hLines: 0, vLines: 0 } };
    if (w < 8 || h < 8) return empty;

    var L = findLines(img, P);
    var wall = paintWall(L.rects, w, h, P.dil);

    // 非牆區塊（4 連通）與牆元件（8 連通）
    var WR = wallRuns(wall, w, h), RN = WR.zero, RW = WR.one;
    var LN = labelRuns(RN, false), SN = compStats(RN, LN, w, h);
    var LW = labelRuns(RW, true), SW = compStats(RW, LW, w, h);

    // 候選儲存格
    var minC = P.minCell, isCell = new Uint8Array(SN.m), cellIds = [], c;
    for (c = 0; c < SN.m; c++) {
      if (SN.border[c]) continue;
      var cw = SN.x1[c] - SN.x0[c] + 1, ch = SN.y1[c] - SN.y0[c] + 1;
      if (cw < minC || ch < minC) continue;
      isCell[c] = 1; cellIds.push(c);
    }

    // 「容器」區塊：填滿率低且包住其他儲存格（例：頁框與表格之間的環狀空白）→ 不是儲存格
    removeContainers(SN, isCell, cellIds, w, h);
    cellIds = cellIds.filter(function (id) { return isCell[id]; });

    // 逐格量測四邊牆中心（多點取樣取最薄者），並記錄牆另一側的鄰格 → 依相鄰關係分組
    var nC = cellIds.length, cellIndex = new Int32Array(SN.m).fill(-1), i;
    for (i = 0; i < nC; i++) cellIndex[cellIds[i]] = i;
    var M = measureCells(cellIds, cellIndex, RN, LN, SN, wall, w, h, P);
    var groups = {}, gKeys = [], groupOf = new Int32Array(SN.m).fill(-1);
    for (i = 0; i < nC; i++) {
      var g = M.find(i);
      if (!groups[g]) { groups[g] = []; gKeys.push(g); }
      groups[g].push(i);
      groupOf[cellIds[i]] = g;
    }

    // 至少 2 格才算表格
    var accepted = {}, cellAcc = new Uint8Array(SN.m);
    gKeys.forEach(function (g) {
      if (groups[g].length >= 2) {
        accepted[g] = true;
        groups[g].forEach(function (k) { cellAcc[cellIds[k]] = 1; });
      }
    });
    // 巢狀：整組最上方那格往上穿過外框後落在另一個已接受表格的儲存格內 → 格內印章／小框，略過
    var nested = [], dropG = {};
    gKeys.forEach(function (g) {
      if (!accepted[g]) return;
      var gb = groupBox(groups[g], cellIds, SN), top = -1;
      groups[g].forEach(function (k) { var id = cellIds[k]; if (top < 0 || SN.y0[id] < SN.y0[cellIds[top]]) top = k; });
      var tid = cellIds[top], fr = SN.first[tid];
      var pc = walkOut(wall, w, h, RN, LN, RN.s[fr], SN.y0[tid], -1, tid);
      if (pc >= 0 && cellAcc[pc] && groupOf[pc] !== g &&
          SN.x0[pc] <= gb.x0 && SN.y0[pc] <= gb.y0 && SN.x1[pc] >= gb.x1 && SN.y1[pc] >= gb.y1) {
        // 內層格數少（≤ 8 且不多於外層：印章、簽章框），或是一列字級小格（粗體字的筆畫被當成格線）→ 略過；
        // 否則內層才是真正的表格（外層是頁框之類），保留
        var parentN = groups[groupOf[pc]] ? groups[groupOf[pc]].length : 0, maxH = 0;
        groups[g].forEach(function (k) { var id = cellIds[k]; maxH = Math.max(maxH, SN.y1[id] - SN.y0[id] + 1); });
        var textLike = maxH <= mm(6, P.dpi) && gb.y1 - gb.y0 <= mm(8, P.dpi);
        if (groups[g].length <= Math.min(8, parentN) || textLike) dropG[g] = true;
      }
    });
    gKeys.forEach(function (g) {
      if (dropG[g] && !opts.keepNested) {
        accepted[g] = false;
        var gb = groupBox(groups[g], cellIds, SN);
        nested.push({ x0: gb.x0, y0: gb.y0, x1: gb.x1, y1: gb.y1 });
      }
    });

    var angle = opts.angle != null ? +opts.angle : estimateSkew(L, img);
    var slope = Math.tan(angle * Math.PI / 180);

    var tables = [], tableWall = {};
    gKeys.forEach(function (g) {
      if (!accepted[g]) return;
      var t = buildTable(groups[g], cellIds, M, SN, w, h, P, slope);
      if (!t) return;
      tables.push(t);
      groups[g].forEach(function (k) {
        var id = cellIds[k], fr = SN.first[id];
        var wr = runAt(RW, RN.s[fr], SN.y0[id] - 1);
        if (wr >= 0) tableWall[LW.lab[wr]] = true;
      });
    });
    tables.sort(function (a, b) { return (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0); });

    // 輸出遮罩：去掉「完全落在某儲存格內、且不屬於任何表格框線」的線段（多為文字筆畫被誤判）
    var mask = L.mask;
    pruneMask(mask, RW, LW, SW, RN, LN, cellAcc, tableWall, w, h);

    // 印章：外框 ≤ 35mm 見方、格內墨點密度 ≥ 0.16（一般表格約 0.03–0.08）→ 不當表格
    var dropped = nested.map(function (b) { return { bbox: b, reason: "nested" }; });
    if (!opts.keepSeals) {
      var sealMax = mm(35, P.dpi);
      tables = tables.filter(function (t) {
        var b = t.bbox;
        if (b.x1 - b.x0 > sealMax || b.y1 - b.y0 > sealMax) return true;
        var ink = 0, area = 0;
        t.cells.forEach(function (c) {
          var cb = c.bbox;
          area += (cb.x1 - cb.x0 + 1) * (cb.y1 - cb.y0 + 1);
          for (var y = cb.y0; y <= cb.y1; y++) {
            var off = y * w;
            for (var x = cb.x0; x <= cb.x1; x++) if (img.data[off + x] && !mask[off + x]) ink++;
          }
        });
        if (area > 0 && ink / area >= 0.16) { dropped.push({ bbox: b, reason: "seal" }); return false; }
        return true;
      });
    }

    var nCells = 0;
    tables.forEach(function (t) { nCells += t.cells.length; });
    if (maskCache) { try { maskCache.set(bin, mask); } catch (e) { /* 非物件時略過 */ } }
    return {
      mask: mask, tables: tables, angle: angle, dpi: P.dpi, nested: nested, dropped: dropped,
      stats: { ms: Date.now() - t0, cells: nCells, comps: SN.m, hLines: L.h.n, vLines: L.v.n }
    };
  }
  // detectTables 的線遮罩快取（同一 Bitmap 物件再呼叫 textLines 時免重算）
  var maskCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;

  /** 填滿率 < 0.5 且包住其他儲存格中心者（頁框與表格之間的環狀空白等）不算儲存格 */
  function removeContainers(S, isCell, ids, w, h) {
    var cand = [];
    ids.forEach(function (id) {
      var bw = S.x1[id] - S.x0[id] + 1, bh = S.y1[id] - S.y0[id] + 1;
      var fill = S.area[id] / (bw * bh);
      if (fill < 0.5) cand.push({ id: id, fill: fill });
    });
    if (!cand.length) return;
    // 儲存格中心的格網索引
    var B = 64, gw = Math.ceil(w / B), gh = Math.ceil(h / B), buckets = {};
    ids.forEach(function (id) {
      var cx = (S.x0[id] + S.x1[id]) >> 1, cy = (S.y0[id] + S.y1[id]) >> 1;
      var key = ((cy / B) | 0) * gw + ((cx / B) | 0);
      (buckets[key] = buckets[key] || []).push(id);
    });
    cand.forEach(function (cd) {
      var id = cd.id, n = 0;
      var bx0 = (S.x0[id] / B) | 0, bx1 = Math.min(gw - 1, (S.x1[id] / B) | 0);
      var by0 = (S.y0[id] / B) | 0, by1 = Math.min(gh - 1, (S.y1[id] / B) | 0);
      for (var by = by0; by <= by1; by++) for (var bx = bx0; bx <= bx1; bx++) {
        var arr = buckets[by * gw + bx];
        if (!arr) continue;
        for (var i = 0; i < arr.length; i++) {
          var o = arr[i];
          if (o === id) continue;
          var cx = (S.x0[o] + S.x1[o]) >> 1, cy = (S.y0[o] + S.y1[o]) >> 1;
          if (cx >= S.x0[id] && cx <= S.x1[id] && cy >= S.y0[id] && cy <= S.y1[id]) n++;
        }
      }
      if (n >= 1) isCell[id] = 0;
    });
  }

  function groupBox(list, cellIds, SN) {
    var b = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
    list.forEach(function (k) {
      var id = cellIds[k];
      if (SN.x0[id] < b.x0) b.x0 = SN.x0[id];
      if (SN.y0[id] < b.y0) b.y0 = SN.y0[id];
      if (SN.x1[id] > b.x1) b.x1 = SN.x1[id];
      if (SN.y1[id] > b.y1) b.y1 = SN.y1[id];
    });
    return b;
  }

  /**
   * 從格內 (x,y) 沿方向走：穿過格內 → 穿過牆。呼叫端從該格最外側的像素出發，
   * 因此不會誤穿格內的洞（印章、文字假線）。回傳牆中心座標，牆厚存於 WC.t、
   * 落點區塊標號存於 WC.land（-1 = 影像外）。
   */
  var WC = { t: 0, land: -1 };
  function wallCenter(wall, w, h, RN, LN, c, x, y, dx, dy, maxWall) {
    while (x >= 0 && y >= 0 && x < w && y < h && !wall[y * w + x]) { x += dx; y += dy; }
    var ix = x - dx, iy = y - dy, t = 0;
    while (x >= 0 && y >= 0 && x < w && y < h && wall[y * w + x] && t < maxWall) { x += dx; y += dy; t++; }
    var land = -1;
    if (x >= 0 && y >= 0 && x < w && y < h && !wall[y * w + x]) {
      var r = runAt(RN, x, y);
      land = r >= 0 ? LN.lab[r] : -1;
    }
    WC.t = t; WC.land = land;
    return dx ? (ix + x) / 2 : (iy + y) / 2;
  }
  /** 在第 x 欄由 yFrom 往 dir 方向找第一個屬於區塊 c 的像素；找不到回傳 -1 */
  function colEdge(RN, LN, c, x, yFrom, yTo, dir) {
    for (var y = yFrom; dir > 0 ? y <= yTo : y >= yTo; y += dir) {
      var r = runAt(RN, x, y);
      if (r >= 0 && LN.lab[r] === c) return y;
    }
    return -1;
  }
  /** 從區塊 c 的 (x,y) 往 dy 方向走出外框，回傳落點區塊標號 */
  function walkOut(wall, w, h, RN, LN, x, y, dy, c) {
    wallCenter(wall, w, h, RN, LN, c, x, y, 0, dy, 1 << 20);
    return WC.land;
  }

  /** 量測所有候選格四邊牆中心與鄰格；回傳原始值（尚未歪斜校正）與聯集-查找 */
  function measureCells(cellIds, cellIndex, RN, LN, SN, wall, w, h, P) {
    var nC = cellIds.length, i, q;
    var lv = new Float64Array(nC), ly = new Float64Array(nC), rv = new Float64Array(nC), ry = new Float64Array(nC);
    var tv = new Float64Array(nC), tx = new Float64Array(nC), bv = new Float64Array(nC), bx = new Float64Array(nC);
    var th = new Float64Array(nC * 4);       // 四邊實測牆厚（左、右、上、下）
    var par = new Int32Array(nC);
    for (i = 0; i < nC; i++) par[i] = i;
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    function link(i0, lab) {
      if (lab < 0) return;
      var j = cellIndex[lab];
      if (j < 0) return;
      // 一方的外框包住另一方（格內印章／小框）不算相鄰
      var a = cellIds[i0];
      if ((SN.x0[lab] <= SN.x0[a] && SN.x1[lab] >= SN.x1[a] && SN.y0[lab] <= SN.y0[a] && SN.y1[lab] >= SN.y1[a]) ||
          (SN.x0[a] <= SN.x0[lab] && SN.x1[a] >= SN.x1[lab] && SN.y0[a] <= SN.y0[lab] && SN.y1[a] >= SN.y1[lab])) return;
      var ra = find(i0), rb = find(j);
      if (ra !== rb) { if (ra < rb) par[rb] = ra; else par[ra] = rb; }
    }
    // 落點區塊整個在本格外框範圍內 → 撞到的是格內的洞（印章、L 形格的凹口），此次量測作廢
    function inner(lab, c) {
      return lab >= 0 && SN.x0[lab] >= SN.x0[c] && SN.x1[lab] <= SN.x1[c] && SN.y0[lab] >= SN.y0[c] && SN.y1[lab] <= SN.y1[c];
    }
    // 取樣位置刻意避開等分點（合併格常跨偶數列，等分點正好落在內部橫線的 T 字交會處）
    var FR = [0.5, 0.38, 0.62, 0.21, 0.79, 0.11, 0.89, 0.45, 0.55], thin = P.dil * 2 + 4, mw = P.maxWall;
    for (i = 0; i < nC; i++) {
      var c = cellIds[i], x0 = SN.x0[c], x1 = SN.x1[c], y0 = SN.y0[c], y1 = SN.y1[c];
      var ym = (y0 + y1) >> 1, hgt = y1 - y0, fb = P.dil + 1;
      var bL = Infinity, bR = Infinity;
      lv[i] = x0 - fb; ly[i] = ym; rv[i] = x1 + fb; ry[i] = ym;
      for (q = 0; q < FR.length; q++) {
        var yk = y0 + Math.round(hgt * FR[q]), sL = -1, eR = -1;
        for (var k = RN.rowStart[yk]; k < RN.rowStart[yk + 1]; k++) {
          if (LN.lab[k] !== c) continue;
          if (sL < 0) sL = RN.s[k];
          eR = RN.e[k];
        }
        if (sL < 0) continue;
        var cl = wallCenter(wall, w, h, RN, LN, c, sL, yk, -1, 0, mw);
        link(i, WC.land);
        if (WC.t < bL && !inner(WC.land, c)) { bL = WC.t; lv[i] = cl; ly[i] = yk; }
        var cr = wallCenter(wall, w, h, RN, LN, c, eR, yk, +1, 0, mw);
        link(i, WC.land);
        if (WC.t < bR && !inner(WC.land, c)) { bR = WC.t; rv[i] = cr; ry[i] = yk; }
        if (q >= 2 && bL <= thin && bR <= thin) break;
      }
      // 上下牆：在數個欄位置，由該格在此欄最上（最下）的像素往外量
      var bT = Infinity, bB = Infinity, wid = x1 - x0;
      tv[i] = y0 - fb; tx[i] = (x0 + x1) / 2; bv[i] = y1 + fb; bx[i] = tx[i];
      for (q = 0; q < FR.length; q++) {
        var xk = x0 + Math.round(wid * FR[q]);
        var yt = colEdge(RN, LN, c, xk, y0, y1, +1);
        if (yt < 0) continue;
        var ct = wallCenter(wall, w, h, RN, LN, c, xk, yt, 0, -1, mw);
        link(i, WC.land);
        if (WC.t < bT && !inner(WC.land, c)) { bT = WC.t; tv[i] = ct; tx[i] = xk; }
        var yb = colEdge(RN, LN, c, xk, y1, y0, -1);
        var cb = wallCenter(wall, w, h, RN, LN, c, xk, yb, 0, +1, mw);
        link(i, WC.land);
        if (WC.t < bB && !inner(WC.land, c)) { bB = WC.t; bv[i] = cb; bx[i] = xk; }
        if (q >= 2 && bT <= thin && bB <= thin) break;
      }
      // 量不到的邊以膨脹後的預設牆厚代替
      th[4 * i] = isFinite(bL) ? bL : 2 * fb; th[4 * i + 1] = isFinite(bR) ? bR : 2 * fb;
      th[4 * i + 2] = isFinite(bT) ? bT : 2 * fb; th[4 * i + 3] = isFinite(bB) ? bB : 2 * fb;
    }
    return { lv: lv, ly: ly, rv: rv, ry: ry, tv: tv, tx: tx, bv: bv, bx: bx, th: th, find: find };
  }

  /** 由一組相鄰儲存格建表：歪斜校正 → 分群 → 跨欄跨列 */
  function buildTable(list, cellIds, M, SN, w, h, P, slope) {
    var n = list.length, i, k;
    var gb = groupBox(list, cellIds, SN);
    var xc = (gb.x0 + gb.x1) / 2, yc = (gb.y0 + gb.y1) / 2;
    var xv = new Float64Array(2 * n), yv = new Float64Array(2 * n);
    for (i = 0; i < n; i++) {
      k = list[i];
      xv[2 * i] = M.lv[k] + slope * (M.ly[k] - yc);
      xv[2 * i + 1] = M.rv[k] + slope * (M.ry[k] - yc);
      yv[2 * i] = M.tv[k] - slope * (M.tx[k] - xc);
      yv[2 * i + 1] = M.bv[k] - slope * (M.bx[k] - xc);
    }
    var cx = cluster1d(xv, 2 * n, P.tol), cy = cluster1d(yv, 2 * n, P.tol);
    var nCols = Math.max(1, cx.centers.length - 1), nRows = Math.max(1, cy.centers.length - 1);
    var cells = [];
    for (i = 0; i < n; i++) {
      var id = cellIds[list[i]];
      var c0 = cx.assign[2 * i], c1 = cx.assign[2 * i + 1] - 1;
      var r0 = cy.assign[2 * i], r1 = cy.assign[2 * i + 1] - 1;
      if (c1 > nCols - 1) c1 = nCols - 1;
      if (r1 > nRows - 1) r1 = nRows - 1;
      if (c0 > c1) c0 = c1;
      if (r0 > r1) r0 = r1;
      if (c0 < 0) c0 = 0;
      if (r0 < 0) r0 = 0;
      var bb = { x0: SN.x0[id], y0: SN.y0[id], x1: SN.x1[id], y1: SN.y1[id] }, cell = { r0: r0, r1: r1, c0: c0, c1: c1, bbox: bb };
      if (Math.abs(slope) >= 0.002) {
        // 歪斜頁：格內範圍以「校正座標系下的四邊」描述，cellInk 會用它排除外框角落內的鄰格文字
        var k4 = 4 * list[i];
        var fr = { s: slope, cx: xc, cy: yc,
                   l: xv[2 * i] + M.th[k4] / 2, r: xv[2 * i + 1] - M.th[k4 + 1] / 2,
                   t: yv[2 * i] + M.th[k4 + 2] / 2, b: yv[2 * i + 1] - M.th[k4 + 3] / 2 };
        if (fr.r > fr.l && fr.b > fr.t) {
          cell.frame = fr;
          Object.defineProperty(bb, "frame", { value: fr, enumerable: false });
        }
      }
      cells.push(cell);
    }
    cells.sort(function (a, b) { return (a.r0 - b.r0) || (a.c0 - b.c0) || (a.bbox.x0 - b.bbox.x0); });
    var pad = P.dil + 4;
    var tb = { x0: Math.max(0, gb.x0 - pad), y0: Math.max(0, gb.y0 - pad),
               x1: Math.min(w - 1, gb.x1 + pad), y1: Math.min(h - 1, gb.y1 + pad) };
    var out = { bbox: tb, xs: cx.centers.map(Math.round), ys: cy.centers.map(Math.round),
                nRows: nRows, nCols: nCols, cells: cells };
    if (Math.abs(slope) >= 0.002 && cx.centers.length > 1 && cy.centers.length > 1) {
      // 歪斜頁的表格範圍（外框牆中心再外擴 pad）；textLines 排除表格時用它，避免吃掉表格斜角旁的標題文字
      var fr = { s: slope, cx: xc, cy: yc, l: cx.centers[0] - pad, r: cx.centers[cx.centers.length - 1] + pad,
                 t: cy.centers[0] - pad, b: cy.centers[cy.centers.length - 1] + pad };
      out.frame = fr;
      Object.defineProperty(tb, "frame", { value: fr, enumerable: false });
    }
    return out;
  }

  /**
   * 遮罩清理：牆元件若不是任何已接受表格的外框，且其外側區塊是已接受的儲存格
   * （＝整個落在格內，如文字筆畫串成的假線、格內底線），把它的線墨點從 mask 移除，
   * 避免 OCR 前把文字筆畫抹掉。
   */
  function pruneMask(mask, RW, LW, SW, RN, LN, cellAcc, tableWall, w, h) {
    var drop = new Uint8Array(SW.m), any = false;
    for (var g = 0; g < SW.m; g++) {
      if (tableWall[g]) continue;
      var fr = SW.first[g], y = SW.y0[g];
      var nr = runAt(RN, RW.s[fr], y - 1);
      var pc = nr >= 0 ? LN.lab[nr] : -1;
      if (pc >= 0 && cellAcc[pc]) { drop[g] = 1; any = true; }
    }
    if (!any) return;
    for (var yy = 0; yy < h; yy++) {
      for (var i = RW.rowStart[yy]; i < RW.rowStart[yy + 1]; i++) {
        if (!drop[LW.lab[i]]) continue;
        var off = yy * w;
        for (var x = RW.s[i]; x <= RW.e[i]; x++) mask[off + x] = 0;
      }
    }
  }

  /* ---------------- 格內墨跡 ---------------- */
  /**
   * cellInk(bin, mask, bbox, inset=3, opts?) → {count, bbox|null}
   * 計算 bbox 內縮 inset 後、非線像素的墨點數與緊框；opts.speck（預設 4）以下的孤立小點不計入外框。
   * 歪斜頁上 detectTables 產生的 bbox 帶有（不可列舉的）frame，會再依歪斜的四邊裁掉角落裡的鄰格文字；
   * 也可用 opts.frame 明確傳入（= cell.frame）。
   */
  function cellInk(bin, mask, bbox, inset, opts) {
    var w = bin.width, h = bin.height, d = bin.data;
    if (!bbox) return { count: 0, bbox: null };
    if (inset == null) inset = 3;
    opts = opts || {};
    var speck = opts.speck != null ? opts.speck : 4;
    var x0 = Math.max(0, Math.ceil(bbox.x0) + inset), y0 = Math.max(0, Math.ceil(bbox.y0) + inset);
    var x1 = Math.min(w - 1, Math.floor(bbox.x1) - inset), y1 = Math.min(h - 1, Math.floor(bbox.y1) - inset);
    if (x1 < x0 || y1 < y0) return { count: 0, bbox: null };
    var cw = x1 - x0 + 1, ch = y1 - y0 + 1, sub = new Uint8Array(cw * ch), count = 0;
    var fr = opts.frame || bbox.frame || null;   // 歪斜頁的格內範圍（detectTables 附在 bbox 上，不可列舉）
    for (var y = 0; y < ch; y++) {
      var so = (y + y0) * w + x0, to = y * cw, Y = y + y0;
      for (var x = 0; x < cw; x++) {
        var p = so + x;
        if (!d[p] || (mask && mask[p])) continue;
        if (fr) {
          var X = x + x0, u = X + fr.s * (Y - fr.cy), v = Y - fr.s * (X - fr.cx);
          if (u < fr.l + inset || u > fr.r - inset || v < fr.t + inset || v > fr.b - inset) continue;
        }
        sub[to + x] = 1; count++;
      }
    }
    if (!count) return { count: 0, bbox: null };
    var R = extractRuns(sub, cw, ch, 1), Lb = labelRuns(R, true), S = compStats(R, Lb, cw, ch);
    var bx0 = cw, by0 = ch, bx1 = -1, by1 = -1, kept = 0;
    for (var c = 0; c < S.m; c++) {
      if (S.area[c] <= speck && S.m > 1) continue;
      kept += S.area[c];
      if (S.x0[c] < bx0) bx0 = S.x0[c];
      if (S.y0[c] < by0) by0 = S.y0[c];
      if (S.x1[c] > bx1) bx1 = S.x1[c];
      if (S.y1[c] > by1) by1 = S.y1[c];
    }
    if (bx1 < 0) return { count: 0, bbox: null };
    var ob = { x0: bx0 + x0, y0: by0 + y0, x1: bx1 + x0, y1: by1 + y0 };
    if (fr) {
      // 傳給 YF.raster.encodePBM 時一併排除框外（鄰格）墨點
      Object.defineProperty(ob, "frame", { value: { s: fr.s, cx: fr.cx, cy: fr.cy, l: fr.l + inset, r: fr.r - inset,
                                                  t: fr.t + inset, b: fr.b - inset }, enumerable: false });
    }
    return { count: kept, bbox: ob };
  }

  /* ---------------- 表格外文字列 ---------------- */
  /**
   * textLines(bin, excludeBoxes, opts?) → [{bbox, n, h}]
   * 以 8 連通元件 + 鄰近合併切出文字列（同列相距過遠者分成多段），
   * 去除小雜點與線條；excludeBoxes（表格範圍）內的墨點不計（box 帶 frame 時——detectTables 在歪斜頁
   * 回傳的 table.bbox 即是——只排除斜框內部）。
   * opts: {dpi, mask(線遮罩，有則先去線), maxLines=60, joinGap(字高倍數, 預設 2.4：字距拉開的「檢 測 位 置」仍算同一列)}
   */
  function textLines(bin, excludeBoxes, opts) {
    opts = opts || {};
    var img = checkBitmap(bin), w = img.width, h = img.height, d = img.data;
    if (w < 4 || h < 4) return [];
    var dpi = guessDpi(w, h, opts), maxLines = opts.maxLines != null ? opts.maxLines : 60;
    var mask = opts.mask || (maskCache && bin && typeof bin === "object" ? maskCache.get(bin) : null);
    if (!mask || mask.length < w * h) {
      var P = params(w, h, { dpi: dpi });
      mask = findLines(img, P).mask;
    }
    // 排除區（逐列區間）
    var ex = (excludeBoxes || []).filter(Boolean);
    var t = new Uint8Array(w * h), y, x;
    for (y = 0; y < h; y++) {
      var off = y * w;
      for (x = 0; x < w; x++) { var p = off + x; if (d[p] && !mask[p]) t[p] = 1; }
      for (var k = 0; k < ex.length; k++) {
        var b = ex[k], fr = b.frame;
        if (y < b.y0 || y > b.y1) continue;
        var xa = Math.max(0, Math.floor(b.x0)), xb = Math.min(w - 1, Math.ceil(b.x1));
        if (fr) {
          // 歪斜表格：只排除斜框內（u = x + s(y-cy), v = y - s(x-cx)）
          for (x = xa; x <= xb; x++) {
            var u = x + fr.s * (y - fr.cy), v = y - fr.s * (x - fr.cx);
            if (u >= fr.l && u <= fr.r && v >= fr.t && v <= fr.b) t[off + x] = 0;
          }
        } else for (x = xa; x <= xb; x++) t[off + x] = 0;
      }
    }
    var R = extractRuns(t, w, h, 1), Lb = labelRuns(R, true), S = compStats(R, Lb, w, h);
    t = null;
    var minPx = Math.max(2, Math.round(mm(0.35, dpi)));       // 雜點尺寸
    var maxCh = mm(14, dpi);                                 // 超過即非文字
    var comps = [];
    for (var c = 0; c < S.m; c++) {
      var cw = S.x1[c] - S.x0[c] + 1, ch = S.y1[c] - S.y0[c] + 1;
      if (cw <= minPx && ch <= minPx) continue;                    // 雜點
      if (S.area[c] < 3) continue;
      if (ch > maxCh) continue;                                    // 圖形／印章／直線
      if (ch <= mm(1.2, dpi) && cw > mm(25, dpi)) continue;         // 底線、分隔線
      comps.push({ x0: S.x0[c], y0: S.y0[c], x1: S.x1[c], y1: S.y1[c], h: ch, a: S.area[c] });
    }
    if (!comps.length) return [];
    // 典型字高：取高度 ≥1.5mm 元件的中位數
    var hs = comps.filter(function (o) { return o.h >= mm(1.5, dpi); }).map(function (o) { return o.h; }).sort(function (a, b) { return a - b; });
    var H = hs.length ? hs[hs.length >> 1] : mm(3, dpi);
    var joinF = opts.joinGap != null ? opts.joinGap : 2.4;
    comps.sort(function (a, b) { return a.y0 - b.y0; });
    var n = comps.length, par = new Int32Array(n), i, j;
    for (i = 0; i < n; i++) par[i] = i;
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    var small = 0.6 * H;
    for (i = 0; i < n; i++) {
      var A = comps[i];
      for (j = i + 1; j < n && comps[j].y0 <= A.y1; j++) {
        var Bc = comps[j];
        var lo = Math.min(A.h, Bc.h), hi = Math.max(A.h, Bc.h);
        var ov = Math.min(A.y1, Bc.y1) - Math.max(A.y0, Bc.y0) + 1;
        if (ov < 0.45 * lo) continue;
        if (lo >= small) {
          // 兩者皆為字級元件：高度相差過大（跨兩列的括號、直線）不連結
          if (hi > 2.2 * lo) continue;
        } else {
          // 小元件（標點、下標）：中心須落在大者的垂直範圍內
          var S0 = A.h >= Bc.h ? A : Bc, s0 = A.h >= Bc.h ? Bc : A, cyS = (s0.y0 + s0.y1) / 2;
          if (cyS < S0.y0 || cyS > S0.y1) continue;
        }
        var gx = Math.max(A.x0, Bc.x0) - Math.min(A.x1, Bc.x1);
        if (gx > joinF * Math.max(H, lo)) continue;
        var ra = find(i), rb = find(j);
        if (ra !== rb) { if (ra < rb) par[rb] = ra; else par[ra] = rb; }
      }
    }
    var lines = {}, order = [];
    for (i = 0; i < n; i++) {
      var r = find(i), o2 = comps[i], L = lines[r];
      if (!L) { L = lines[r] = { x0: o2.x0, y0: o2.y0, x1: o2.x1, y1: o2.y1, n: 0, hs: [], a: 0 }; order.push(r); }
      if (o2.x0 < L.x0) L.x0 = o2.x0;
      if (o2.y0 < L.y0) L.y0 = o2.y0;
      if (o2.x1 > L.x1) L.x1 = o2.x1;
      if (o2.y1 > L.y1) L.y1 = o2.y1;
      L.n++; L.hs.push(o2.h); L.a += o2.a;
    }
    var out = [];
    order.forEach(function (key) {
      var Ln = lines[key], lh = Ln.y1 - Ln.y0 + 1, lw = Ln.x1 - Ln.x0 + 1;
      if (lh < 0.5 * H) return;                       // 太扁：標點或雜訊
      if (Ln.n === 1 && lw < 0.6 * H && lh < 0.8 * H) return;
      if (lh > 3.2 * H) return;                       // 多列或圖形
      Ln.hs.sort(function (a, b) { return a - b; });
      out.push({ bbox: { x0: Ln.x0, y0: Ln.y0, x1: Ln.x1, y1: Ln.y1 }, n: Ln.n, h: Ln.hs[Ln.hs.length >> 1] });
    });
    // 閱讀順序：先依中心 y 分列（相差 < 半字高者同列），列內依 x
    out.sort(function (a, b) { return (a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1); });
    var rowKey = -Infinity, rowNo = -1;
    out.forEach(function (o) {
      var cy = (o.bbox.y0 + o.bbox.y1) / 2;
      if (cy - rowKey >= 0.5 * H) { rowNo++; rowKey = cy; }
      o._row = rowNo;
    });
    out.sort(function (a, b) { return (a._row - b._row) || (a.bbox.x0 - b.bbox.x0); });
    out.forEach(function (o) { delete o._row; });
    return out.slice(0, maxLines);
  }

  /* ---------------- 歪斜角 ---------------- */
  /**
   * deskewAngle(bin, opts?) → 角度（度）。正值表示水平線往右下傾（y 隨 x 增加）；
   * 要校正請以 -angle 旋轉（見 YF.raster.rotateBitmap）。找不到足夠長線時回傳 0。
   */
  function deskewAngle(bin, opts) {
    var img = checkBitmap(bin), w = img.width, h = img.height;
    if (w < 8 || h < 8) return 0;
    var P = params(w, h, opts);
    var L = findLines(img, P, false);
    return estimateSkew(L, img);
  }

  YF.grid = {
    detectTables: detectTables,
    cellInk: cellInk,
    textLines: textLines,
    deskewAngle: deskewAngle,
    params: function (w, h, opts) { return params(w, h, opts); },
    BIT_H: BIT_H, BIT_V: BIT_V,
    _internal: { findLines: findLines, paintWall: paintWall, wallRuns: wallRuns, inkRuns: inkRuns, extractRuns: extractRuns, labelRuns: labelRuns,
                 compStats: compStats, cluster1d: cluster1d, estimateSkew: estimateSkew }
  };
})(typeof window !== "undefined" ? window : globalThis);
