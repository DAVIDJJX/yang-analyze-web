/* =========================================================================
 * Yang-analyze web — fill/raster.js
 * 影像工具：彩色／灰階 → 二值 Bitmap（最大色版 + Otsu，紅/藍印章自動變白）、
 * Bitmap → RGBA / PBM（給 Tesseract）/ PNG / data URL、縮放、旋轉、裁切，
 * 以及瀏覽器影像解碼（createImageBitmap + canvas；TIFF 交給 ccitt.js，BMP/PBM 純 JS）。
 * 純運算函式（binarize / encodePBM / encodePNG / scaleBitmap …）不碰 DOM，Node 可測；
 * 需要 canvas 的函式會偵測環境（document / OffscreenCanvas），亦可 setCanvasFactory 注入。
 * Bitmap = {width, height, data: Uint8Array(1=墨,0=紙)}；bbox 為含端點 {x0,y0,x1,y1}。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  /* ---------------- 共用 ---------------- */
  function toU8(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (b && b.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer, b.byteOffset || 0, b.byteLength);
    if (Array.isArray(b)) return new Uint8Array(b);
    throw new Error("raster：需要 Uint8Array / ArrayBuffer");
  }
  function checkBin(bin) {
    if (!bin || !(bin.width > 0) || !(bin.height > 0) || !bin.data || bin.data.length < bin.width * bin.height) {
      throw new Error("raster：輸入必須是 Bitmap {width, height, data}");
    }
  }
  /** bbox 正規化並裁到影像範圍；無 bbox 取整張；完全在外回傳 null */
  function clampBox(bin, bbox) {
    var w = bin.width, h = bin.height;
    if (!bbox) return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    var x0 = Math.max(0, Math.floor(Math.min(bbox.x0, bbox.x1))), y0 = Math.max(0, Math.floor(Math.min(bbox.y0, bbox.y1)));
    var x1 = Math.min(w - 1, Math.ceil(Math.max(bbox.x0, bbox.x1))), y1 = Math.min(h - 1, Math.ceil(Math.max(bbox.y0, bbox.y1)));
    if (!(x1 >= x0 && y1 >= y0)) return null;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  var ASCII = function (s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255; return a; };
  function concat(parts) {
    var n = 0, i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n), o = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }

  /* ---------------- 二值化 ---------------- */
  /** Otsu 門檻：回傳 t（類別 0 = 值 ≤ t）；全白等退化情形回傳 -1 */
  function otsu(hist) {
    var total = 0, sumAll = 0, t;
    for (t = 0; t < 256; t++) { total += hist[t]; sumAll += t * hist[t]; }
    if (!total) return -1;
    var wB = 0, sumB = 0, best = -1, bestT = -1;
    for (t = 0; t < 255; t++) {
      wB += hist[t];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      var mB = sumB / wB, mF = (sumAll - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; bestT = t; }
    }
    return bestT;
  }

  /**
   * binarize(rgba, width, height, opts?) → Bitmap（另附 .threshold）
   * 預設「最大色版」：max(R,G,B) < T 為墨（紅/藍印章、彩色註記變紙色，黑字保留）。
   * T 由 Otsu 求得並限制在 [110,185]（opts.min/opts.max 可改；灰階掃描稿 Otsu 常落在 190 以上，
   * 筆畫過粗反而讓 OCR 把「<」讀成「《」，185 實測較佳）；opts.threshold 可直接指定。
   * opts.mode: "max"（預設）| "luma"（亮度）| "min"（最小色版，保留彩色筆跡）。
   * 透明像素視為紙（以白底合成）。
   */
  function binarize(rgba, width, height, opts) {
    opts = opts || {};
    width = width | 0; height = height | 0;
    var n = width * height;
    if (!(width > 0 && height > 0)) throw new Error("raster.binarize：寬高無效");
    if (!rgba || rgba.length < n * 4) throw new Error("raster.binarize：RGBA 資料長度不足");
    var mode = opts.mode || "max", hist = new Float64Array(256), p, q;
    function val(q) {
      var r = rgba[q], g = rgba[q + 1], b = rgba[q + 2], a = rgba[q + 3], v;
      if (mode === "luma") v = (r * 77 + g * 150 + b * 29) >> 8;
      else if (mode === "min") v = r < g ? (r < b ? r : b) : (g < b ? g : b);
      else v = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (a !== 255) v = 255 - (((255 - v) * a + 127) / 255 | 0);
      return v;
    }
    var T;
    if (opts.threshold != null && isFinite(opts.threshold)) T = +opts.threshold;
    else {
      // 大圖取樣建直方圖即可
      var step = n > 4e6 ? 3 : 1;
      for (p = 0, q = 0; p < n; p += step, q += 4 * step) hist[val(q)]++;
      var t = otsu(hist), lo = opts.min != null ? opts.min : 110, hi = opts.max != null ? opts.max : 185;
      T = t < 0 ? lo : t + 1;
      if (T < lo) T = lo;
      if (T > hi) T = hi;
    }
    var out = new Uint8Array(n);
    for (p = 0, q = 0; p < n; p++, q += 4) if (val(q) < T) out[p] = 1;
    return { width: width, height: height, data: out, threshold: T };
  }

  /** 灰階（每像素 1 byte）→ RGBA，方便沿用 binarize */
  function grayToRGBA(gray, width, height) {
    var n = width * height, out = new Uint8ClampedArray(n * 4);
    for (var p = 0, q = 0; p < n; p++, q += 4) { var v = gray[p]; out[q] = v; out[q + 1] = v; out[q + 2] = v; out[q + 3] = 255; }
    return out;
  }

  /* ---------------- Bitmap 基本操作 ---------------- */
  function cropBitmap(bin, bbox) {
    checkBin(bin);
    var b = clampBox(bin, bbox);
    if (!b) return { width: 0, height: 0, data: new Uint8Array(0) };
    var w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      var s = (y + b.y0) * bin.width + b.x0;
      out.set(bin.data.subarray(s, s + w), y * w);
    }
    return { width: w, height: h, data: out };
  }

  /**
   * scaleBitmap(bin, factor) → Bitmap。factor < 1：方框縮小，方框內墨點 ≥ 1/3 即為墨（細線不會消失）；
   * factor > 1：最近鄰放大。factor = 1 回傳原物件。
   */
  function scaleBitmap(bin, factor) {
    checkBin(bin);
    if (!(factor > 0)) throw new Error("raster.scaleBitmap：倍率必須 > 0");
    if (factor === 1) return bin;
    var w = bin.width, h = bin.height, d = bin.data;
    var W = Math.max(1, Math.round(w * factor)), H = Math.max(1, Math.round(h * factor));
    var out = new Uint8Array(W * H), x, y, X, Y;
    if (factor > 1) {
      var sx = new Int32Array(W);
      for (X = 0; X < W; X++) sx[X] = Math.min(w - 1, Math.floor(X * w / W));
      for (Y = 0; Y < H; Y++) {
        var so = Math.min(h - 1, Math.floor(Y * h / H)) * w, oo = Y * W;
        for (X = 0; X < W; X++) out[oo + X] = d[so + sx[X]] ? 1 : 0;
      }
      return { width: W, height: H, data: out };
    }
    // 每個來源欄 → 目標欄；每個目標欄的來源寬度
    var mapX = new Int32Array(w), colW = new Int32Array(W);
    for (x = 0; x < w; x++) { X = Math.min(W - 1, Math.floor(x * W / w)); mapX[x] = X; colW[X]++; }
    var acc = new Int32Array(W), y0 = 0;
    for (Y = 0; Y < H; Y++) {
      var y1 = Y === H - 1 ? h : Math.floor((Y + 1) * h / H);
      if (y1 <= y0) y1 = Math.min(h, y0 + 1);
      acc.fill(0);
      for (y = y0; y < y1; y++) {
        var off = y * w;
        for (x = 0; x < w; x++) if (d[off + x]) acc[mapX[x]]++;
      }
      var rows = y1 - y0, oo2 = Y * W;
      for (X = 0; X < W; X++) if (acc[X] * 3 >= colW[X] * rows && acc[X] > 0) out[oo2 + X] = 1;
      y0 = y1;
    }
    return { width: W, height: H, data: out };
  }

  /**
   * normalize(bin, dpi?, opts?) → {bitmap, dpi, factor}
   * 解析度過高（> target*1.1，預設 target=300）時縮到 target dpi；未知 dpi 但長邊 > 4200px 時縮到 A4 300dpi 尺寸。
   */
  function normalize(bin, dpi, opts) {
    checkBin(bin);
    opts = opts || {};
    var target = opts.target || 300, factor = 1;
    if (dpi > target * 1.1) factor = target / dpi;
    else if (!(dpi > 0)) {
      var L = Math.max(bin.width, bin.height);
      if (L > 4200) factor = 3508 / L;
    }
    if (factor === 1) return { bitmap: bin, dpi: dpi || null, factor: 1 };
    return { bitmap: scaleBitmap(bin, factor), dpi: dpi > 0 ? dpi * factor : null, factor: factor };
  }

  /**
   * rotateBitmap(bin, deg) → Bitmap（同尺寸，以中心旋轉，最近鄰；超出部分為紙）。
   * 角度定義與 YF.grid.deskewAngle 相同（正值 = 水平線往右下傾）；校正歪斜請傳 -angle。
   */
  function rotateBitmap(bin, deg) {
    checkBin(bin);
    if (!deg) return bin;
    var w = bin.width, h = bin.height, d = bin.data, out = new Uint8Array(w * h);
    var th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    var cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (var Y = 0; Y < h; Y++) {
      var dy = Y - cy;
      // 反向映射：src = R(-θ)(dst - c) + c
      var sx = -c * cx + s * dy + cx, sy = s * cx + c * dy + cy, oo = Y * w;
      for (var X = 0; X < w; X++, sx += c, sy -= s) {
        var ix = Math.round(sx), iy = Math.round(sy);
        if (ix >= 0 && iy >= 0 && ix < w && iy < h && d[iy * w + ix]) out[oo + X] = 1;
      }
    }
    return { width: w, height: h, data: out };
  }

  /**
   * bitmapToRGBA(bin, bbox?, scale?) → {width, height, data: Uint8ClampedArray}
   * 墨 = 黑、紙 = 白；scale < 1 時以面積平均成灰階（縮圖較清楚），> 1 最近鄰放大。
   */
  function bitmapToRGBA(bin, bbox, scale) {
    var g = bitmapToGray(bin, bbox, scale);
    return { width: g.width, height: g.height, data: grayToRGBA(g.data, g.width, g.height) };
  }
  /** 同上但輸出 8 位元灰階（內部與 PNG 用） */
  function bitmapToGray(bin, bbox, scale) {
    checkBin(bin);
    var b = clampBox(bin, bbox);
    if (!b) return { width: 0, height: 0, data: new Uint8Array(0) };
    scale = scale > 0 ? scale : 1;
    var bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, d = bin.data, w = bin.width;
    var W = Math.max(1, Math.round(bw * scale)), H = Math.max(1, Math.round(bh * scale));
    var out = new Uint8Array(W * H), x, y, X, Y;
    if (scale >= 1) {
      var sx = new Int32Array(W);
      for (X = 0; X < W; X++) sx[X] = b.x0 + Math.min(bw - 1, Math.floor(X * bw / W));
      for (Y = 0; Y < H; Y++) {
        var so = (b.y0 + Math.min(bh - 1, Math.floor(Y * bh / H))) * w, oo = Y * W;
        for (X = 0; X < W; X++) out[oo + X] = d[so + sx[X]] ? 0 : 255;
      }
      return { width: W, height: H, data: out };
    }
    var mapX = new Int32Array(bw), colW = new Int32Array(W);
    for (x = 0; x < bw; x++) { X = Math.min(W - 1, Math.floor(x * W / bw)); mapX[x] = X; colW[X]++; }
    var acc = new Int32Array(W), y0 = 0;
    for (Y = 0; Y < H; Y++) {
      var y1 = Y === H - 1 ? bh : Math.floor((Y + 1) * bh / H);
      if (y1 <= y0) y1 = Math.min(bh, y0 + 1);
      acc.fill(0);
      for (y = y0; y < y1; y++) {
        var off = (y + b.y0) * w + b.x0;
        for (x = 0; x < bw; x++) if (d[off + x]) acc[mapX[x]]++;
      }
      var rows = y1 - y0, o2 = Y * W;
      for (X = 0; X < W; X++) out[o2 + X] = 255 - Math.round(255 * acc[X] / (colW[X] * rows));
      y0 = y1;
    }
    return { width: W, height: H, data: out };
  }

  /* ---------------- PBM ---------------- */
  /**
   * encodePBM(bin, bbox?, pad?, mask?) → Uint8Array（PBM P4，1 = 黑）。
   * pad：四周白邊像素；mask[p] 非 0 的像素輸出為紙（去除格線）。
   * bbox 若帶有 frame（YF.grid.cellInk 在歪斜頁回傳的 bbox 附帶），框外像素也輸出為紙。
   */
  function encodePBM(bin, bbox, pad, mask) {
    checkBin(bin);
    pad = Math.max(0, pad | 0);
    var b = clampBox(bin, bbox), w = bin.width, d = bin.data, fr = bbox && bbox.frame;
    var bw = b ? b.x1 - b.x0 + 1 : 0, bh = b ? b.y1 - b.y0 + 1 : 0;
    var W = Math.max(1, bw + 2 * pad), H = Math.max(1, bh + 2 * pad), rb = (W + 7) >> 3;
    var head = ASCII("P4\n" + W + " " + H + "\n"), body = new Uint8Array(rb * H);
    if (b) {
      for (var y = 0; y < bh; y++) {
        var so = (y + b.y0) * w + b.x0, ro = (y + pad) * rb;
        for (var x = 0; x < bw; x++) {
          var p = so + x;
          if (!d[p] || (mask && mask[p])) continue;
          if (fr) {
            var gx = x + b.x0, gy = y + b.y0, u = gx + fr.s * (gy - fr.cy), v = gy - fr.s * (gx - fr.cx);
            if (u < fr.l || u > fr.r || v < fr.t || v > fr.b) continue;
          }
          var X = x + pad; body[ro + (X >> 3)] |= 0x80 >> (X & 7);
        }
      }
    }
    return concat([head, body]);
  }

  /** decodePBM(bytes) → Bitmap（支援 P4 二進位與 P1 文字格式，含 # 註解） */
  function decodePBM(bytes) {
    var b = toU8(bytes), i = 0, tok = [];
    function ws(c) { return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0b || c === 0x0c; }
    while (tok.length < 3 && i < b.length) {
      while (i < b.length && ws(b[i])) i++;
      if (b[i] === 0x23) { while (i < b.length && b[i] !== 0x0a && b[i] !== 0x0d) i++; continue; }
      var j = i;
      while (j < b.length && !ws(b[j]) && b[j] !== 0x23) j++;
      tok.push(String.fromCharCode.apply(null, b.subarray(i, j)));
      i = j;
    }
    if (tok[0] !== "P4" && tok[0] !== "P1") throw new Error("PBM：不支援的格式 " + (tok[0] || "(空)"));
    var w = parseInt(tok[1], 10), h = parseInt(tok[2], 10);
    if (!(w > 0 && h > 0) || w * h > 4e8) throw new Error("PBM：尺寸無效");
    var out = new Uint8Array(w * h), x, y;
    if (tok[0] === "P4") {
      i++;      // 單一空白
      var rb = (w + 7) >> 3;
      for (y = 0; y < h; y++) {
        var ro = i + y * rb;
        if (ro >= b.length) break;
        for (x = 0; x < w; x++) {
          var byte = b[ro + (x >> 3)];
          if (byte !== undefined && (byte >> (7 - (x & 7))) & 1) out[y * w + x] = 1;
        }
      }
    } else {
      var k = 0;
      for (; i < b.length && k < w * h; i++) {
        var c = b[i];
        if (c === 0x23) { while (i < b.length && b[i] !== 0x0a) i++; continue; }
        if (c === 0x31) out[k++] = 1; else if (c === 0x30) k++;
      }
    }
    return { width: w, height: h, data: out };
  }

  /* ---------------- PNG（純 JS：固定 Huffman + LZ77） ---------------- */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  function crc32(bytes, start, end, crc) {
    var c = crc == null ? -1 : crc;
    for (var i = start; i < end; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return c;
  }
  function adler32(b) {
    var a = 1, s = 0, n = b.length, i = 0;
    while (i < n) {
      var m = Math.min(n, i + 3800);
      for (; i < m; i++) { a += b[i]; s += a; }
      a %= 65521; s %= 65521;
    }
    return ((s << 16) | a) >>> 0;
  }
  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  /** deflate（RFC 1951，單一固定 Huffman 區塊）— 二值/灰階影像壓縮率已足夠 */
  function deflateFixed(data) {
    var n = data.length, out = new Uint8Array(Math.max(64, (n * 1.2 | 0) + 64)), op = 0, bitBuf = 0, bitCnt = 0;
    function ensure() { if (op + 8 > out.length) { var o2 = new Uint8Array(out.length * 2); o2.set(out); out = o2; } }
    function putBits(v, nb) {      // LSB 先
      bitBuf |= v << bitCnt; bitCnt += nb;
      while (bitCnt >= 8) { ensure(); out[op++] = bitBuf & 255; bitBuf >>>= 8; bitCnt -= 8; }
    }
    function putRev(code, len) {   // Huffman 碼 MSB 先 → 反轉後寫入
      var r = 0;
      for (var i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>= 1; }
      putBits(r, len);
    }
    function lit(v) {
      if (v < 144) putRev(0x30 + v, 8);
      else if (v < 256) putRev(0x190 + v - 144, 9);
      else if (v < 280) putRev(v - 256, 7);
      else putRev(0xC0 + v - 280, 8);
    }
    function match(len, dist) {
      var c = 0;
      while (c < 28 && LEN_BASE[c + 1] <= len) c++;
      lit(257 + c);
      if (LEN_EXTRA[c]) putBits(len - LEN_BASE[c], LEN_EXTRA[c]);
      var dc = 0;
      while (dc < 29 && DIST_BASE[dc + 1] <= dist) dc++;
      putRev(dc, 5);
      if (DIST_EXTRA[dc]) putBits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
    putBits(1, 1); putBits(1, 2);   // BFINAL=1, BTYPE=01
    var HB = 15, HS = 1 << HB, head = new Int32Array(HS).fill(-1), prev = new Int32Array(32768), WIN = 32768;
    function hash(i) { return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HS - 1); }
    var i = 0;
    while (i < n) {
      var bestLen = 0, bestDist = 0;
      if (i + 2 < n) {
        var hh = hash(i), cand = head[hh], chain = 0, maxLen = Math.min(258, n - i);
        while (cand >= 0 && i - cand <= WIN && chain++ < 24) {
          if (data[cand + bestLen] === data[i + bestLen]) {
            var L = 0;
            while (L < maxLen && data[cand + L] === data[i + L]) L++;
            if (L > bestLen) { bestLen = L; bestDist = i - cand; if (L === maxLen) break; }
          }
          cand = prev[cand & (WIN - 1)];
        }
        prev[i & (WIN - 1)] = head[hh]; head[hh] = i;
      }
      if (bestLen >= 3) {
        match(bestLen, bestDist);
        for (var k = 1; k < bestLen; k++) {
          var j = i + k;
          if (j + 2 < n) { var h2 = hash(j); prev[j & (WIN - 1)] = head[h2]; head[h2] = j; }
        }
        i += bestLen;
      } else { lit(data[i]); i++; }
    }
    lit(256);
    if (bitCnt > 0) { ensure(); out[op++] = bitBuf & 255; }
    return out.subarray(0, op);
  }
  function zlibWrap(raw) {
    var def = deflateFixed(raw), ad = adler32(raw), out = new Uint8Array(def.length + 6);
    out[0] = 0x78; out[1] = 0x01;
    out.set(def, 2);
    var o = def.length + 2;
    out[o] = ad >>> 24; out[o + 1] = (ad >>> 16) & 255; out[o + 2] = (ad >>> 8) & 255; out[o + 3] = ad & 255;
    return out;
  }
  function pngChunk(type, data) {
    var len = data.length, out = new Uint8Array(12 + len), i;
    out[0] = len >>> 24; out[1] = (len >>> 16) & 255; out[2] = (len >>> 8) & 255; out[3] = len & 255;
    for (i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    var c = crc32(out, 4, 8 + len) ^ -1;
    out[8 + len] = c >>> 24; out[9 + len] = (c >>> 16) & 255; out[10 + len] = (c >>> 8) & 255; out[11 + len] = c & 255;
    return out;
  }
  /**
   * encodePNG(bin, bbox?, scale?) → Uint8Array（PNG）。scale = 1 時為 1 位元灰階；
   * scale < 1 時輸出 8 位元灰階縮圖（面積平均）。
   */
  function encodePNG(bin, bbox, scale) {
    checkBin(bin);
    scale = scale > 0 ? scale : 1;
    var W, H, raw, y, x;
    if (scale === 1) {
      var b = clampBox(bin, bbox) || { x0: 0, y0: 0, x1: -1, y1: -1 };
      W = Math.max(1, b.x1 - b.x0 + 1); H = Math.max(1, b.y1 - b.y0 + 1);
      var rb = (W + 7) >> 3, w = bin.width, d = bin.data;
      raw = new Uint8Array((rb + 1) * H);
      for (y = 0; y < H; y++) {
        var ro = y * (rb + 1);
        raw[ro] = 0;                                  // filter: None
        for (var k = 1; k <= rb; k++) raw[ro + k] = 0xFF;     // 1 = 白
        if (b.x1 < b.x0) continue;
        var so = (y + b.y0) * w + b.x0;
        for (x = 0; x < W; x++) if (d[so + x]) raw[ro + 1 + (x >> 3)] &= ~(0x80 >> (x & 7));
      }
      return makePng(W, H, 1, raw);
    }
    var g = bitmapToGray(bin, bbox, scale);
    W = g.width; H = g.height;
    raw = new Uint8Array((W + 1) * H);
    for (y = 0; y < H; y++) { raw[y * (W + 1)] = 0; raw.set(g.data.subarray(y * W, (y + 1) * W), y * (W + 1) + 1); }
    return makePng(W, H, 8, raw);
  }
  function makePng(W, H, depth, raw) {
    var ihdr = new Uint8Array(13);
    ihdr[0] = W >>> 24; ihdr[1] = (W >>> 16) & 255; ihdr[2] = (W >>> 8) & 255; ihdr[3] = W & 255;
    ihdr[4] = H >>> 24; ihdr[5] = (H >>> 16) & 255; ihdr[6] = (H >>> 8) & 255; ihdr[7] = H & 255;
    ihdr[8] = depth; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return concat([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
                   pngChunk("IHDR", ihdr), pngChunk("IDAT", zlibWrap(raw)), pngChunk("IEND", new Uint8Array(0))]);
  }
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function base64(bytes) {
    var out = [], i, n = bytes.length, s = "";
    for (i = 0; i + 2 < n; i += 3) {
      var v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
      if (s.length > 8192) { out.push(s); s = ""; }
    }
    if (i < n) {
      var v2 = bytes[i] << 16 | (i + 1 < n ? bytes[i + 1] << 8 : 0);
      s += B64[v2 >> 18] + B64[(v2 >> 12) & 63] + (i + 1 < n ? B64[(v2 >> 6) & 63] : "=") + "=";
    }
    out.push(s);
    return out.join("");
  }

  /* ---------------- BMP（純 JS，未壓縮 1/4/8/24/32 位元） ---------------- */
  function decodeBMP(bytes) {
    var b = toU8(bytes);
    if (b.length < 54 || b[0] !== 0x42 || b[1] !== 0x4D) return null;
    var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    var off = dv.getUint32(10, true), hs = dv.getUint32(14, true);
    if (hs < 40) return null;
    var w = dv.getInt32(18, true), hRaw = dv.getInt32(22, true), bpp = dv.getUint16(28, true), comp = dv.getUint32(30, true);
    var h = Math.abs(hRaw), topDown = hRaw < 0;
    if (!(w > 0 && h > 0) || w * h > 1e8) return null;
    if (comp !== 0 && !(comp === 3 && (bpp === 32 || bpp === 16))) return null;
    if ([1, 4, 8, 24, 32].indexOf(bpp) < 0) return null;
    var nPal = dv.getUint32(46, true) || (bpp <= 8 ? 1 << bpp : 0), pal = [];
    for (var k = 0; k < nPal && 14 + hs + k * 4 + 3 < b.length; k++) {
      var po = 14 + hs + k * 4;
      pal.push([b[po + 2], b[po + 1], b[po]]);
    }
    var stride = ((w * bpp + 31) >> 5) << 2, out = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      var sy = topDown ? y : h - 1 - y, ro = off + sy * stride;
      if (ro + stride > b.length) continue;
      for (var x = 0; x < w; x++) {
        var r, g, bl, q = (y * w + x) * 4;
        if (bpp >= 24) { var pp = ro + x * (bpp >> 3); bl = b[pp]; g = b[pp + 1]; r = b[pp + 2]; }
        else {
          var idx;
          if (bpp === 8) idx = b[ro + x];
          else if (bpp === 4) idx = (b[ro + (x >> 1)] >> ((x & 1) ? 0 : 4)) & 15;
          else idx = (b[ro + (x >> 3)] >> (7 - (x & 7))) & 1;
          var c = pal[idx] || [idx ? 255 : 0, idx ? 255 : 0, idx ? 255 : 0];
          r = c[0]; g = c[1]; bl = c[2];
        }
        out[q] = r; out[q + 1] = g; out[q + 2] = bl; out[q + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }

  /* ---------------- canvas（DOM 選用） ---------------- */
  var canvasFactory = null;
  /** 測試或 Worker 可注入：fn(width, height) → 具 getContext('2d') 的物件 */
  function setCanvasFactory(fn) { canvasFactory = typeof fn === "function" ? fn : null; }
  function makeCanvas(w, h) {
    if (canvasFactory) return canvasFactory(w, h);
    if (typeof document !== "undefined" && document.createElement) {
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    return null;
  }
  function hasCanvas() {
    return !!(canvasFactory || (typeof document !== "undefined" && document.createElement) || typeof OffscreenCanvas !== "undefined");
  }

  /** bitmapToCanvas(bin, bbox?, maxWidth?) → canvas（無 canvas 環境回傳 null） */
  function bitmapToCanvas(bin, bbox, maxWidth) {
    checkBin(bin);
    var b = clampBox(bin, bbox);
    if (!b) return null;
    var bw = b.x1 - b.x0 + 1, scale = maxWidth > 0 ? Math.min(1, maxWidth / bw) : 1;
    var img = bitmapToRGBA(bin, b, scale);
    var cv = makeCanvas(img.width, img.height);
    if (!cv) return null;
    var ctx = cv.getContext("2d"), id = ctx.createImageData(img.width, img.height);
    id.data.set(img.data);
    ctx.putImageData(id, 0, 0);
    return cv;
  }

  /** bitmapToDataURL(bin, bbox?, maxWidth?) → "data:image/png;base64,…"（有 canvas 用 canvas，否則純 JS PNG） */
  function bitmapToDataURL(bin, bbox, maxWidth) {
    checkBin(bin);
    var b = clampBox(bin, bbox);
    if (!b) return "";
    var cv = null;
    try { cv = hasCanvas() ? bitmapToCanvas(bin, b, maxWidth) : null; } catch (e) { cv = null; }
    if (cv && typeof cv.toDataURL === "function") {
      try { return cv.toDataURL("image/png"); } catch (e2) { /* 改用純 JS */ }
    }
    var bw = b.x1 - b.x0 + 1, scale = maxWidth > 0 ? Math.min(1, maxWidth / bw) : 1;
    return "data:image/png;base64," + base64(encodePNG(bin, b, scale));
  }

  /* ---------------- 影像解碼（瀏覽器） ---------------- */
  function sniff(b) {
    if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpeg";
    if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0) ||
                          (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0 && b[3] === 0x2A))) return "tiff";
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return "bmp";
    if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
    if (b.length >= 2 && b[0] === 0x50 && (b[1] === 0x34 || b[1] === 0x31)) return "pbm";
    return null;
  }
  var MIME = { png: "image/png", jpeg: "image/jpeg", tiff: "image/tiff", bmp: "image/bmp", gif: "image/gif", webp: "image/webp" };

  function fromBitmap(bm, extra) {
    var rgba = bitmapToRGBA(bm);
    var r = { width: rgba.width, height: rgba.height, data: rgba.data, bitmap: bm, scale: 1 };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  /**
   * decodeImageBytes(bytes, mime?, opts?) → Promise<{width, height, data: RGBA, scale, origWidth, origHeight, bitmap?}>
   * TIFF 先用 YF.ccitt.decodeTiff（二值），BMP/PBM 純 JS，其餘交給瀏覽器
   * （createImageBitmap → canvas；退而求其次用 <img>）。像素數超過 opts.maxPixels（預設 1600 萬）時等比縮小，
   * scale 為縮放倍率（dpi 需同乘）。二值來源另附 bitmap（可略過 binarize）。
   */
  function decodeImageBytes(bytes, mime, opts) {
    opts = opts || {};
    var maxPx = opts.maxPixels || 16e6;
    return Promise.resolve().then(function () {
      var b = toU8(bytes), kind = sniff(b);
      if (kind === "tiff" && YF.ccitt && YF.ccitt.decodeTiff) {
        var ws = [], pages = YF.ccitt.decodeTiff(b, { warnings: ws });
        if (pages && pages.length) return fromBitmap(pages[0], { pages: pages, warnings: ws, origWidth: pages[0].width, origHeight: pages[0].height });
      }
      if (kind === "pbm") { var pb = decodePBM(b); return fromBitmap(pb, { origWidth: pb.width, origHeight: pb.height }); }
      var type = mime || MIME[kind] || "application/octet-stream";
      if (typeof createImageBitmap === "function" && typeof Blob !== "undefined") {
        var blob = new Blob([b], { type: type });
        return createImageBitmap(blob, { imageOrientation: "from-image" }).catch(function () {
          return createImageBitmap(blob);
        }).then(function (ib) {
          try { return drawToRGBA(ib, ib.width, ib.height, maxPx); }
          finally { if (ib.close) ib.close(); }
        }).catch(function (e) {
          if (kind === "bmp") { var bm = decodeBMP(b); if (bm) return finishRaw(bm); }
          throw new Error("影像無法解碼（" + type + "）：" + (e && e.message ? e.message : e));
        });
      }
      if (kind === "bmp") { var bm2 = decodeBMP(b); if (bm2) return finishRaw(bm2); }
      if (typeof Image !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL && typeof Blob !== "undefined") {
        return new Promise(function (resolve, reject) {
          var url = URL.createObjectURL(new Blob([b], { type: type })), im = new Image();
          im.onload = function () {
            try { resolve(drawToRGBA(im, im.naturalWidth || im.width, im.naturalHeight || im.height, maxPx)); }
            catch (e) { reject(e); }
            finally { URL.revokeObjectURL(url); }
          };
          im.onerror = function () { URL.revokeObjectURL(url); reject(new Error("影像無法解碼（" + type + "）")); };
          im.src = url;
        });
      }
      throw new Error("此環境無法解碼影像（" + type + "）");
    });
  }
  function finishRaw(img) {
    return { width: img.width, height: img.height, data: img.data, scale: 1, origWidth: img.width, origHeight: img.height };
  }
  function drawToRGBA(src, w, h, maxPx) {
    if (!(w > 0 && h > 0)) throw new Error("影像尺寸無效");
    var scale = w * h > maxPx ? Math.sqrt(maxPx / (w * h)) : 1;
    var W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
    var cv = makeCanvas(W, H);
    if (!cv) throw new Error("此環境沒有 canvas，無法解碼影像");
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);           // 透明背景視為白紙
    ctx.drawImage(src, 0, 0, W, H);
    var id = ctx.getImageData(0, 0, W, H);
    return { width: W, height: H, data: id.data, scale: scale, origWidth: w, origHeight: h };
  }

  YF.raster = {
    binarize: binarize,
    otsu: otsu,
    grayToRGBA: grayToRGBA,
    bitmapToRGBA: bitmapToRGBA,
    bitmapToCanvas: bitmapToCanvas,
    bitmapToDataURL: bitmapToDataURL,
    encodePBM: encodePBM,
    decodePBM: decodePBM,
    encodePNG: encodePNG,
    decodeBMP: decodeBMP,
    decodeImageBytes: decodeImageBytes,
    scaleBitmap: scaleBitmap,
    normalize: normalize,
    rotateBitmap: rotateBitmap,
    cropBitmap: cropBitmap,
    setCanvasFactory: setCanvasFactory,
    hasCanvas: hasCanvas,
    base64: base64,
    sniff: sniff
  };
})(typeof window !== "undefined" ? window : globalThis);
