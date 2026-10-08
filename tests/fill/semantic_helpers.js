/* 測試輔助（dict / extract / match 共用）
 * - load()：以 Node 載入 js/fill/dict.js、extract.js、match.js，回傳 YangFill 命名空間
 * - grid()：以二維文字陣列快速建立合成 FTable（"<" 與左格合併、"^" 與上格合併）
 * - realDocs()：把 test_data/fill/fx_*.json（OCR 原型輸出，不進版控）轉成 Doc；檔案不存在時 haveReal() 為 false
 * 本檔不含任何真實監測資料。 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const DATA = path.join(ROOT, "test_data", "fill");

function load() {
  ["dict", "extract", "match"].forEach((m) => require(path.join(ROOT, "js", "fill", m + ".js")));
  return globalThis.YangFill;
}

/** 極簡測試框架：test(name, fn)；done(label) 印出一行結果並以 exit code 反映 */
function harness() {
  let pass = 0, fail = 0;
  const failures = [];
  return {
    test(name, fn) {
      try { fn(); pass++; } catch (e) { fail++; failures.push(name + "：" + (e && e.message)); }
    },
    done(label) {
      failures.forEach((f) => console.error("FAIL " + f));
      if (fail) { console.log("FAIL " + label + ": " + fail + " failed, " + pass + " passed"); process.exitCode = 1; }
      else console.log("PASS " + label + ": " + pass + " tests");
    }
  };
}

/**
 * grid(id, rows, opts) → FTable
 * rows：二維字串陣列；"<" 表示與左邊儲存格合併，"^" 表示與上方儲存格合併
 * opts：{ page, sheet, index, title, context, geom: {xs: [欄邊界…], y0, rowH} }（geom 會產生 bbox）
 */
function grid(id, rows, opts) {
  opts = opts || {};
  const nR = rows.length, nC = Math.max.apply(null, rows.map((r) => r.length));
  const own = [], cells = [];
  for (let r = 0; r < nR; r++) {
    own.push([]);
    for (let c = 0; c < nC; c++) {
      const v = rows[r][c] === undefined ? "" : rows[r][c];
      if (v === "<" && c > 0) { const x = own[r][c - 1]; x.c1 = Math.max(x.c1, c); own[r][c] = x; continue; }
      if (v === "^" && r > 0) { const x = own[r - 1][c]; x.r1 = Math.max(x.r1, r); own[r][c] = x; continue; }
      const cell = { r0: r, r1: r, c0: c, c1: c, text: v, conf: opts.conf === undefined ? null : opts.conf, bbox: null, ref: { r: r, c: c } };
      own[r][c] = cell;
      cells.push(cell);
    }
  }
  if (opts.geom) {
    const g = opts.geom;
    cells.forEach((cell) => {
      cell.bbox = { x0: g.xs[cell.c0] + 2, x1: g.xs[cell.c1 + 1] - 2, y0: g.y0 + cell.r0 * g.rowH + 2, y1: g.y0 + (cell.r1 + 1) * g.rowH - 2 };
    });
  }
  return {
    id, page: opts.page === undefined ? null : opts.page, sheet: opts.sheet || null, index: opts.index || 0,
    title: opts.title || "", context: opts.context || [], nRows: nR, nCols: nC, cells
  };
}
function doc(id, tables, role, name) {
  return { id, name: name || id, kind: "test", role: role || "raw", tables, pages: [], warnings: [], info: "" };
}

function exists(name) { return fs.existsSync(path.join(DATA, name)); }
/** 掃描型 raw：[{file,page,width,height,tables:[{nRows,nCols,bbox,cells}],lines}] → Doc */
function scannedDoc(file, id, name, kind) {
  const pages = JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
  const tables = [];
  pages.forEach((p) => {
    (p.tables || []).forEach((t, ti) => {
      tables.push({
        id: "p" + p.page + "t" + ti, page: p.page, sheet: null, index: ti, title: "",
        context: (p.lines || []).map((l) => l.text), nRows: t.nRows, nCols: t.nCols,
        cells: t.cells.map((c) => ({ r0: c.r0, r1: c.r1, c0: c.c0, c1: c.c1, text: c.text, conf: c.conf, bbox: c.bbox, ref: null }))
      });
    });
  });
  return {
    id, name, kind, role: "raw", tables,
    pages: pages.map((p) => ({ index: p.page - 1, width: p.width, height: p.height, dpi: 200 })),
    warnings: [], info: ""
  };
}
/** 範本：[{title,context,nRows,nCols,cells:[{r0,r1,c0,c1,text,ref}]}] → Doc */
function templateDoc(file, id, name) {
  const ts = JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
  return {
    id, name, kind: "docx", role: "template",
    tables: ts.map((t, i) => ({
      id: "t" + i, page: null, sheet: null, index: i, title: t.title || "", context: t.context || [],
      nRows: t.nRows, nCols: t.nCols,
      cells: t.cells.map((c) => ({ r0: c.r0, r1: c.r1, c0: c.c0, c1: c.c1, text: c.text, conf: null, bbox: null, ref: c.ref || null }))
    })),
    pages: [], warnings: [], info: ""
  };
}
function haveReal() { return exists("fx_adata.json") && exists("fx_odor.json") && exists("fx_template.json"); }
function realDocs() {
  return {
    adata: scannedDoc("fx_adata.json", "adata", "A_data.xdw", "xdw"),
    odor: scannedDoc("fx_odor.json", "odor", "odor.pdf", "pdf"),
    template: templateDoc("fx_template.json", "tpl", "template.docx")
  };
}
function realExpected() {
  return exists("semantic_expected.json") ? JSON.parse(fs.readFileSync(path.join(DATA, "semantic_expected.json"), "utf8")) : null;
}
module.exports = { ROOT, DATA, load, harness, grid, doc, haveReal, realDocs, realExpected, scannedDoc, templateDoc };
