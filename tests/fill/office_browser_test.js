/* =========================================================================
 * Yang-analyze web — tests/fill/office_browser_test.js
 * 在真實瀏覽器（DOMParser / XMLSerializer / CompressionStream）測試 docx.js、xlsxtpl.js、zip.js：
 *   合成範本 tests/fill/fixtures/office_*（可進 repo）＋頁內手工組的 xlsx / csv；
 *   真實樣本 test_data/fill/template.docx 存在時（不進 repo）另做結構比對與填寫驗證。
 * 結果：window.__TEST_RESULTS__ = [{name, ok, msg}]、window.__TEST_DONE__ = true；
 *       產生的檔案放 window.__OUTPUTS__ = {檔名: base64}（run_browser.mjs --out 可存檔再人工驗證）。
 * ========================================================================= */
(function () {
  "use strict";
  var YF = window.YangFill;
  var W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  var S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  var results = window.__TEST_RESULTS__ = [];
  var outputs = window.__OUTPUTS__ = {};
  var logEl = document.getElementById("log"), sumEl = document.getElementById("summary");
  var tests = [];
  function test(name, fn) { tests.push({ name: name, fn: fn }); }

  /* ---------------- 斷言 ---------------- */
  function fail(msg) { throw new Error(msg); }
  function ok(c, msg) { if (!c) fail(msg || "條件不成立"); }
  function eq(a, b, msg) { if (a !== b) fail((msg ? msg + "：" : "") + "預期 " + JSON.stringify(b) + "，實際 " + JSON.stringify(a)); }
  function deq(a, b, msg) { var x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) fail((msg ? msg + "：" : "") + "預期 " + y + "，實際 " + x); }
  function bytesEq(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  async function rejectsZh(p, re) {
    try { await p; } catch (e) {
      ok(/[一-鿿]/.test(e.message), "錯誤訊息應為中文：" + e.message);
      if (re) ok(re.test(e.message), "錯誤訊息不符：" + e.message);
      return e;
    }
    fail("應該丟出錯誤");
  }

  /* ---------------- 工具 ---------------- */
  async function fetchBytes(url) {
    try {
      var r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) { return null; }
  }
  function b64(u8) {
    var s = "", CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function keep(name, bytes) { outputs[name] = b64(bytes); }
  function parse(xml) { return new DOMParser().parseFromString(xml, "application/xml"); }
  function els(node, ns, name) { var out = [], c = node.childNodes; for (var i = 0; i < c.length; i++) if (c[i].nodeType === 1 && c[i].namespaceURI === ns && (!name || c[i].localName === name)) out.push(c[i]); return out; }
  function first(node, ns, name) { return els(node, ns, name)[0] || null; }
  /** 與 docx.js 相同的索引方式：最上層表格 → 列（含 sdt 包住）→ 儲存格（含 sdt 包住） */
  function flatKids(el, ns, name) {
    var out = [];
    (function rec(e) {
      els(e, ns).forEach(function (k) {
        if (k.localName === name) out.push(k);
        else if (/^(sdt|sdtContent|customXml|ins|moveTo|smartTag)$/.test(k.localName)) rec(k);
      });
    })(el);
    return out;
  }
  function docxTc(doc, ref) {
    var body = first(doc.documentElement, W, "body");
    var tbls = flatKids(body, W, "tbl");
    var tr = flatKids(tbls[ref.tbl], W, "tr")[ref.tr];
    return flatKids(tr, W, "tc")[ref.tc];
  }
  function runsOf(tc) {
    var out = [];
    flatKids(tc, W, "p").forEach(function (p) { out.push.apply(out, els(p, W, "r")); });
    return out;
  }
  function rPrMap(r) {
    var m = {}, rPr = first(r, W, "rPr");
    if (!rPr) return m;
    els(rPr, W).forEach(function (k) {
      m[k.localName] = k.getAttributeNS(W, "val") || k.getAttributeNS(W, "eastAsia") || "1";
      if (k.localName === "rFonts") m.ascii = k.getAttributeNS(W, "ascii");
    });
    m._order = els(rPr, W).map(function (k) { return k.localName; });
    return m;
  }
  function cellAt(t, r, c) {
    for (var i = 0; i < t.cells.length; i++) if (t.cells[i].r0 === r && t.cells[i].c0 === c) return t.cells[i];
    return null;
  }
  async function otherPartsIdentical(srcZip, outBytes, changed) {
    var out = await YF.zip.read(outBytes);
    deq(out.names.filter(function (n) { return changed.indexOf(n) < 0; }),
        srcZip.names.filter(function (n) { return changed.indexOf(n) < 0; }), "未變更的項目與順序");
    srcZip.names.forEach(function (n) {
      if (changed.indexOf(n) >= 0) return;
      ok(bytesEq(out.raw(n).data, srcZip.raw(n).data), "未變更項目應逐位元組相同：" + n);
    });
    return out;
  }

  /* =====================================================================
   * Word：合成範本
   * ===================================================================== */
  var DOCX = null;
  async function docxFixture() {
    if (!DOCX) DOCX = await fetchBytes("fixtures/office_tpl.docx");
    ok(DOCX, "讀不到 fixtures/office_tpl.docx");
    return DOCX;
  }

  test("docx.load：表格結構（gridSpan、vMerge、gridBefore、sdt、巢狀、隱藏文字、表名）", async function () {
    var m = await YF.docx.load(await docxFixture());
    eq(m.tables.length, 3, "表格數");
    deq(m.paragraphs, ["前言段落：本文件為合成測試資料。", "表1 測試站甲空氣品質歷次調查結果彙整", "表2 測試站乙噪音振動", "結尾段落"], "非空段落");
    var t0 = m.tables[0], t1 = m.tables[1], t2 = m.tables[2];
    eq(t0.id, "t0"); eq(t0.index, 0); eq(t0.page, null); eq(t0.sheet, null);
    eq(t0.title, "表1 測試站甲空氣品質歷次調查結果彙整", "表 0 表名");
    deq(t0.context, ["前言段落：本文件為合成測試資料。", "表1 測試站甲空氣品質歷次調查結果彙整"]);
    eq(t0.nRows, 6); eq(t0.nCols, 5);
    var a = cellAt(t0, 0, 0);
    deq([a.r1, a.c1, a.text], [1, 0, "項目\n季別"], "vMerge 表頭");
    var so2 = cellAt(t0, 0, 1);
    deq([so2.r1, so2.c1, so2.text], [0, 2, "SO2 (ppm)"], "gridSpan 表頭");
    eq(cellAt(t0, 1, 0), null, "vMerge continue 不是獨立儲存格");
    deq(cellAt(t0, 1, 1).ref, { tbl: 0, tr: 1, tc: 1 }, "continue 格仍佔 tc 索引");
    var blanks = t0.cells.filter(function (c) { return c.text === ""; }).map(function (c) { return [c.r0, c.r1, c.c0, c.c1]; });
    deq(blanks, [[2, 2, 1, 1], [2, 2, 2, 2], [2, 2, 3, 3], [2, 2, 4, 4], [4, 5, 1, 1], [4, 4, 2, 2]], "表 0 空白格（隱藏文字算空白）");
    eq(cellAt(t0, 4, 3).text, "內A 內B", "巢狀表格文字併入");
    eq(cellAt(t0, 4, 4).text, "<1&2>");
    ok(m.warnings.some(function (w) { return /巢狀/.test(w); }), "巢狀表格警告");
    eq(t1.title, "表2 測試站乙噪音振動");
    var gb = cellAt(t1, 2, 1);
    ok(gb && gb.text === "" && gb.ref.tc === 0, "gridBefore=1 → 第一個 tc 在邏輯欄 1");
    eq(cellAt(t1, 2, 0), null, "gridBefore 佔的欄沒有儲存格");
    eq(cellAt(t1, 2, 3).text, "SDT值", "sdt 包住的儲存格");
    eq(t2.title, "", "前 3 段內沒有非空段落 → 無表名");
    eq(t2.nRows, 2);
    ok(/3 個表格/.test(m.info), m.info);
  });

  test("docx.fill：段落標記 rPr、空 run、多段落、vMerge、gridBefore、sdt、特殊字元、黃底、覆寫", async function () {
    var src = await docxFixture();
    var m = await YF.docx.load(src);
    var warnings = [];
    var out = await YF.docx.fill(m, [
      { tableId: "t0", r0: 2, c0: 1, value: "0.001" },
      { tableId: "t0", r0: 2, c0: 2, value: "<10" },
      { tableId: "t0", r0: 2, c0: 3, value: "A&B" },
      { tableId: "t0", r0: 2, c0: 4, value: "ND", mark: true },
      { tableId: "t0", r0: 5, c0: 1, value: "12.5" },          // 指到 vMerge 範圍內 → 寫進 restart 格
      { tableId: "t0", r0: 4, c0: 2, value: "9" },
      { tableId: "t0", r0: 3, c0: 1, value: "0.3" },           // 覆寫既有內容
      { tableId: "t1", r0: 1, c0: 1, value: "60.1" },
      { tableId: "t1", r0: 1, c0: 2, value: "  55 " },
      { tableId: "t1", r0: 1, c0: 3, value: "2行\n第二行" },
      { tableId: "t1", r0: 2, c0: 1, value: "61" },
      { tableId: "t2", r0: 1, c0: 0, value: "無字型" },
      { tableId: "t0", r0: 99, c0: 0, value: "x" },             // 找不到
      { tableId: "t9", r0: 0, c0: 0, value: "x" }               // 找不到表
    ], { warnings: warnings });
    keep("office_tpl_filled.docx", out);
    ok(warnings.some(function (w) { return /原有內容「0.25」已被覆寫/.test(w); }), "覆寫警告：" + warnings.join("；"));
    ok(warnings.some(function (w) { return /找不到第 100 列/.test(w); }), "找不到儲存格警告");
    ok(warnings.some(function (w) { return /找不到表格 t9/.test(w); }), "找不到表格警告");
    // 重新讀回
    var m2 = await YF.docx.load(out);
    var t0 = m2.tables[0], t1 = m2.tables[1], t2 = m2.tables[2];
    deq([2, 3, 4].map(function (c) { return cellAt(t0, 2, c).text; }).concat([cellAt(t0, 2, 1).text]), ["<10", "A&B", "ND", "0.001"]);
    eq(cellAt(t0, 4, 1).text, "12.5"); eq(cellAt(t0, 4, 1).r1, 5, "vMerge 仍跨兩列");
    eq(cellAt(t0, 4, 2).text, "9", "隱藏文字格填值後只顯示新值");
    eq(cellAt(t0, 3, 1).text, "0.3", "覆寫");
    eq(cellAt(t1, 1, 1).text, "60.1"); eq(cellAt(t1, 1, 2).text, "55", "前後空白（讀取時去除）");
    eq(cellAt(t1, 1, 3).text, "2行\n第二行", "換行");
    eq(cellAt(t1, 2, 1).text, "61", "gridBefore 格");
    eq(cellAt(t1, 2, 3).text, "SDT值");
    eq(cellAt(t2, 1, 0).text, "無字型");
    // 結構不變
    m.tables.forEach(function (t, i) {
      deq(m2.tables[i].cells.map(function (c) { return [c.r0, c.r1, c.c0, c.c1]; }), t.cells.map(function (c) { return [c.r0, c.r1, c.c0, c.c1]; }), "表 " + i + " 結構");
    });
    // XML 細節
    var zip = await YF.zip.read(out), xml = await zip.text("word/document.xml");
    var srcXml = m.xml;
    eq(xml.slice(0, xml.indexOf("<w:document")), srcXml.slice(0, srcXml.indexOf("<w:document")), "XML 宣告保留");
    eq(xml.slice(0, xml.indexOf(">", xml.indexOf("<w:document")) + 1), srcXml.slice(0, srcXml.indexOf(">", srcXml.indexOf("<w:document")) + 1), "根元素命名空間宣告保留");
    eq((xml.match(/xmlns:w=/g) || []).length, 1, "不得重複宣告 w 命名空間");
    ok(xml.indexOf(">&lt;10<") > 0 && xml.indexOf(">A&amp;B<") > 0, "特殊字元跳脫");
    var doc = parse(xml);
    // (2,1) 只有段落標記 rPr → 新 run 複製其字型
    var r21 = runsOf(docxTc(doc, cellAt(m.tables[0], 2, 1).ref));
    eq(r21.length, 1, "(2,1) 一個 run");
    var p21 = rPrMap(r21[0]);
    deq([p21.ascii, p21.rFonts, p21.sz, p21.szCs], ["Times New Roman", "標楷體", "28", "28"], "(2,1) 字型");
    eq(first(r21[0], W, "t").getAttributeNS("http://www.w3.org/XML/1998/namespace", "space"), "preserve", "xml:space");
    // (2,2) 原本的空 run 被重複利用（字型 12pt → sz 24）
    var r22 = runsOf(docxTc(doc, cellAt(m.tables[0], 2, 2).ref));
    eq(r22.length, 1, "(2,2) 重用空 run，不新增");
    eq(rPrMap(r22[0]).sz, "24", "(2,2) 沿用空 run 的字型");
    eq(els(r22[0], W, "t").length, 1, "(2,2) 只有一個 w:t");
    // (2,3) 多段落：值寫在第一段
    var tc23 = docxTc(doc, cellAt(m.tables[0], 2, 3).ref), ps23 = flatKids(tc23, W, "p");
    eq(ps23.length, 2, "(2,3) 段落數不變");
    eq(els(ps23[0], W, "r").length, 1, "(2,3) 第一段有值"); eq(els(ps23[1], W, "r").length, 0, "(2,3) 第二段仍空");
    eq(rPrMap(els(ps23[0], W, "r")[0]).sz, "24", "(2,3) 字型取自第一段段落標記");
    // (2,4) 無任何 rPr → 沿用同列鄰格 run（14pt → sz 28）；黃底 highlight 位置符合 schema 順序
    var r24 = runsOf(docxTc(doc, cellAt(m.tables[0], 2, 4).ref))[0], p24 = rPrMap(r24);
    eq(p24.highlight, "yellow", "黃底");
    eq(p24.rFonts, "標楷體", "(2,4) 鄰格字型");
    var ord = p24._order, hi = ord.indexOf("highlight");
    ok(hi > ord.indexOf("sz") && hi > ord.indexOf("szCs") && hi > ord.indexOf("rFonts"), "highlight 在 sz/szCs 之後：" + ord.join(","));
    // 隱藏 run 保留但不影響；新 run 沒有 vanish
    var r42 = runsOf(docxTc(doc, cellAt(m.tables[0], 4, 2).ref));
    eq(r42.length, 2, "(4,2) 原隱藏 run + 新 run");
    ok(!("vanish" in rPrMap(r42[1])), "新 run 不可帶 vanish");
    // 新段落/run 不得帶 w14:paraId 重複
    var ids = xml.match(/w14:paraId="[0-9A-F]+"/g) || [], seen = {};
    ids.forEach(function (x) { ok(!seen[x], "paraId 重複 " + x); seen[x] = 1; });
    // 其他部分不動
    await otherPartsIdentical(m.zip, out, ["word/document.xml"]);
  });

  test("docx.fill：可重複呼叫（model 不被改動）、空值略過、mark 於重用 run", async function () {
    var m = await YF.docx.load(await docxFixture());
    var o1 = await YF.docx.fill(m, [{ tableId: "t0", r0: 2, c0: 1, value: "AAA" }]);
    var o2 = await YF.docx.fill(m, [{ tableId: "t0", r0: 2, c0: 2, value: "BBB", mark: true }, { tableId: "t0", r0: 2, c0: 3, value: "" }]);
    var a = await YF.docx.load(o1), b = await YF.docx.load(o2);
    eq(cellAt(a.tables[0], 2, 1).text, "AAA"); eq(cellAt(a.tables[0], 2, 2).text, "");
    eq(cellAt(b.tables[0], 2, 1).text, "", "第二次填寫不含第一次的值"); eq(cellAt(b.tables[0], 2, 2).text, "BBB");
    var x = await (await YF.zip.read(o2)).text("word/document.xml");
    var r = runsOf(docxTc(parse(x), cellAt(m.tables[0], 2, 2).ref));
    eq(r.length, 1); eq(rPrMap(r[0]).highlight, "yellow", "重用 run 也能標黃");
    var tc23 = docxTc(parse(x), cellAt(m.tables[0], 2, 3).ref);
    eq(runsOf(tc23).length, 0, "空值不新增 run");
    var none = await YF.docx.fill(m, []);
    var nz = await YF.zip.read(none);
    eq(await nz.text("word/document.xml") !== "", true);
  });

  test("docx：錯誤輸入 → 中文錯誤", async function () {
    await rejectsZh(YF.docx.load(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])));
    var noDoc = await YF.zip.write([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "xl/workbook.xml", data: "<workbook/>" }]);
    await rejectsZh(YF.docx.load(noDoc), /word\/document\.xml|不是 Word/);
    var bad = await YF.zip.write([{ name: "word/document.xml", data: "<w:document xmlns:w=\"" + W + "\"><w:body><w:p></w:body>" }]);
    await rejectsZh(YF.docx.load(bad), /XML 格式錯誤/);
    var nobody = await YF.zip.write([{ name: "word/document.xml", data: "<w:document xmlns:w=\"" + W + "\"/>" }]);
    await rejectsZh(YF.docx.load(nobody), /w:body/);
  });

  test("docx：手工 XML（hMerge、vMerge 不連續、tc 無段落、customXml 包表格、Strict 命名空間）", async function () {
    function docXml(ns, body) {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="' + ns + '"><w:body>' + body + "</w:body></w:document>";
    }
    function tc(inner, pr) { return "<w:tc>" + (pr ? "<w:tcPr>" + pr + "</w:tcPr>" : "") + inner + "</w:tc>"; }
    function p(t) { return "<w:p>" + (t ? "<w:r><w:t>" + t + "</w:t></w:r>" : "") + "</w:p>"; }
    var body = p("表A 手工") +
      "<w:customXml><w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>" +
      "<w:tr>" + tc(p("H1"), '<w:hMerge w:val="restart"/>') + tc(p(""), "<w:hMerge/>") + tc(p("H3")) + "</w:tr>" +
      "<w:tr>" + tc(p("a"), '<w:vMerge w:val="restart"/>') + tc(p("b")) + tc("") + "</w:tr>" +
      "<w:tr>" + tc(p("c")) + tc(p(""), "<w:vMerge/>") + tc(p("d")) + "</w:tr>" +
      "</w:tbl></w:customXml>" + p("") + "<w:sectPr/>";
    for (var k = 0; k < 3; k++) {
      var ns = k === 1 ? "http://purl.oclc.org/ooxml/wordprocessingml/main" : W;
      var xmlText = docXml(ns, body);
      if (k === 2) xmlText = xmlText.replace(/(<\/?)w:/g, "$1ns0:").replace(/ w:/g, " ns0:").replace("xmlns:w=", "xmlns:ns0=");   // ElementTree 式前綴
      var bytes = await YF.zip.write([{ name: "word/document.xml", data: xmlText }]);
      var m = await YF.docx.load(bytes);
      eq(m.tables.length, 1);
      var t = m.tables[0];
      eq(t.title, "表A 手工");
      deq(cellAt(t, 0, 0) && [cellAt(t, 0, 0).c1, cellAt(t, 0, 0).text], [1, "H1"], "hMerge");
      eq(cellAt(t, 1, 2).text, "", "tc 無段落 → 空白");
      var c21 = cellAt(t, 2, 1);
      ok(c21 && c21.r0 === 2, "vMerge continue 但上方不是 restart → 當一般儲存格");
      var out = await YF.docx.fill(m, [{ tableId: "t0", r0: 1, c0: 2, value: "新" }, { tableId: "t0", r0: 2, c0: 1, value: "v" }]);
      var m2 = await YF.docx.load(out);
      eq(cellAt(m2.tables[0], 1, 2).text, "新", "tc 無段落 → 建立段落");
      eq(cellAt(m2.tables[0], 2, 1).text, "v");
      var x = await (await YF.zip.read(out)).text("word/document.xml");
      ok(/^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\n<(w|ns0):document/.test(x), "宣告與換行保留");
      if (k === 2) ok(x.indexOf("<w:") < 0 && x.indexOf("xmlns:w=") < 0 && x.indexOf("<ns0:r>") > 0, "沿用 ns0: 前綴：" + x.slice(-300));
    }
  });

  test("docx：外框表格拆開、填入值清理（控制字元/頭尾空白）、舊版 .doc 提示", async function () {
    function p(t) { return "<w:p>" + (t ? "<w:r><w:t>" + t + "</w:t></w:r>" : "") + "</w:p>"; }
    var inner = "<w:tbl><w:tr><w:tc>" + p("項目") + "</w:tc><w:tc>" + p("SO2") + "</w:tc></w:tr><w:tr><w:tc>" + p("115年第三季") + "</w:tc><w:tc>" + p("") + "</w:tc></w:tr></w:tbl>";
    var body = p("封面") + "<w:tbl><w:tr><w:tc>" + p("表3 外框內的表") + inner + p("") + "</w:tc></w:tr></w:tbl>" + p("後記");
    var bytes = await YF.zip.write([{ name: "word/document.xml", data: '<?xml version="1.0"?><w:document xmlns:w="' + W + '"><w:body>' + body + "</w:body></w:document>" }]);
    var m = await YF.docx.load(bytes);
    eq(m.tables.length, 1, "外框拆開後只剩內層表格");
    eq(m.tables[0].title, "表3 外框內的表", "外框內的段落成為表名");
    eq(m.tables[0].nCols, 2);
    ok(m.warnings.some(function (w) { return /外框表格/.test(w); }), "拆開外框警告");
    var out = await YF.docx.fill(m, [{ tableId: "t0", r0: 1, c0: 1, value: "  0.5\u0000\u000b\u3000" }]);
    var x = await (await YF.zip.read(out)).text("word/document.xml");
    ok(x.indexOf('<w:t xml:space="preserve">0.5</w:t>') > 0, "值已清理：" + x.slice(x.indexOf("115")));
    eq(cellAt((await YF.docx.load(out)).tables[0], 1, 1).text, "0.5");
    var ole = new Uint8Array(1024); ole.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
    await rejectsZh(YF.docx.load(ole), /\.doc|另存/);
    await rejectsZh(YF.docx.load(ole.buffer), /\.doc/);
  });

  test("docx：內容控制項提示文字（區塊 / 行內 sdt）視為空白，填寫後移除提示", async function () {
    function p(t) { return "<w:p>" + (t ? "<w:r><w:t>" + t + "</w:t></w:r>" : "") + "</w:p>"; }
    var plcRun = '<w:r><w:rPr><w:rStyle w:val="PlaceholderText"/><w:sz w:val="20"/></w:rPr><w:t>按一下這裡以輸入文字。</w:t></w:r>';
    var body = p("表4 內容控制項") + "<w:tbl><w:tr><w:tc>" + p("季別") + "</w:tc><w:tc>" + p("SO2") + "</w:tc><w:tc>" + p("NO2") + "</w:tc><w:tc>" + p("O3") + "</w:tc></w:tr>" +
      "<w:tr><w:tc>" + p("115年第三季") + "</w:tc>" +
      "<w:tc><w:sdt><w:sdtPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:p>" + plcRun + "</w:p></w:sdtContent></w:sdt></w:tc>" +
      "<w:tc><w:p><w:sdt><w:sdtPr><w:alias w:val=\"x\"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent>" + plcRun + "</w:sdtContent></w:sdt></w:p></w:tc>" +
      "<w:tc><w:p><w:sdt><w:sdtPr/><w:sdtContent><w:r><w:t>已填</w:t></w:r></w:sdtContent></w:sdt></w:p></w:tc></w:tr></w:tbl>";
    var bytes = await YF.zip.write([{ name: "word/document.xml", data: '<?xml version="1.0"?><w:document xmlns:w="' + W + '"><w:body>' + body + "</w:body></w:document>" }]);
    var m = await YF.docx.load(bytes);
    var t = m.tables[0];
    deq([cellAt(t, 1, 1).text, cellAt(t, 1, 2).text, cellAt(t, 1, 3).text], ["", "", "已填"], "提示文字視為空白");
    var out = await YF.docx.fill(m, [{ tableId: "t0", r0: 1, c0: 1, value: "0.002" }, { tableId: "t0", r0: 1, c0: 2, value: "0.011" }]);
    var m2 = await YF.docx.load(out);
    deq([cellAt(m2.tables[0], 1, 1).text, cellAt(m2.tables[0], 1, 2).text], ["0.002", "0.011"]);
    var x = await (await YF.zip.read(out)).text("word/document.xml");
    ok(x.indexOf("按一下這裡") < 0 && x.indexOf("showingPlcHdr") < 0 && x.indexOf("PlaceholderText") < 0, "提示文字與樣式已移除");
    ok(/<w:sz w:val="20"\/><\/w:rPr><w:t xml:space="preserve">0\.002</.test(x), "沿用提示 run 的其他字型屬性");
  });

  test("範本格式（.dotx / .xltx）→ 輸出轉為一般文件（.docx / .xlsx）", async function () {
    var z = await YF.zip.read(await docxFixture());
    var ct = await z.text("[Content_Types].xml");
    ok(ct.indexOf("wordprocessingml.document.main+xml") > 0);
    var dotx = await YF.zip.copyWithChanges(z, { "[Content_Types].xml": ct.replace("wordprocessingml.document.main+xml", "wordprocessingml.template.main+xml") });
    var m = await YF.docx.load(dotx);
    eq(m.kind, "dotx"); eq(m.outExt, "docx");
    var out = await YF.docx.fill(m, [{ tableId: "t0", r0: 2, c0: 1, value: "1" }]);
    var oct = await (await YF.zip.read(out)).text("[Content_Types].xml");
    ok(oct.indexOf("wordprocessingml.document.main+xml") > 0 && oct.indexOf("template.main") < 0, "改成文件 ContentType");
    eq((await YF.docx.load(out)).kind, "docx");
    eq((await YF.docx.load(await docxFixture())).kind, "docx");
    var zx = await YF.zip.read(await xlsxFixture());
    var cx = await zx.text("[Content_Types].xml");
    var xltx = await YF.zip.copyWithChanges(zx, { "[Content_Types].xml": cx.replace("spreadsheetml.sheet.main+xml", "spreadsheetml.template.main+xml") });
    var mx = await YF.xlsx.load(xltx, "範本.xltx");
    eq(mx.kind, "xltx");
    var rx = await YF.xlsx.fill(mx, [{ tableId: mx.tables[0].id, r0: 2, c0: 1, value: "0.5" }]);
    eq(rx.ext, "xlsx");
    var ocx = await (await YF.zip.read(rx.bytes)).text("[Content_Types].xml");
    ok(ocx.indexOf("spreadsheetml.sheet.main+xml") > 0 && ocx.indexOf("template.main") < 0, "改成活頁簿 ContentType");
  });

  /* =====================================================================
   * Word：真實樣本（test_data/fill，存在才跑；輸出不進 repo）
   * ===================================================================== */
  test("真實樣本 template.docx：結構 = fx_template.json；填寫 22 格", async function () {
    var bytes = await fetchBytes("../../test_data/fill/template.docx");
    var fxB = await fetchBytes("../../test_data/fill/fx_template.json");
    if (!bytes || !fxB) return "SKIP（無真實樣本）";
    var fx = JSON.parse(new TextDecoder().decode(fxB));
    var t0 = performance.now();
    var m = await YF.docx.load(bytes);
    var loadMs = performance.now() - t0;
    eq(m.tables.length, 10, "表格數");
    fx.forEach(function (ft, i) {
      var t = m.tables[i];
      eq(t.title, ft.title, "表 " + i + " 表名");
      deq(t.context, ft.context, "表 " + i + " context");
      eq(t.nRows, ft.nRows, "表 " + i + " nRows"); eq(t.nCols, ft.nCols, "表 " + i + " nCols");
      deq(t.cells.map(function (c) { return [c.r0, c.r1, c.c0, c.c1, c.text, c.ref]; }),
          ft.cells.map(function (c) { return [c.r0, c.r1, c.c0, c.c1, c.text, c.ref]; }), "表 " + i + " 儲存格");
    });
    var fills = [], vals5 = ["0.001", "0.012", "0.4", "0.2", "0.034", "0.029", "2.19", "0.13", "2.2", "19", "9", "4", "<10", "25", "ND"];
    var b5 = m.tables[5].cells.filter(function (c) { return c.text === "" && c.r0 === 2; });
    var b0 = m.tables[0].cells.filter(function (c) { return c.text === "" && c.r0 === 2; });
    eq(b5.length, 15); eq(b0.length, 7);
    b5.forEach(function (c, i) { fills.push({ tableId: "t5", r0: c.r0, c0: c.c0, value: vals5[i] }); });
    b0.forEach(function (c, i) { fills.push({ tableId: "t0", r0: c.r0, c0: c.c0, value: (60 + i) + "." + i }); });
    var w = [];
    t0 = performance.now();
    var out = await YF.docx.fill(m, fills, { warnings: w });
    var fillMs = performance.now() - t0;
    deq(w, [], "無警告");
    keep("real_template_filled.docx", out);
    var m2 = await YF.docx.load(out);
    b5.forEach(function (c, i) { eq(cellAt(m2.tables[5], c.r0, c.c0).text, vals5[i], "表 5 欄 " + c.c0); });
    b0.forEach(function (c, i) { eq(cellAt(m2.tables[0], c.r0, c.c0).text, (60 + i) + "." + i, "表 0 欄 " + c.c0); });
    // 其他表格、其他儲存格不變
    m.tables.forEach(function (t, ti) {
      t.cells.forEach(function (c) {
        if (c.text !== "" || c.r0 !== 2 || (ti !== 0 && ti !== 5)) eq(cellAt(m2.tables[ti], c.r0, c.c0).text, c.text, "表 " + ti + " 未填格");
      });
    });
    // 字型 = 段落標記 rPr
    var doc = parse(await (await YF.zip.read(out)).text("word/document.xml"));
    b0.forEach(function (c) {
      var r = runsOf(docxTc(doc, c.ref)); eq(r.length, 1);
      var p = rPrMap(r[0]);
      deq([p.ascii, p.rFonts, p.sz], ["Times New Roman", "標楷體", "28"], "表 0 字型");
    });
    b5.forEach(function (c) {
      var p = rPrMap(runsOf(docxTc(doc, c.ref))[0]);
      deq([p.ascii, p.rFonts, p.szCs], ["Times New Roman", "標楷體", "24"], "表 5 字型");
    });
    await otherPartsIdentical(m.zip, out, ["word/document.xml"]);
    return "load " + loadMs.toFixed(0) + " ms、fill " + fillMs.toFixed(0) + " ms";
  });

  /* =====================================================================
   * Excel：openpyxl 合成範本
   * ===================================================================== */
  var XLSXB = null;
  async function xlsxFixture() {
    if (!XLSXB) XLSXB = await fetchBytes("fixtures/office_tpl.xlsx.bin");
    ok(XLSXB, "讀不到 fixtures/office_tpl.xlsx.bin");
    return XLSXB;
  }
  function styleInfo(stylesDoc, sIdx) {
    var ss = stylesDoc.documentElement;
    var xf = els(first(ss, S, "cellXfs"), S, "xf")[sIdx || 0];
    var id = +xf.getAttribute("numFmtId");
    var code = { 0: "General", 1: "0", 2: "0.00" }[id];
    if (code === undefined) {
      els(first(ss, S, "numFmts"), S, "numFmt").forEach(function (n) { if (+n.getAttribute("numFmtId") === id) code = n.getAttribute("formatCode"); });
    }
    var fill = els(first(ss, S, "fills"), S, "fill")[+xf.getAttribute("fillId")];
    var fg = fill && fill.getElementsByTagNameNS(S, "fgColor")[0];
    return { code: code, font: xf.getAttribute("fontId"), border: xf.getAttribute("borderId"),
             fill: fg ? fg.getAttribute("rgb") : null, align: !!first(xf, S, "alignment") };
  }
  function sheetCell(doc, addr) {
    var cs = doc.getElementsByTagNameNS(S, "c");
    for (var i = 0; i < cs.length; i++) if (cs[i].getAttribute("r") === addr) return cs[i];
    return null;
  }

  test("xlsx.load：區塊切分、標題列、合併表頭、空白格、公式", async function () {
    var m = await YF.xlsx.load(await xlsxFixture(), "範本.xlsx");
    eq(m.format, "ooxml"); eq(m.kind, "xlsx");
    deq(m.sheets.map(function (s) { return s.name; }), ["空氣品質", "噪音"]);
    deq(m.tables.map(function (t) { return [t.id, t.title, t.nRows, t.nCols, t.range]; }), [
      ["s:空氣品質:b0", "表1 測試站甲空氣品質彙整", 5, 6, "A3:F7"],
      ["s:空氣品質:b1", "表2 測試站乙", 2, 3, "A11:C12"],
      ["s:噪音:b0", "噪音", 3, 3, "A1:C3"]]);
    var t = m.tables[0];
    deq(t.context, ["空氣品質", "表1 測試站甲空氣品質彙整"], "context = [工作表名, 標題]"); deq(m.tables[2].context, ["噪音"]);
    eq(m.tables[0].caption, "表1 測試站甲空氣品質彙整"); eq(m.tables[2].caption, "", "無標題列");
    eq(t.sheet, "空氣品質"); eq(t.index, 0); eq(m.tables[1].index, 1); eq(m.tables[2].index, 0);
    var h = cellAt(t, 0, 0); deq([h.r1, h.c1, h.text, h.ref.addr], [1, 0, "檢測項目", "A3"], "垂直合併");
    var so2 = cellAt(t, 0, 1); deq([so2.r1, so2.c1, so2.text], [0, 2, "SO2"], "水平合併");
    eq(cellAt(t, 0, 2), null, "合併範圍內非左上角不是獨立儲存格");
    deq([1, 2, 3, 4, 5].map(function (c) { return cellAt(t, 2, c).text; }), ["", "", "", "", ""], "待填列");
    eq(cellAt(t, 3, 1).text, "0.003", "數字格式化文字");
    eq(cellAt(t, 3, 3).text, "0.0", "0.011 以 0.0 格式顯示");
    eq(cellAt(t, 4, 5).text, "=E7*2", "無快取值的公式不算空白");
    deq(cellAt(t, 2, 1).ref, { sheet: "空氣品質", addr: "B5" });
  });

  test("xlsx.fill：數值/文字/格式/黃底/新儲存格/公式覆寫；樣式保留；其他部分不動", async function () {
    var src = await xlsxFixture();
    var m = await YF.xlsx.load(src, "範本.xlsx");
    var b0 = "s:空氣品質:b0", b1 = "s:空氣品質:b1", n0 = "s:噪音:b0", w = [];
    var res = await YF.xlsx.fill(m, [
      { tableId: b0, r0: 2, c0: 1, value: "0.001" }, { tableId: b0, r0: 2, c0: 2, value: "0.0025" },
      { tableId: b0, r0: 2, c0: 3, value: "0.012" }, { tableId: b0, r0: 2, c0: 4, value: "<10" },
      { tableId: b0, r0: 2, c0: 5, value: "ND", mark: true }, { tableId: b0, r0: 4, c0: 5, value: "200" },
      { tableId: b1, r0: 1, c0: 1, value: "2.2" }, { tableId: b1, r0: 1, c0: 2, value: "2.19", mark: true },
      { tableId: n0, r0: 1, c0: 1, value: "55.0" }, { tableId: n0, r0: 1, c0: 2, value: "-" },
      { tableId: n0, r0: 2, c0: 0, value: "A&B<c>" }, { tableId: n0, r0: 2, c0: 2, value: "007" }
    ], { warnings: w });
    eq(res.ext, "xlsx"); ok(/spreadsheetml\.sheet/.test(res.mime));
    ok(w.some(function (x) { return /F7 原有內容「=E7\*2」已被覆寫/.test(x); }), "公式覆寫警告：" + w.join("；"));
    keep("office_tpl_filled.xlsx", res.bytes);
    // SheetJS 讀回：值、型別、格式
    var wb = XLSX.read(res.bytes, { type: "array", cellNF: true, cellFormula: true });
    var s1 = wb.Sheets["空氣品質"], s2 = wb.Sheets["噪音"];
    function chk(ws, a, t, v, z) {
      var c = ws[a]; ok(c, a + " 不存在");
      eq(c.t, t, a + " 型別"); eq(c.v, v, a + " 值");
      if (z !== undefined) eq(c.z, z, a + " 數字格式");
    }
    chk(s1, "B5", "n", 0.001, "0.000"); chk(s1, "C5", "n", 0.0025, "0.0000"); chk(s1, "D5", "n", 0.012, "0.000");
    chk(s1, "E5", "s", "<10"); chk(s1, "F5", "s", "ND"); chk(s1, "F7", "n", 200, "0");
    ok(!s1.F7.f, "F7 公式已移除");
    chk(s1, "B12", "n", 2.2, "0.0"); chk(s1, "C12", "n", 2.19, "0.00");
    chk(s2, "B2", "n", 55, "0.0"); chk(s2, "C2", "s", "-"); chk(s2, "A3", "s", "A&B<c>"); chk(s2, "C3", "s", "007");
    eq(XLSX.utils.format_cell(s2.B2), "55.0", "55.0 顯示一位小數");
    // 樣式：字型/框線/對齊保留，數字格式/黃底改變
    var z = await YF.zip.read(res.bytes);
    var st = parse(await z.text("xl/styles.xml")), stSrc = parse(await m.zip.text("xl/styles.xml"));
    var sh = parse(await z.text("xl/worksheets/sheet1.xml")), shSrc = parse(await m.zip.text("xl/worksheets/sheet1.xml"));
    ["B5", "C5", "D5", "E5", "F5", "F7"].forEach(function (a) {
      var before = styleInfo(stSrc, +sheetCell(shSrc, a).getAttribute("s")), after = styleInfo(st, +sheetCell(sh, a).getAttribute("s"));
      deq([after.font, after.border, after.align], [before.font, before.border, before.align], a + " 字型/框線/對齊保留");
    });
    eq(styleInfo(st, +sheetCell(sh, "F5").getAttribute("s")).fill, "FFFFFF00", "F5 黃底");
    eq(styleInfo(st, +sheetCell(sh, "E5").getAttribute("s")).fill, "FFDDEEFF", "E5 原底色保留");
    eq(sheetCell(sh, "B5").getAttribute("s"), sheetCell(shSrc, "B5").getAttribute("s"), "B5 原格式已是 0.000 → 不新增樣式");
    eq(sheetCell(sh, "E5").getAttribute("t"), "inlineStr");
    // numFmt 不重複
    var codes = els(first(st.documentElement, S, "numFmts"), S, "numFmt").map(function (n) { return n.getAttribute("formatCode"); });
    deq(codes.slice().sort(), codes.filter(function (c, i) { return codes.indexOf(c) === i; }).sort(), "numFmt 不重複");
    eq(+first(st.documentElement, S, "cellXfs").getAttribute("count"), els(first(st.documentElement, S, "cellXfs"), S, "xf").length, "cellXfs count");
    eq(+first(st.documentElement, S, "fills").getAttribute("count"), els(first(st.documentElement, S, "fills"), S, "fill").length, "fills count");
    // 有公式 → fullCalcOnLoad
    ok(/fullCalcOnLoad="1"/.test(await z.text("xl/workbook.xml")), "fullCalcOnLoad");
    // 列內儲存格順序
    var sh2 = parse(await z.text("xl/worksheets/sheet2.xml"));
    var rows = sh2.getElementsByTagNameNS(S, "row");
    for (var i = 0; i < rows.length; i++) {
      var cols = els(rows[i], S, "c").map(function (c) { return YF.xlsx._parseAddr(c.getAttribute("r")).c; });
      deq(cols, cols.slice().sort(function (a, b) { return a - b; }), "第 " + rows[i].getAttribute("r") + " 列儲存格順序");
    }
    await otherPartsIdentical(m.zip, res.bytes, ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/styles.xml", "xl/workbook.xml"]);
    // 再讀一次 → 同樣的區塊
    var m2 = await YF.xlsx.load(res.bytes, "out.xlsx");
    eq(cellAt(m2.tables[0], 2, 1).text, "0.001"); eq(cellAt(m2.tables[0], 2, 2).text, "0.0025");
    eq(cellAt(m2.tables[2], 1, 1).text, "55.0");
  });

  test("xlsx：手工套件（x: 前綴、列/格無 r、共用公式主格、calcChain、新列、spans、新 numFmts）", async function () {
    var NSX = 'xmlns:x="' + S + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    var files = [
      { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>' },
      { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8"?><x:workbook ' + NSX + '><x:sheets><x:sheet name="資料" sheetId="1" r:id="rId1"/></x:sheets><x:definedNames/></x:workbook>' },
      { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>' },
      { name: "xl/styles.xml", data: '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="' + S + '"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>' },
      { name: "xl/sharedStrings.xml", data: '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="' + S + '" count="3" uniqueCount="3"><si><t>季別</t></si><si><t>SO2</t></si><si><t>115年第三季</t></si></sst>' },
      { name: "xl/calcChain.xml", data: '<?xml version="1.0" encoding="UTF-8"?><calcChain xmlns="' + S + '"><c r="C2" i="1"/><c r="C3"/><c r="C4"/></calcChain>' },
      { name: "xl/worksheets/sheet1.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<x:worksheet ' + NSX + '><x:dimension ref="A1:E7"/><x:sheetData>' +
        '<x:row r="1" spans="1:5"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c><x:c r="E1"><x:v>9</x:v></x:c></x:row>' +
        '<x:row><x:c t="s"><x:v>2</x:v></x:c><x:c s="1"/><x:c><x:f t="shared" ref="C2:C4" si="0">A5*2</x:f><x:v>4</x:v></x:c></x:row>' +
        '<x:row r="3"><x:c r="C3"><x:f t="shared" si="0"/><x:v>6</x:v></x:c><x:c r="D3"><x:v>1</x:v></x:c></x:row>' +
        '<x:row r="4"><x:c r="C4"><x:f t="shared" si="0"/><x:v>8</x:v></x:c><x:c r="D4"><x:f t="array" ref="D4:D5">C3:C4*2</x:f><x:v>12</x:v></x:c></x:row>' +
        '<x:row r="5"><x:c r="A5"><x:v>2</x:v></x:c><x:c r="D5"><x:v>16</x:v></x:c></x:row>' +
        '<x:row r="7"><x:c r="A7"><x:v>1</x:v></x:c></x:row>' +
        '</x:sheetData><x:mergeCells count="1"><x:mergeCell ref="A7:B8"/></x:mergeCells></x:worksheet>' }
    ];
    var src = await YF.zip.write(files);
    var m = await YF.xlsx.load(src, "手工.xlsx");
    eq(m.format, "ooxml");
    eq(m.tables.length, 1, "一個區塊（第 6 列單列空白不切開）");
    var t = m.tables[0];
    eq(t.range, "A1:E8"); eq(t.nRows, 7, "第 6 列沒有任何儲存格 → 略過");
    eq(cellAt(t, 1, 0).text, "115年第三季", "列/格無 r 屬性也能讀");
    var tgt = { D1: [0, 3], B2: [1, 1], C2: [1, 2], D8: [6, 3], E1: [0, 4], A5: [4, 0], D5: [4, 3] };
    var vals = { D1: "x", B2: "0.12", C2: "7", D8: "3", E1: "9.1234", A5: "2.50", D5: " 4\u0001 " };
    var fills = Object.keys(tgt).map(function (a) { return { tableId: t.id, r0: tgt[a][0], c0: tgt[a][1], value: vals[a] }; });
    Object.keys(tgt).forEach(function (a) { eq(cellAt(t, tgt[a][0], tgt[a][1]).ref.addr, a, "ref " + a); });
    var res = await YF.xlsx.fill(m, fills);
    keep("handmade_filled.xlsx", res.bytes);
    var z = await YF.zip.read(res.bytes);
    ok(!z.has("xl/calcChain.xml"), "calcChain 已刪除");
    ok(!/calcChain/.test(await z.text("xl/_rels/workbook.xml.rels")), "rels 已移除 calcChain");
    ok(!/calcChain/.test(await z.text("[Content_Types].xml")), "Content_Types 已移除 calcChain");
    ok(/^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\r\n<Types/.test(await z.text("[Content_Types].xml")), "Content_Types 宣告保留");
    var wbx = await z.text("xl/workbook.xml");
    ok(/<x:definedNames\/><x:calcPr fullCalcOnLoad="1"\/><\/x:workbook>/.test(wbx), "calcPr 依 schema 順序插入：" + wbx);
    var sx = await z.text("xl/worksheets/sheet1.xml");
    ok(sx.indexOf("<x:worksheet") > 0 && !/<c[ >]/.test(sx) && !/xmlns="/.test(sx), "沿用 x: 前綴，不產生預設命名空間");
    var sh = parse(sx);
    function cel(a) { return sheetCell(sh, a); }
    ok(!cel("C2").getElementsByTagNameNS(S, "f").length && cel("C2").getElementsByTagNameNS(S, "v")[0].textContent === "7", "C2 主格公式移除");
    ok(!cel("C3").getElementsByTagNameNS(S, "f").length && cel("C3").getElementsByTagNameNS(S, "v")[0].textContent === "6", "C3 共用公式改為純值");
    ok(!cel("C4").getElementsByTagNameNS(S, "f").length, "C4 共用公式改為純值");
    ok(!cel("D4").getElementsByTagNameNS(S, "f").length && cel("D4").getElementsByTagNameNS(S, "v")[0].textContent === "12", "D5 落在陣列公式 D4:D5 內 → 陣列公式改為純值");
    eq(cel("D5").getElementsByTagNameNS(S, "v")[0].textContent, "4", "D5 去除空白與控制字元後為數字");
    var row2 = sh.getElementsByTagNameNS(S, "row")[1];
    eq(row2.getAttribute("r"), "2", "列補上 r");
    deq(els(row2, S, "c").map(function (c) { return c.getAttribute("r"); }), ["A2", "B2", "C2"], "儲存格補上 r");
    deq(els(sh.getElementsByTagNameNS(S, "row")[0], S, "c").map(function (c) { return c.getAttribute("r"); }), ["A1", "B1", "D1", "E1"], "D1 插在 B1 與 E1 之間");
    deq(Array.prototype.map.call(sh.getElementsByTagNameNS(S, "row"), function (r) { return r.getAttribute("r"); }), ["1", "2", "3", "4", "5", "7", "8"], "新增第 8 列於最後");
    eq(cel("B2").getAttribute("s"), "1", "B2 已是 0.00 → 樣式不變");
    var st = parse(await z.text("xl/styles.xml"));
    eq(st.documentElement.firstChild.localName, "numFmts", "numFmts 建立在最前面");
    eq(styleInfo(st, +cel("E1").getAttribute("s")).code, "0.0000");
    eq(styleInfo(st, +cel("A5").getAttribute("s")).code, "0.00");
    eq(styleInfo(st, +(cel("D8").getAttribute("s") || 0)).code, "0");
    var wb = XLSX.read(res.bytes, { type: "array", cellNF: true });
    var ws = wb.Sheets["資料"];
    eq(ws.D1.v, "x"); eq(ws.C2.v, 7); eq(ws.C3.v, 6); eq(ws.D8.v, 3); eq(XLSX.utils.format_cell(ws.A5), "2.50"); eq(XLSX.utils.format_cell(ws.E1), "9.1234");
    eq(ws.A1.v, "季別", "共用字串仍可讀");
  });

  test("xlsx：.xls 備援（SheetJS 重新寫出）、CSV、錯誤輸入", async function () {
    var xls = await fetchBytes("fixtures/office_tpl.xls.bin");
    if (xls) {
      var m = await YF.xlsx.load(xls, "範本.xls");
      eq(m.format, "sheetjs"); eq(m.kind, "xls");
      ok(m.warnings.some(function (w) { return /格式可能遺失/.test(w); }), "格式遺失警告");
      eq(m.tables[0].title, "表1 測試站甲空氣品質彙整");
      var w = [];
      var res = await YF.xlsx.fill(m, [
        { tableId: m.tables[0].id, r0: 2, c0: 1, value: "0.001" },
        { tableId: m.tables[0].id, r0: 2, c0: 4, value: "<10", mark: true }], { warnings: w });
      eq(res.ext, "xls"); eq(res.mime, "application/vnd.ms-excel");
      ok(w.some(function (x) { return /黃底/.test(x); }), "無法標黃警告");
      keep("office_tpl_filled.xls", res.bytes);
      var wb = XLSX.read(res.bytes, { type: "array", cellNF: true });
      var ws = wb.Sheets["空氣品質"];
      eq(ws.B5.v, 0.001); eq(ws.B5.t, "n"); eq(XLSX.utils.format_cell(ws.B5), "0.001");
      eq(ws.E5.v, "<10"); eq(ws.A3.v, "檢測項目");
      var m2 = await YF.xlsx.load(res.bytes, "out.xls");
      eq(cellAt(m2.tables[0], 2, 1).text, "0.001");
    }
    // CSV（UTF-8 中文）
    var csv = new TextEncoder().encode("季別,SO2,NO2\r\n115年第三季,,\r\n114年第三季,0.002,0.010\r\n");
    var mc = await YF.xlsx.load(csv, "表.csv");
    eq(mc.kind, "csv"); eq(mc.tables.length, 1); eq(cellAt(mc.tables[0], 1, 0).text, "115年第三季");
    var rc = await YF.xlsx.fill(mc, [{ tableId: mc.tables[0].id, r0: 1, c0: 1, value: "0.001" }, { tableId: mc.tables[0].id, r0: 1, c0: 2, value: "<0.5" }]);
    eq(rc.ext, "csv");
    var txt = new TextDecoder().decode(rc.bytes);
    deq([rc.bytes[0], rc.bytes[1], rc.bytes[2]], [0xEF, 0xBB, 0xBF], "CSV 帶 UTF-8 BOM（Excel 才認得）");
    ok(/115年第三季,0\.001,<0\.5/.test(txt), "CSV 內容：" + txt);
    // HTML 表格（副檔名 .xls）
    var html = new TextEncoder().encode("<html><body><table><tr><td>季別</td><td>SO2</td></tr><tr><td>115年第三季</td><td></td></tr></table></body></html>");
    var mh = await YF.xlsx.load(html, "假的.xls");
    eq(mh.kind, "html");
    eq(cellAt(mh.tables[0], 0, 1).text, "SO2");
    var rh = await YF.xlsx.fill(mh, [{ tableId: mh.tables[0].id, r0: 1, c0: 1, value: "0.003" }]);
    eq(rh.ext, "xls");
    ok(rh.warnings.some(function (x) { return /HTML/.test(x); }), "格式改變警告");
    // 錯誤輸入
    var garbage = new Uint8Array(4096); for (var i = 0; i < garbage.length; i++) garbage[i] = (i * 37) & 255;
    var gm = null, gerr = null;
    try { gm = await YF.xlsx.load(garbage, "壞.xlsx"); } catch (e) { gerr = e; }
    ok(gerr ? /[一-鿿]/.test(gerr.message) : (gm && gm.warnings.length > 0), "垃圾輸入 → 中文錯誤或警告");
    var noWb = await YF.zip.write([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "foo.txt", data: "x" }]);
    var nerr = null;
    try { await YF.xlsx.load(noWb, "x.xlsx"); } catch (e) { nerr = e; }
    ok(!nerr || /[一-鿿]/.test(nerr.message), "非 Excel 的 ZIP → 中文錯誤：" + (nerr && nerr.message));
  });

  test("xlsx：副檔名不符（.xls 其實是 xlsx）、隱藏工作表、效能（2 萬格）", async function () {
    var m = await YF.xlsx.load(await xlsxFixture(), "其實是xlsx.xls");
    eq(m.format, "ooxml");
    var res = await YF.xlsx.fill(m, [{ tableId: m.tables[0].id, r0: 2, c0: 1, value: "1" }]);
    eq(res.ext, "xlsx");
    ok(res.warnings.some(function (w) { return /實際為 Excel \.xlsx/.test(w); }), "副檔名不符警告");
    // 大表
    var aoa = [["季別"]];
    for (var c = 1; c < 40; c++) aoa[0].push("項目" + c);
    for (var r = 1; r < 500; r++) { var row = ["列" + r]; for (var k = 1; k < 40; k++) row.push(r % 7 ? r * k / 100 : null); aoa.push(row); }
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "大表");
    var ws2 = XLSX.utils.aoa_to_sheet([["隱藏"]]);
    XLSX.utils.book_append_sheet(wb, ws2, "隱藏表");
    wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }] };
    var big = new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }));
    var t0 = performance.now();
    var mb = await YF.xlsx.load(big, "大.xlsx");
    var tLoad = performance.now() - t0;
    eq(mb.tables[0].nRows, 500); eq(mb.tables[0].nCols, 40);
    ok(mb.tables[1].hidden === true && mb.sheets[1].hidden === true, "隱藏工作表標記");
    var fills = [];
    mb.tables[0].cells.forEach(function (cc) { if (!cc.text && fills.length < 2000) fills.push({ tableId: mb.tables[0].id, r0: cc.r0, c0: cc.c0, value: "0." + (cc.r0 % 10) + "1" }); });
    t0 = performance.now();
    var rb = await YF.xlsx.fill(mb, fills);
    var tFill = performance.now() - t0;
    var back = XLSX.read(rb.bytes, { type: "array" });
    eq(back.Sheets["大表"]["B8"].v, 0.71);
    ok(tLoad < 5000 && tFill < 8000, "load " + tLoad.toFixed(0) + " ms / fill " + tFill.toFixed(0) + " ms");
    return "load " + tLoad.toFixed(0) + " ms、fill " + fills.length + " 格 " + tFill.toFixed(0) + " ms";
  });

  /* =====================================================================
   * zip：瀏覽器端（CompressionStream）往返
   * ===================================================================== */
  test("zip：瀏覽器 CompressionStream 往返與 copyWithChanges", async function () {
    var big = ""; for (var i = 0; i < 5000; i++) big += "<w:p>第" + i + "段</w:p>";
    var out = await YF.zip.write([{ name: "[Content_Types].xml", data: "<Types/>" }, { name: "中文.xml", data: big }]);
    var z = await YF.zip.read(out);
    eq(z.raw("中文.xml").method, 8, "有壓縮");
    eq(await z.text("中文.xml"), big);
    var o2 = await YF.zip.copyWithChanges(z, { "中文.xml": "x", "新.txt": "y" });
    var z2 = await YF.zip.read(o2);
    deq(z2.names, ["[Content_Types].xml", "中文.xml", "新.txt"]);
    ok(bytesEq(z2.raw("[Content_Types].xml").data, z.raw("[Content_Types].xml").data));
    await rejectsZh(YF.zip.read(new Uint8Array(100)));
  });

  /* ---------------- 執行 ---------------- */
  function line(cls, text) {
    var s = document.createElement("span"); s.className = cls; s.textContent = text + "\n"; logEl.appendChild(s);
  }
  (async function () {
    var pass = 0, failN = 0;
    for (var i = 0; i < tests.length; i++) {
      var t = tests[i];
      try {
        var note = await t.fn();
        results.push({ name: t.name, ok: true, msg: note || "" });
        pass++;
        line("ok", "PASS " + t.name + (note ? "  （" + note + "）" : ""));
      } catch (e) {
        results.push({ name: t.name, ok: false, msg: String(e && e.stack || e) });
        failN++;
        line("ng", "FAIL " + t.name + "\n     " + (e && e.message || e));
      }
    }
    sumEl.textContent = failN ? failN + " 項失敗，" + pass + " 項通過" : "全部通過（" + pass + " 項）";
    sumEl.className = failN ? "fail" : "pass";
    window.__TEST_DONE__ = true;
  })();
})();
