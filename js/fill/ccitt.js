/* =========================================================================
 * Yang-analyze web — fill/ccitt.js
 * CCITT 傳真壓縮解碼器與二值 TIFF 讀取器（純邏輯、零相依，可在 Node 測試）。
 *   - decodeG4  ：ITU-T T.6（MMR / Group 4）。DocuWorks 掃描頁、TIFF Compression=4 皆用此格式。
 *   - decodeG3  ：ITU-T T.4（MH 一維 / MR 二維，含 EOL、位元組對齊 EOL、RTC），
 *                 另支援 TIFF Compression=2（CCITT RLE：無 EOL、每列位元組對齊）。
 *   - decodeTiff：二值 TIFF（Compression 1/2/3/4/5 LZW/32773 PackBits，FillOrder 1/2，
 *                 Photometric 0/1/3，多 strip、tile、多頁）→ Bitmap 陣列（每頁一個）。
 * 輸出 Bitmap：{width, height, data}，data 每像素 1 byte，1 = 墨（黑）、0 = 紙（白）。
 * 錯誤資料（截斷、雜訊、非壓縮模式延伸碼）不拋例外：回傳已解出的部分，
 * 並把中文說明推入 opts.warnings。
 * ========================================================================= */
(function (root) {
  "use strict";
  var YF = root.YangFill = root.YangFill || {};

  /* ---------------- 碼表（ITU-T T.4 表 1、2、3） ---------------- */
  // 白色終止碼：行程 0–63
  var WHITE_TERM = [
    "00110101", "000111", "0111", "1000", "1011", "1100", "1110", "1111",
    "10011", "10100", "00111", "01000", "001000", "000011", "110100", "110101",
    "101010", "101011", "0100111", "0001100", "0001000", "0010111", "0000011", "0000100",
    "0101000", "0101011", "0010011", "0100100", "0011000", "00000010", "00000011", "00011010",
    "00011011", "00010010", "00010011", "00010100", "00010101", "00010110", "00010111", "00101000",
    "00101001", "00101010", "00101011", "00101100", "00101101", "00000100", "00000101", "00001010",
    "00001011", "01010010", "01010011", "01010100", "01010101", "00100100", "00100101", "01011000",
    "01011001", "01011010", "01011011", "01001010", "01001011", "00110010", "00110011", "00110100"];
  // 白色結合碼：行程 64, 128, …, 1728
  var WHITE_MAKEUP = [
    "11011", "10010", "010111", "0110111", "00110110", "00110111", "01100100", "01100101",
    "01101000", "01100111", "011001100", "011001101", "011010010", "011010011", "011010100", "011010101",
    "011010110", "011010111", "011011000", "011011001", "011011010", "011011011", "010011000", "010011001",
    "010011010", "011000", "010011011"];
  // 黑色終止碼：行程 0–63
  var BLACK_TERM = [
    "0000110111", "010", "11", "10", "011", "0011", "0010", "00011",
    "000101", "000100", "0000100", "0000101", "0000111", "00000100", "00000111", "000011000",
    "0000010111", "0000011000", "0000001000", "00001100111", "00001101000", "00001101100", "00000110111", "00000101000",
    "00000010111", "00000011000", "000011001010", "000011001011", "000011001100", "000011001101", "000001101000", "000001101001",
    "000001101010", "000001101011", "000011010010", "000011010011", "000011010100", "000011010101", "000011010110", "000011010111",
    "000001101100", "000001101101", "000011011010", "000011011011", "000001010100", "000001010101", "000001010110", "000001010111",
    "000001100100", "000001100101", "000001010010", "000001010011", "000000100100", "000000110111", "000000111000", "000000100111",
    "000000101000", "000001011000", "000001011001", "000000101011", "000000101100", "000001011010", "000001100110", "000001100111"];
  // 黑色結合碼：行程 64, 128, …, 1728
  var BLACK_MAKEUP = [
    "0000001111", "000011001000", "000011001001", "000001011011", "000000110011", "000000110100", "000000110101", "0000001101100",
    "0000001101101", "0000001001010", "0000001001011", "0000001001100", "0000001001101", "0000001110010", "0000001110011", "0000001110100",
    "0000001110101", "0000001110110", "0000001110111", "0000001010010", "0000001010011", "0000001010100", "0000001010101", "0000001011010",
    "0000001011011", "0000001100100", "0000001100101"];
  // 延伸結合碼（黑白共用）：行程 1792, 1856, …, 2560
  var EXT_MAKEUP = [
    "00000001000", "00000001100", "00000001101", "000000010010", "000000010011", "000000010100", "000000010101",
    "000000010110", "000000010111", "000000011100", "000000011101", "000000011110", "000000011111"];
  var EOL_CODE = "000000000001";
  // 二維模式碼（T.4 表 4 / T.6 表 1）
  var M_P = 0, M_H = 1, M_V = 2, M_EXT = 3, M_ZERO = 4;
  var MODE_CODES = [
    ["0001", M_P, 0], ["001", M_H, 0], ["1", M_V, 0],
    ["011", M_V, 1], ["000011", M_V, 2], ["0000011", M_V, 3],
    ["010", M_V, -1], ["000010", M_V, -2], ["0000010", M_V, -3],
    ["0000001", M_EXT, 0]];

  var RUN_BITS = 13;           // 最長行程碼 13 位元（黑色結合碼）
  var R_INVALID = -1, R_EOL = -2;

  /* ---------------- 查表（首次使用時建立） ---------------- */
  var TABLES = null;
  function addCode(tab, bits, code, value) {
    var L = code.length, v = parseInt(code, 2), sh = bits - L;
    var from = v << sh, to = (v + 1) << sh;
    for (var i = from; i < to; i++) {
      if (tab[i] !== R_INVALID) throw new Error("CCITT 碼表衝突：" + code);
      tab[i] = value;
    }
  }
  function runTable(term, makeup) {
    var tab = new Int32Array(1 << RUN_BITS).fill(R_INVALID), i;
    // 表項 = 行程 << 4 | 碼長
    for (i = 0; i < term.length; i++) addCode(tab, RUN_BITS, term[i], (i << 4) | term[i].length);
    for (i = 0; i < makeup.length; i++) addCode(tab, RUN_BITS, makeup[i], (((i + 1) * 64) << 4) | makeup[i].length);
    for (i = 0; i < EXT_MAKEUP.length; i++) addCode(tab, RUN_BITS, EXT_MAKEUP[i], (((i + 28) * 64) << 4) | EXT_MAKEUP[i].length);
    addCode(tab, RUN_BITS, EOL_CODE, R_EOL);
    return tab;
  }
  function tables() {
    if (TABLES) return TABLES;
    var mode = new Int32Array(128).fill(R_INVALID);
    MODE_CODES.forEach(function (m) {
      // 表項 = 種類 << 8 | (位移 + 3) << 4 | 碼長
      addCode(mode, 7, m[0], (m[1] << 8) | ((m[2] + 3) << 4) | m[0].length);
    });
    mode[0] = (M_ZERO << 8) | (3 << 4) | 0;   // 0000000：EOL / EOFB / 填充或錯誤，另行判斷
    var rev = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var r = 0;
      for (var k = 0; k < 8; k++) if (i & (1 << k)) r |= 0x80 >> k;
      rev[i] = r;
    }
    TABLES = { white: runTable(WHITE_TERM, WHITE_MAKEUP), black: runTable(BLACK_TERM, BLACK_MAKEUP), mode: mode, rev: rev };
    return TABLES;
  }

  /* ---------------- 共用解碼核心 ----------------
   * kind：4 = G4（T.6），3 = G3（T.4，twoD 決定是否讀 1D/2D 標記位元），2 = CCITT RLE（TIFF Compression=2）
   * 回傳 {rows: 成功解出的列數, error: "" | 錯誤說明}；像素寫入 out（1 = 黑）。
   */
  function decodeCore(src, width, height, kind, twoD, opts) {
    var T = tables(), WT = T.white, BT = T.black, MT = T.mode;
    var out = opts.out, base = opts.outOffset | 0;
    var n = src.length, totalBits = n * 8;
    var pos = 0, acc = 0, nb = 0;              // 位元讀取器：acc 低 nb 位元為尚未消耗的位元
    var ref = new Int32Array(width + 8), cur = new Int32Array(width + 8), tmp;
    var refLen = 0, curLen = 0, i;
    var rle = kind === 2, g4 = kind === 4, align = rle || !!opts.byteAlign;
    var row = 0, err = "", eofb = false, badLines = 0, firstBad = -1, eolMiss = 0, eolSeen = 0;
    for (i = 0; i < 8; i++) ref[i] = width;    // 第一列的參考列：想像的全白列

    function more() {
      while (nb <= 24) {
        acc = ((acc & 0xFFFFFF) << 8) | (pos < n ? src[pos] : 0);
        pos++; nb += 8;
      }
    }
    function used() { return pos * 8 - nb; }
    // 記錄變化點（相同位置的兩個變化互相抵銷 = 長度 0 的行程）
    function push(x) {
      if (curLen > 0 && cur[curLen - 1] === x) curLen--;
      else cur[curLen++] = x;
    }
    function readRun(tab) {
      var total = 0, e;
      for (;;) {
        if (nb < RUN_BITS) more();
        e = tab[(acc >>> (nb - RUN_BITS)) & 0x1FFF];
        if (e < 0) return e;
        nb -= e & 15;
        e >>= 4;
        total += e;
        if (e < 64) return total;              // 終止碼：行程結束
        if (total > width) return R_INVALID;   // 結合碼累加已超過列寬
      }
    }
    // 失敗原因：資料耗盡（截斷）或無效編碼
    function failCode(code) {
      if (used() >= totalBits) return "truncated";
      if (code === R_EOL) return "eol";
      return "invalid";
    }
    // 一維（MH）列
    function line1D() {
      var a0 = 0, color = 0, r;
      curLen = 0;
      while (a0 < width) {
        r = readRun(color ? BT : WT);
        if (r < 0) return failCode(r);
        a0 += r;
        if (a0 > width) return "length";
        if (a0 < width) push(a0);
        color ^= 1;
      }
      return "";
    }
    // 二維（MR / MMR）列：以 ref 為參考列
    function line2D() {
      var a0 = -1, color = 0, bi = 0, b1, m, k, d, a1, a2, r1, r2, s;
      curLen = 0;
      while (a0 < width) {
        while (ref[bi] <= a0 && ref[bi] < width) bi += 2;   // b1：a0 右側、與 a0 異色的第一個變化點
        b1 = ref[bi];
        if (nb < 13) more();
        m = MT[(acc >>> (nb - 7)) & 0x7F];
        nb -= m & 15;
        k = m >> 8;
        if (k === M_V) {
          d = ((m >> 4) & 15) - 3;
          a1 = b1 + d;
          if (a1 < (a0 < 0 ? 0 : a0) || a1 > width) return used() >= totalBits ? "truncated" : "invalid";
          if (a1 < width) push(a1);
          a0 = a1; color ^= 1;
          if (d >= 0) bi++;
          else if (--bi < 0) bi = 1;
        } else if (k === M_H) {
          s = a0 < 0 ? 0 : a0;
          r1 = readRun(color ? BT : WT);
          if (r1 < 0) return failCode(r1);
          r2 = readRun(color ? WT : BT);
          if (r2 < 0) return failCode(r2);
          a1 = s + r1; a2 = a1 + r2;
          if (a2 > width) return "length";
          if (a1 < width) push(a1);
          if (a2 < width) push(a2);
          a0 = a2;
        } else if (k === M_P) {
          a0 = ref[bi + 1];                   // b2
          bi += 2;
        } else if (k === M_EXT) {
          return "ext";
        } else {
          // 0000000：EOL（12 位元）或錯誤
          if (((acc >>> (nb - 12)) & 0xFFF) === 1) {
            if (a0 < 0) { nb -= 12; return "eol-start"; }
            return "eol";
          }
          return used() >= totalBits ? "truncated" : "invalid";
        }
      }
      return "";
    }
    // 把目前列的變化點畫進輸出；lineEnd 之後不上色（錯誤列只畫已解出的部分）
    function render(lineEnd) {
      var o = base + row * width, x0, x1, j;
      for (i = 0; i < curLen; i += 2) {
        x0 = cur[i];
        x1 = i + 1 < curLen ? cur[i + 1] : lineEnd;
        if (x1 > lineEnd) x1 = lineEnd;
        if (x1 - x0 > 24) out.fill(1, o + x0, o + x1);
        else for (j = o + x0; j < o + x1; j++) out[j] = 1;
      }
    }
    function swap() {
      tmp = ref; ref = cur; cur = tmp;
      refLen = curLen;
      for (i = 0; i < 6; i++) ref[refLen + i] = width;
    }
    function alignByte() {
      var r = used() & 7;
      if (r) { if (nb < 8) more(); nb -= 8 - r; }
    }
    // G3：跳過填充位元與 EOL，回傳讀到的 EOL 數；-1 = 資料結束
    function syncEol() {
      var count = 0, p;
      for (;;) {
        if (nb < 13) more();
        if (used() >= totalBits) return count > 0 ? count : -1;
        p = (acc >>> (nb - 12)) & 0xFFF;
        if (p === 1) {
          nb -= 12; count++;
          // 二維模式下 RTC = (EOL + 標記位元) × 6
          if (twoD) { if (nb < 13) more(); if (((acc >>> (nb - 13)) & 0xFFF) === 1) { nb -= 1; } }
          continue;
        }
        if ((p >>> 4) === 0) { nb -= 1; continue; }   // 前導 8 個以上的 0 = EOL 前的填充位元
        return count;
      }
    }
    // G3 錯誤後同步到下一個 EOL（不消耗 EOL 本身）；回傳 false = 資料結束
    function resync() {
      for (;;) {
        if (nb < 13) more();
        if (used() >= totalBits) return false;
        if (((acc >>> (nb - 12)) & 0xFFF) === 1) return true;
        nb -= 1;
      }
    }

    var res, c, oneD;
    for (row = 0; row < height; row++) {
      if (g4) {
        if (align && row > 0) alignByte();
        res = line2D();
        if (res === "eol-start") {
          // EOFB（EOL EOL）或多餘的 EOL：視為資料結束
          eofb = true;
          break;
        }
        if (res) { render(curLen ? Math.max(0, Math.min(width, cur[curLen - 1])) : 0); err = res; break; }
        render(width);
        if (used() > totalBits) { err = "truncated"; break; }   // 這一列用到了檔尾之後的位元：不可信
        swap();
        continue;
      }
      // ---- G3 / RLE ----
      oneD = true;
      if (rle) {
        if (row > 0) alignByte();
        if (used() >= totalBits) { err = "truncated"; break; }
      } else {
        if (opts.byteAlign && row > 0) alignByte();
        c = syncEol();
        if (c < 0) { err = "truncated"; break; }
        if (c > 0) eolSeen++;
        else if (row > 0 && eolSeen) eolMiss++;     // 有 EOL 的串流卻在列首找不到 EOL：多半是 1D/2D 判斷錯

        if (c >= 2 && row > 0) { eofb = true; break; }     // RTC：資料結束
        if (twoD) {
          if (c > 0) {
            if (nb < 13) more();
            oneD = ((acc >>> (nb - 1)) & 1) === 1;
            nb -= 1;
          } else {
            oneD = row === 0;   // 缺 EOL 時無標記位元：第一列假設為一維，其後二維
          }
        }
      }
      res = oneD ? line1D() : line2D();
      if (res === "eol" || res === "eol-start") res = "invalid";   // G3 列中不應出現 EOL
      if (res) {
        render(curLen ? Math.max(0, Math.min(width, cur[curLen - 1])) : 0);
        badLines++;
        if (firstBad < 0) firstBad = row;
        if (res === "ext" || res === "truncated" || rle || !resync()) { err = res; break; }
        // 已同步到下一個 EOL：錯誤列當作參考列（之後的一維列會恢復正確）
        swap();
        continue;
      }
      render(width);
      if (used() > totalBits) { err = "truncated"; break; }
      swap();
    }
    // G3 結尾檢查：正確解讀時，最後一列之後應是 EOL / RTC 或補零（給 1D/2D 自動判斷用）
    if (!g4 && !rle && !err && row === height && used() < totalBits) {
      if (nb < 13) more();
      var tail = (acc >>> (nb - 12)) & 0xFFF;
      if (tail !== 1 && tail !== 0) eolMiss++;
    }
    return { rows: row, error: err, eofb: eofb, badLines: badLines, firstBad: firstBad, eolMiss: eolMiss };
  }

  var ERR_TEXT = {
    truncated: "資料提前結束（檔案可能被截斷）",
    invalid: "遇到無效的編碼（資料損毀）",
    length: "列長度不符（行程超過影像寬度）",
    eol: "列中出現意外的 EOL",
    ext: "遇到「非壓縮模式」延伸碼，本解碼器不支援"
  };
  function report(label, res, width, height, opts) {
    var w = opts.warnings;
    opts.rowsDecoded = res.rows;
    opts.error = res.error;            // "" | "truncated" | "invalid" | "length" | "eol" | "ext"
    if (!w) return;
    if (res.error) {
      w.push(label + "：第 " + (res.rows + 1) + " 列" + (ERR_TEXT[res.error] || res.error) +
        "，已解出 " + res.rows + "/" + height + " 列，其餘留白。");
    } else if (res.badLines) {
      w.push(label + "：有 " + res.badLines + " 列資料錯誤（第一處在第 " + (res.firstBad + 1) + " 列），已跳過。");
    } else if (res.eofb && res.rows < height) {
      w.push(label + "：資料在第 " + res.rows + " 列就結束（共 " + height + " 列），其餘留白。");
    }
  }
  function checkSize(width, height) {
    return width > 0 && height > 0 && width <= 65535 && height <= 65535 && width * height <= 400e6 &&
      width === Math.floor(width) && height === Math.floor(height);
  }
  function prepOut(width, height, opts) {
    if (opts.out) {
      var o = opts.outOffset | 0;
      if (opts.out.length < o + width * height) throw new Error("CCITT：輸出緩衝區太小");
      opts.out.fill(0, o, o + width * height);    // 解碼器只寫入黑點，目標區域先清白
      return opts.out;
    }
    return new Uint8Array(width * height);
  }
  function asBytes(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    if (b && b.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return new Uint8Array(0);
  }

  /**
   * CCITT T.6（G4）解碼。
   * opts：{warnings?: [], out?: Uint8Array（寫入 out[outOffset …]，該區域會先清為 0）, outOffset?: number,
   *        byteAlign?: bool（每列位元組對齊，PDF EncodedByteAlign）}
   * 解碼後 opts.rowsDecoded = 成功解出的列數、opts.error = "" | "truncated" | "invalid" | "length" | "eol" | "ext" | "size"。
   * 回傳 Uint8Array(width*height)（若給 out 則回傳 out）；尺寸不合理（≤0、>65535 或總像素 > 4 億）時回傳空陣列。
   */
  function decodeG4(bytes, width, height, opts) {
    opts = opts || {};
    width = width | 0; height = height | 0;
    if (!checkSize(width, height)) {
      if (opts.warnings) opts.warnings.push("CCITT G4：影像尺寸不合理（" + width + "×" + height + "）。");
      opts.rowsDecoded = 0; opts.error = "size";
      return new Uint8Array(0);
    }
    var out = prepOut(width, height, opts);
    var o2 = { out: out, outOffset: opts.outOffset | 0, byteAlign: opts.byteAlign };
    var res = decodeCore(asBytes(bytes), width, height, 4, false, o2);
    report("CCITT G4 解碼", res, width, height, opts);
    return out;
  }

  function g3Score(r, height) { return (r.error ? 1000 : 0) + (height - r.rows) * 10 + r.badLines * 10 + r.eolMiss; }

  /**
   * CCITT T.4（G3）解碼。
   * opts：{twoD?: bool（未指定則自動判斷）, rle?: bool（TIFF Compression=2）, byteAlign?, warnings?, out?, outOffset?}
   */
  function decodeG3(bytes, width, height, opts) {
    opts = opts || {};
    width = width | 0; height = height | 0;
    if (!checkSize(width, height)) {
      if (opts.warnings) opts.warnings.push("CCITT G3：影像尺寸不合理（" + width + "×" + height + "）。");
      opts.rowsDecoded = 0; opts.error = "size";
      return new Uint8Array(0);
    }
    var src = asBytes(bytes), out = prepOut(width, height, opts), base = opts.outOffset | 0;
    var kind = opts.rle ? 2 : 3, res, label = opts.rle ? "CCITT RLE 解碼" : "CCITT G3 解碼";
    if (opts.rle || opts.twoD === true || opts.twoD === false) {
      res = decodeCore(src, width, height, kind, !opts.rle && opts.twoD === true, { out: out, outOffset: base, byteAlign: opts.byteAlign });
    } else {
      // 自動判斷一維 / 二維：先試一維；有錯誤、壞列或列首缺 EOL 時再試二維，取問題較少者
      res = decodeCore(src, width, height, 3, false, { out: out, outOffset: base, byteAlign: opts.byteAlign });
      if (res.error || res.badLines || res.eolMiss) {
        var alt = new Uint8Array(width * height);
        var res2 = decodeCore(src, width, height, 3, true, { out: alt, outOffset: 0, byteAlign: opts.byteAlign });
        if (g3Score(res2, height) < g3Score(res, height)) {
          out.set(alt, base);
          res = res2;
        }
      }
    }
    report(label, res, width, height, opts);
    return out;
  }

  /* ---------------- PackBits / LZW（TIFF 用） ---------------- */
  function unpackBitsTiff(src, expected) {
    var out = new Uint8Array(expected), ip = 0, op = 0, n = src.length, c, k;
    while (ip < n && op < expected) {
      c = src[ip++];
      if (c < 128) {                       // 複製 c+1 個位元組
        for (k = 0; k <= c && ip < n && op < expected; k++) out[op++] = src[ip++];
      } else if (c > 128) {                // 重複下一個位元組 257-c 次
        if (ip >= n) break;
        var v = src[ip++];
        for (k = 0; k < 257 - c && op < expected; k++) out[op++] = v;
      }                                    // 128 = no-op
    }
    return { data: out, short: op < expected };
  }
  // TIFF LZW（MSB 優先、9–12 位元碼、Clear=256、EOI=257、「提早換寬」）
  function lzwDecode(src, expected) {
    var out = new Uint8Array(expected), op = 0;
    var prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Int32Array(4096);
    for (var i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; first[i] = i; len[i] = 1; }
    var nBits = src.length * 8, bitPos = 0, width = 9, next = 258, old = -1, code, c, L, p, j, b, bp, kwk;
    for (;;) {
      if (bitPos + width > nBits) break;                     // 資料結束（缺 EOI）
      code = 0; bp = bitPos;
      for (b = 0; b < width; b++, bp++) code = (code << 1) | ((src[bp >> 3] >> (7 - (bp & 7))) & 1);
      bitPos += width;
      if (code === 257) break;                               // EOI
      if (code === 256) { width = 9; next = 258; old = -1; continue; }   // Clear
      if (old < 0) {
        if (code > 255) break;
        if (op < expected) out[op++] = code;
        old = code;
        continue;
      }
      kwk = code === next;                                   // KwKwK：字串 = str(old) + first(old)
      if (code > next) break;                                // 無效碼
      c = kwk ? old : code;
      L = len[c];
      if (kwk && op + L < expected) out[op + L] = first[old];
      for (p = c, j = L - 1; j >= 0; j--, p = prefix[p]) if (op + j < expected) out[op + j] = suffix[p];
      op = Math.min(expected, op + L + (kwk ? 1 : 0));
      if (next < 4096) {
        prefix[next] = old; suffix[next] = first[c]; first[next] = first[old]; len[next] = len[old] + 1;
        next++;
        if (next >= (1 << width) - 1 && width < 12) width++;
      }
      old = code;
      if (op >= expected) break;
    }
    return { data: out, short: op < expected };
  }

  /* ---------------- TIFF 結構讀取 ---------------- */
  var TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
  var WANT = { 254: 1, 255: 1, 256: 1, 257: 1, 258: 1, 259: 1, 262: 1, 266: 1, 273: 1, 274: 1, 277: 1, 278: 1,
    279: 1, 282: 1, 283: 1, 284: 1, 292: 1, 293: 1, 296: 1, 320: 1, 322: 1, 323: 1, 324: 1, 325: 1 };

  function readIfds(bytes, warnings) {
    var res = { ifds: [], le: true };
    if (bytes.length < 8) return res;
    var le;
    if (bytes[0] === 0x49 && bytes[1] === 0x49) le = true;
    else if (bytes[0] === 0x4D && bytes[1] === 0x4D) le = false;
    else return res;
    res.le = le;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), L = bytes.length;
    var magic = dv.getUint16(2, le);
    if (magic === 43) { warnings.push("TIFF：BigTIFF 格式目前不支援。"); return res; }
    if (magic !== 42) return res;
    var ifd = dv.getUint32(4, le), seen = {}, guard = 0;
    function val(type, off, k) {
      switch (type) {
        case 1: case 2: case 7: return bytes[off + k];
        case 6: return dv.getInt8(off + k);
        case 3: return dv.getUint16(off + k * 2, le);
        case 8: return dv.getInt16(off + k * 2, le);
        case 4: case 13: return dv.getUint32(off + k * 4, le);
        case 9: return dv.getInt32(off + k * 4, le);
        case 5: { var den = dv.getUint32(off + k * 8 + 4, le); return den ? dv.getUint32(off + k * 8, le) / den : 0; }
        case 10: { var d2 = dv.getInt32(off + k * 8 + 4, le); return d2 ? dv.getInt32(off + k * 8, le) / d2 : 0; }
        case 11: return dv.getFloat32(off + k * 4, le);
        case 12: return dv.getFloat64(off + k * 8, le);
      }
      return 0;
    }
    while (ifd > 0 && ifd + 2 <= L && !seen[ifd] && guard++ < 2000) {
      seen[ifd] = 1;
      var cnt = dv.getUint16(ifd, le), tags = {}, e, k;
      if (ifd + 2 + cnt * 12 > L) { warnings.push("TIFF：目錄（IFD）超出檔案範圍，檔案可能不完整。"); cnt = Math.floor((L - ifd - 2) / 12); }
      for (e = 0; e < cnt; e++) {
        var p = ifd + 2 + e * 12;
        var tag = dv.getUint16(p, le), type = dv.getUint16(p + 2, le), count = dv.getUint32(p + 4, le);
        if (!WANT[tag] || type < 1 || type > 13) continue;
        var size = TYPE_SIZE[type] * count, off = size <= 4 ? p + 8 : dv.getUint32(p + 8, le);
        if (count > 4000000 || off + size > L) { continue; }
        var arr = new Array(count);
        for (k = 0; k < count; k++) arr[k] = val(type, off, k);
        tags[tag] = arr;
      }
      res.ifds.push(tags);
      var np = ifd + 2 + cnt * 12;
      ifd = np + 4 <= L ? dv.getUint32(np, le) : 0;
    }
    return res;
  }
  function t1(tags, tag, def) { var a = tags[tag]; return a && a.length ? a[0] : def; }

  function ifdInfo(tags, index, fileLen) {
    var unit = t1(tags, 296, 2), f = unit === 3 ? 2.54 : (unit === 2 ? 1 : 0);
    var xr = t1(tags, 282, 0), yr = t1(tags, 283, 0);
    var info = {
      page: index,
      width: t1(tags, 256, 0), height: t1(tags, 257, 0),
      bitsPerSample: t1(tags, 258, 1), samplesPerPixel: t1(tags, 277, 1),
      compression: t1(tags, 259, 1), photometric: t1(tags, 262, -1), fillOrder: t1(tags, 266, 1),
      planar: t1(tags, 284, 1), t4Options: t1(tags, 292, 0), t6Options: t1(tags, 293, 0),
      subfileType: t1(tags, 254, 0), oldSubfileType: t1(tags, 255, 1),
      dpiX: f && xr ? Math.round(xr * f * 10) / 10 : null, dpiY: f && yr ? Math.round(yr * f * 10) / 10 : null,
      tiled: false, tileWidth: 0, tileHeight: 0, rowsPerStrip: 0, blocks: [], colorMap: tags[320] || null
    };
    var offs, cnts, i;
    if (tags[322] && tags[323] && (tags[324] || tags[273])) {
      info.tiled = true;
      info.tileWidth = t1(tags, 322, 0); info.tileHeight = t1(tags, 323, 0);
      offs = tags[324] || tags[273]; cnts = tags[325] || tags[279] || [];
    } else {
      var rps = t1(tags, 278, info.height);
      if (!rps || rps > info.height) rps = info.height;
      info.rowsPerStrip = rps;
      offs = tags[273] || []; cnts = tags[279] || [];
    }
    for (i = 0; i < offs.length; i++) {
      var len = cnts[i];
      if (len === undefined) len = (i + 1 < offs.length ? offs[i + 1] : fileLen) - offs[i];
      info.blocks.push({ offset: offs[i], length: Math.max(0, len) });
    }
    return info;
  }

  /** TIFF 檔頭資訊（不解碼像素）：[{page, width, height, bitsPerSample, compression, photometric, dpiX, blocks, …}] */
  function tiffInfo(bytes, opts) {
    bytes = asBytes(bytes);
    var warnings = (opts && opts.warnings) || [];
    var r = readIfds(bytes, warnings);
    return r.ifds.map(function (tags, i) { return ifdInfo(tags, i, bytes.length); });
  }

  // 位元打包資料（每列 ceil(w/8) bytes，MSB 為最左像素）→ 每像素 1 byte
  function unpackRows(src, w, h, out, base, stride) {
    var rb = (w + 7) >> 3, y, x, b, o, s;
    for (y = 0; y < h; y++) {
      o = base + y * stride; s = y * rb;
      if (s >= src.length) break;
      for (x = 0; x < w; x += 8) {
        b = src[s + (x >> 3)];
        if (!b) continue;
        for (var k = 0; k < 8 && x + k < w; k++) out[o + x + k] = (b >> (7 - k)) & 1;
      }
    }
  }

  function decodeIfdImage(bytes, info, warnings) {
    var w = info.width, h = info.height, P = "TIFF 第 " + (info.page + 1) + " 頁";
    if (!w || !h) { warnings.push(P + "：缺少影像寬高，略過。"); return null; }
    if (!checkSize(w, h) || w * h > 150e6) { warnings.push(P + "：影像過大（" + w + "×" + h + "），略過。"); return null; }
    if (info.bitsPerSample !== 1 || info.samplesPerPixel !== 1) {
      warnings.push(P + "：非黑白二值影像（" + info.bitsPerSample + " 位元 × " + info.samplesPerPixel +
        " 色版），本讀取器僅支援二值 TIFF。");
      return null;
    }
    var comp = info.compression;
    if ([1, 2, 3, 4, 5, 32773].indexOf(comp) < 0) {
      warnings.push(P + "：不支援的壓縮方式（Compression=" + comp + "）。");
      return null;
    }
    if (!info.blocks.length) { warnings.push(P + "：缺少影像資料位置（StripOffsets），略過。"); return null; }
    var T = tables(), out = new Uint8Array(w * h), problems = 0;
    var bw = info.tiled ? info.tileWidth : w, bhDefault = info.tiled ? info.tileHeight : info.rowsPerStrip;
    if (!bw || !bhDefault) { warnings.push(P + "：strip / tile 尺寸無效，略過。"); return null; }
    var across = info.tiled ? Math.ceil(w / bw) : 1;
    var nBlocks = info.tiled ? across * Math.ceil(h / bhDefault) : Math.ceil(h / bhDefault);
    if (info.blocks.length < nBlocks) { warnings.push(P + "：影像資料區塊數不足（" + info.blocks.length + "/" + nBlocks + "），缺少部分留白。"); nBlocks = info.blocks.length; }
    var cw = [];
    for (var bi = 0; bi < nBlocks; bi++) {
      var blk = info.blocks[bi], x0, y0, bh;
      if (info.tiled) { x0 = (bi % across) * bw; y0 = Math.floor(bi / across) * bhDefault; bh = bhDefault; }
      else { x0 = 0; y0 = bi * bhDefault; bh = Math.min(bhDefault, h - y0); }
      if (y0 >= h) break;
      if (blk.offset >= bytes.length || blk.length <= 0) { problems++; continue; }
      var data = bytes.subarray(blk.offset, Math.min(bytes.length, blk.offset + blk.length));
      if (data.length < blk.length) problems++;
      if (info.fillOrder === 2) {
        var rv = new Uint8Array(data.length);
        for (var q = 0; q < data.length; q++) rv[q] = T.rev[data[q]];
        data = rv;
      }
      var direct = !info.tiled;                     // strip 可直接寫入整頁緩衝區
      var dst = direct ? out : new Uint8Array(bw * bh), dbase = direct ? y0 * w : 0;
      var o = { warnings: cw, out: dst, outOffset: dbase };
      if (comp === 4) decodeG4(data, bw, bh, o);
      else if (comp === 3) decodeG3(data, bw, bh, { warnings: cw, out: dst, outOffset: dbase, twoD: !!(info.t4Options & 1) });
      else if (comp === 2) decodeG3(data, bw, bh, { warnings: cw, out: dst, outOffset: dbase, rle: true });
      else {
        var rb = (bw + 7) >> 3, raw = data, r;
        if (comp === 32773) { r = unpackBitsTiff(data, rb * bh); raw = r.data; if (r.short) problems++; }
        else if (comp === 5) {
          if (data.length >= 2 && data[0] === 0 && (data[1] & 1)) { warnings.push(P + "：舊式 LZW 編碼不支援。"); return null; }
          r = lzwDecode(data, rb * bh); raw = r.data; if (r.short) problems++;
        } else if (raw.length < rb * bh) problems++;
        unpackRows(raw, bw, bh, dst, dbase, bw);
      }
      if (!direct) {
        // tile：裁切到影像範圍內再複製
        var cwid = Math.min(bw, w - x0), chgt = Math.min(bh, h - y0);
        for (var yy = 0; yy < chgt; yy++) out.set(dst.subarray(yy * bw, yy * bw + cwid), (y0 + yy) * w + x0);
      }
    }
    if (cw.length) warnings.push(P + "：" + cw[0] + (cw.length > 1 ? "（另有 " + (cw.length - 1) + " 個區塊有類似問題）" : ""));
    else if (problems) warnings.push(P + "：部分影像資料不完整，缺少部分留白。");
    // 色彩解讀：0 = WhiteIsZero（1 為黑）；1 = BlackIsZero（0 為黑）；3 = 調色盤（看索引 0 的亮度）
    var invert = false, ph = info.photometric;
    if (ph === 1) invert = true;
    else if (ph === 3 && info.colorMap && info.colorMap.length >= 6) {
      var cm = info.colorMap, l0 = cm[0] + cm[2] + cm[4], l1 = cm[1] + cm[3] + cm[5];
      invert = l0 < l1;                            // 索引 0 較暗 → 0 為黑
    } else if (ph !== 0 && ph !== -1) {
      warnings.push(P + "：Photometric=" + ph + " 非一般黑白影像，以白底黑字解讀。");
    }
    if (invert) for (var p2 = 0; p2 < out.length; p2++) out[p2] ^= 1;
    return { width: w, height: h, data: out, dpiX: info.dpiX, dpiY: info.dpiY, dpi: info.dpiX || info.dpiY || null,
      page: info.page, compression: comp };
  }

  var SUPPORTED_COMP = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 32773: 1 };
  /**
   * TIFF 頁面清單（不解碼，省記憶體）：[{page, width, height, dpiX, dpiY, dpi, compression, bitsPerSample,
   *   samplesPerPixel, photometric, supported, decode(opts?) → Bitmap|null}]。縮圖頁（NewSubfileType bit 0）略過。
   */
  function tiffPages(bytes, opts) {
    bytes = asBytes(bytes);
    var warnings = (opts && opts.warnings) || [];
    var out = [];
    try {
      var r = readIfds(bytes, warnings);
      r.ifds.forEach(function (tags, i) {
        var info = ifdInfo(tags, i, bytes.length);
        if ((info.subfileType & 1) || info.oldSubfileType === 2) return;   // 縮小解析度的縮圖頁
        out.push({
          page: i, width: info.width, height: info.height, dpiX: info.dpiX, dpiY: info.dpiY, dpi: info.dpiX || info.dpiY || null,
          compression: info.compression, bitsPerSample: info.bitsPerSample, samplesPerPixel: info.samplesPerPixel,
          photometric: info.photometric,
          supported: info.bitsPerSample === 1 && info.samplesPerPixel === 1 && !!SUPPORTED_COMP[info.compression],
          decode: function (o) {
            var ws = (o && o.warnings) || warnings;
            try { return decodeIfdImage(bytes, info, ws); }
            catch (e) { ws.push("TIFF 第 " + (i + 1) + " 頁解碼失敗：" + (e && e.message ? e.message : e)); return null; }
          }
        });
      });
    } catch (e) {
      warnings.push("TIFF 讀取失敗：" + (e && e.message ? e.message : e));
    }
    return out;
  }

  /**
   * 二值 TIFF → Bitmap 陣列（每個 IFD 一頁；縮圖頁與不支援的頁會略過並記入 opts.warnings）。
   * opts：{warnings?: [], maxPages?: number（最多解碼幾頁，預設全部）}
   * Bitmap = {width, height, data, dpiX, dpiY, dpi, page（IFD 索引，0 起算）, compression}
   * 多頁大檔請改用 tiffPages() 逐頁解碼以節省記憶體。
   */
  function decodeTiff(bytes, opts) {
    var warnings = (opts && opts.warnings) || [];
    var max = opts && opts.maxPages > 0 ? opts.maxPages : Infinity;
    var list = tiffPages(bytes, { warnings: warnings }), pages = [];
    for (var i = 0; i < list.length && pages.length < max; i++) {
      var bm = list[i].decode({ warnings: warnings });
      if (bm) pages.push(bm);
    }
    return pages;
  }

  YF.ccitt = {
    decodeG4: decodeG4,
    decodeG3: decodeG3,
    decodeTiff: decodeTiff,
    tiffPages: tiffPages,
    tiffInfo: tiffInfo,
    /** 位元反轉（FillOrder=2 用）：回傳新陣列 */
    reverseBits: function (bytes) {
      var T = tables(), src = asBytes(bytes), out = new Uint8Array(src.length);
      for (var i = 0; i < src.length; i++) out[i] = T.rev[src[i]];
      return out;
    },
    /* 測試用：碼表原始資料 */
    _codes: { WHITE_TERM: WHITE_TERM, WHITE_MAKEUP: WHITE_MAKEUP, BLACK_TERM: BLACK_TERM,
      BLACK_MAKEUP: BLACK_MAKEUP, EXT_MAKEUP: EXT_MAKEUP, EOL: EOL_CODE, MODES: MODE_CODES },
    _lzwDecode: lzwDecode,
    _unpackBits: unpackBitsTiff
  };
})(typeof window !== "undefined" ? window : globalThis);
