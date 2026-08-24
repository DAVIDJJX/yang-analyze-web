/* =========================================================================
 * Yang-analyze web — core/xlsxwriter.js
 * 純前端 .xlsx 產生器（含字型/置中/數字格式/欄寬），零相依。
 * SheetJS 社群版寫出無法帶樣式，故輸出改由本模組自行組 Open XML。
 * 僅資料邏輯，不含任何版面樣式。
 * ========================================================================= */
(function () {
  "use strict";
  window.YangCore = window.YangCore || {};

  /* ---------------- CRC32（zip 需要） ---------------- */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return (c ^ -1) >>> 0;
  }

  var ENC = new TextEncoder();

  /* ---------------- zip（stored, 不壓縮） ---------------- */
  function buildZip(entries) { // entries: [{name, data(Uint8Array)}]
    var parts = [], central = [], offset = 0;
    // 固定時間戳（DOS 格式）：2026-01-01 00:00
    var dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
    entries.forEach(function (e) {
      var nameB = ENC.encode(e.name), crc = crc32(e.data), size = e.data.length;
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);          // version needed
      lh.setUint16(6, 0x0800, true);      // UTF-8 flag
      lh.setUint16(8, 0, true);           // stored
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, nameB.length, true);
      lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nameB, e.data);

      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true); ch.setUint32(24, size, true);
      ch.setUint16(28, nameB.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameB);
      offset += 30 + nameB.length + size;
    });
    var centralSize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);
    parts = parts.concat(central, [new Uint8Array(eocd.buffer)]);
    var total = parts.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    parts.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  /* ---------------- XML 工具 ---------------- */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/\r?\n/g, "&#10;");
  }
  function colName(n) { // 1 → A
    var s = "";
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  /* ---------------- 日期/時間 → Excel 序列值 ---------------- */
  // dateISO: 'YYYY-MM-DD' → 天數（1900 日期系統，錨點 1899-12-30）
  function dateSerial(iso) {
    var p = iso.split("-");
    return Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
  }
  // 'HH:MM' → 日的小數
  function timeSerial(hm) {
    var p = hm.split(":");
    return (parseInt(p[0], 10) * 60 + parseInt(p[1], 10)) / 1440;
  }

  /* ----------------------------------------------------------------------
   * build(spec) → Uint8Array (.xlsx)
   * spec = {
   *   fonts:  [{name, size}, ...]                  // index 0 為預設字型
   *   styles: [{font:0, numFmt:0, center:false}]   // cellXfs index 1 起（0 為預設）
   *   sheets: [{ name, cols:{A:12.0,...}, rows:[ [cell|null,...], ... ] }]
   * }
   * cell = { v, t:'s'|'n'|'d'|'tm', s:styleIdx }   // v=null 仍會寫出帶樣式空儲存格
   * t: s=字串(inline) n=數字 d='YYYY-MM-DD' tm='HH:MM'
   * ---------------------------------------------------------------------- */
  function build(spec) {
    var fontsXml = spec.fonts.map(function (f) {
      return '<font><sz val="' + f.size + '"/><color theme="1"/><name val="' + esc(f.name) + '"/><family val="2"/></font>';
    }).join("");
    var xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    spec.styles.forEach(function (st) {
      var x = '<xf numFmtId="' + (st.numFmt || 0) + '" fontId="' + (st.font || 0) +
        '" fillId="0" borderId="0" xfId="0" applyFont="1"';
      if (st.numFmt) x += ' applyNumberFormat="1"';
      if (st.center) x += ' applyAlignment="1"><alignment horizontal="center"/></xf>';
      else x += "/>";
      xfs.push(x);
    });
    var stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="' + spec.fonts.length + '">' + fontsXml + "</fonts>" +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join("") + "</cellXfs>" +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      "</styleSheet>";

    var sheetXmls = spec.sheets.map(function (sh) {
      var maxCol = 0;
      sh.rows.forEach(function (r) { if (r && r.length > maxCol) maxCol = r.length; });
      var dim = "A1:" + colName(Math.max(maxCol, 1)) + Math.max(sh.rows.length, 1);
      var colsXml = "";
      if (sh.cols && Object.keys(sh.cols).length) {
        colsXml = "<cols>" + Object.keys(sh.cols).map(function (letter) {
          var idx = letter.charCodeAt(0) - 64; // 單字母欄即可
          return '<col min="' + idx + '" max="' + idx + '" width="' + sh.cols[letter] + '" customWidth="1"/>';
        }).join("") + "</cols>";
      }
      var rowsXml = sh.rows.map(function (row, ri) {
        if (!row) return "";
        var cells = row.map(function (cell, ci) {
          if (cell === undefined) return "";
          if (cell === null) return "";
          var ref = colName(ci + 1) + (ri + 1);
          var sAttr = cell.s ? ' s="' + cell.s + '"' : "";
          if (cell.v === null || cell.v === undefined || cell.v === "") {
            return "<c r=\"" + ref + "\"" + sAttr + "/>";
          }
          if (cell.t === "n") return "<c r=\"" + ref + "\"" + sAttr + "><v>" + cell.v + "</v></c>";
          if (cell.t === "d") return "<c r=\"" + ref + "\"" + sAttr + "><v>" + dateSerial(cell.v) + "</v></c>";
          if (cell.t === "tm") return "<c r=\"" + ref + "\"" + sAttr + "><v>" + timeSerial(cell.v) + "</v></c>";
          return "<c r=\"" + ref + "\"" + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' + esc(cell.v) + "</t></is></c>";
        }).join("");
        return '<row r="' + (ri + 1) + '">' + cells + "</row>";
      }).join("");
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="' + dim + '"/>' +
        '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
        '<sheetFormatPr defaultRowHeight="16.5"/>' + colsXml +
        "<sheetData>" + rowsXml + "</sheetData></worksheet>";
    });

    var sheetsDecl = spec.sheets.map(function (sh, i) {
      return '<sheet name="' + esc(sh.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }).join("");
    var workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      "<sheets>" + sheetsDecl + "</sheets></workbook>";
    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      spec.sheets.map(function (_, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join("") +
      '<Relationship Id="rId' + (spec.sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>";
    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>";
    var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      spec.sheets.map(function (_, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>";

    var entries = [
      { name: "[Content_Types].xml", data: ENC.encode(contentTypes) },
      { name: "_rels/.rels", data: ENC.encode(rootRels) },
      { name: "xl/workbook.xml", data: ENC.encode(workbookXml) },
      { name: "xl/_rels/workbook.xml.rels", data: ENC.encode(wbRels) },
      { name: "xl/styles.xml", data: ENC.encode(stylesXml) }
    ];
    sheetXmls.forEach(function (xml, i) {
      entries.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: ENC.encode(xml) });
    });
    return buildZip(entries);
  }

  YangCore.xlsxwriter = { build: build, dateSerial: dateSerial, timeSerial: timeSerial };
})();
