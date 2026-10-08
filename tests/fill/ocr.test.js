/* =========================================================================
 * tests/fill/ocr.test.js — js/fill/ocr.js 單元測試（Node，注入假的 Tesseract）
 * 測：工作池分派 / 每個 worker 同時只跑一件 / PSM 快取 / 數字 worker / 逾時與當機自動重建 /
 *     cancel / terminate / 初始化失敗 / 影像輸入轉換 / 文字後處理 / 路徑解析。
 * 真正的 Tesseract 整合（離線、真實儲存格）見 tests/fill/run_ocr_browser.mjs。
 * 執行：node tests/fill/ocr.test.js
 * ========================================================================= */
"use strict";
const assert = require("node:assert");
const path = require("node:path");

require(path.join(__dirname, "../../js/fill/ocr.js"));
const OCR = globalThis.YangFill.ocr;

const enc = (s) => new TextEncoder().encode(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 Tesseract：影像位元組即指令字串，例如 "TXT:0.034"、"SLOW:30:abc"、"HANG"、"FAIL"、"ABORT"、"CRASH" */
function makeFake(opts) {
  opts = opts || {};
  const log = { created: [], active: 0, maxActive: 0 };
  const T = {
    OEM: { LSTM_ONLY: 1 },
    createWorker(langs, oem, o, config) {
      const rec = { id: log.created.length, langs, oem, o, config, params: [], jobs: 0, active: 0, terminated: false, listeners: [] };
      log.created.push(rec);
      const w = {
        worker: { addEventListener: (t, f) => { if (t === "error") rec.listeners.push(f); } },
        setParameters(p) { rec.params.push(p); return sleep(1).then(() => ({})); },
        recognize(img, ro, out) {
          rec.out = out;
          const cmd = new TextDecoder().decode(img);
          rec.jobs++; rec.active++; log.active++;
          log.maxActive = Math.max(log.maxActive, log.active);
          assert.ok(rec.active === 1, "同一個 worker 不可同時跑兩件工作");
          const end = (v) => { rec.active--; log.active--; return v; };
          const psm = rec.params.reduce((a, p) => p.tessedit_pageseg_mode || a, null);
          if (cmd === "HANG") return new Promise(() => {});
          if (cmd === "CRASH") { setTimeout(() => rec.listeners.forEach((f) => f({ message: "boom" })), 5); return new Promise(() => {}); }
          if (cmd === "FAIL") return sleep(2).then(() => { end(); throw "Error: Error attempting to read image."; });
          if (cmd === "ABORT") return sleep(2).then(() => { end(); throw "RuntimeError: Aborted(OOM)"; });
          if (cmd === "LATEABORT") return sleep(60).then(() => { end(); throw "RuntimeError: Aborted(late)"; });  // 逾時被終止後才回報
          let ms = 3, text = cmd;
          const m = /^SLOW:(\d+):(.*)$/s.exec(cmd);
          if (m) { ms = +m[1]; text = m[2]; }
          if (text.startsWith("TXT:")) text = text.slice(4);
          if (text === "PSM?") text = "psm" + psm;
          return sleep(ms).then(() => end({ data: { text: text + "\n", confidence: 91 } }));
        },
        terminate() { rec.terminated = true; return Promise.resolve(); }
      };
      const fail = opts.initFail && opts.initFail(rec);
      if (fail) {
        if (fail === "handler") {   // tesseract.js 實際行為：errorHandler 被呼叫、Promise 永不 resolve
          setTimeout(() => o.errorHandler("Error: Network error while fetching chi_tra.traineddata.gz"), 3);
          return new Promise(() => {});
        }
        return sleep(2).then(() => { throw new Error("worker 404"); });
      }
      // 模擬初始化進度訊息
      setTimeout(() => {
        o.logger({ status: "loading tesseract core", progress: 1 });
        o.logger({ status: "loading language traineddata", progress: 1 });
        o.logger({ status: "initializing api", progress: 1 });
      }, 1);
      return sleep(opts.initMs || 5).then(() => w);
    }
  };
  return { T, log };
}

async function expectReject(p, re) {
  try { await p; } catch (e) { if (re) assert.match(String(e && e.message), re); return e; }
  assert.fail("預期被拒絕");
}

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
// 看門狗：任何工作卡住（逾時/錯誤處理失效）都算失敗，而不是讓測試永遠不結束
const watchdog = setTimeout(() => { console.error("FAIL ocr.test.js: 測試卡住（第 " + checks + " 項後）"); process.exit(1); }, 20000);
let finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) { console.error("FAIL ocr.test.js: 未跑完就結束（第 " + checks + " 項後，可能有 Promise 永不完成）"); process.exitCode = 1; }
});

(async () => {
  /* ---------- 文字後處理 ---------- */
  const C = OCR.cleanText;
  assert.strictEqual(C("示 範 新 城\n", "7"), "示範新城"); checks++;
  assert.strictEqual(C("最 大 小 時\n平 均 值", "7"), "最大小時平均值"); checks++;
  assert.strictEqual(C("日 平 均 值\n\n 0 .012 \n", "6"), "日平均值\n0.012"); checks++;
  assert.strictEqual(C("監測位置 : 示 範 新城", "7"), "監測位置 : 示範新城"); checks++;
  assert.strictEqual(C("SO2  (ppm)\r\n", "6"), "SO2 (ppm)"); checks++;
  assert.strictEqual(C("0. 034", "7"), "0.034"); checks++;
  assert.strictEqual(C("1 0 . 5", "7", true), "10.5"); checks++;
  assert.strictEqual(C("\u200b\ufeff  \n ", "6"), ""); checks++;
  assert.strictEqual(C(null, "6"), ""); checks++;
  assert.strictEqual(C("115.08.31/ 10: 00", "7"), "115.08.31/ 10: 00"); checks++;
  assert.strictEqual(C("中 文 ： 測 試", "7"), "中文：測試"); checks++;     // 全形標點
  assert.strictEqual(C("𠀀 𠀁", "7"), "𠀀𠀁"); checks++;                     // 擴充 B 區（代理對）

  /* ---------- 影像輸入轉換 ---------- */
  const bm = { width: 10, height: 2, data: new Uint8Array(20) };
  bm.data[0] = 1; bm.data[9] = 1; bm.data[10 + 8] = 1;
  const pbm = OCR.bitmapToPBM(bm);
  const head = "P4\n10 2\n";
  assert.strictEqual(new TextDecoder().decode(pbm.slice(0, head.length)), head); checks++;
  assert.deepStrictEqual(Array.from(pbm.slice(head.length)), [0x80, 0x40, 0x00, 0x80]); checks++;
  const rgba = new Uint8ClampedArray([0, 0, 0, 255, 255, 0, 0, 255, 10, 20, 30, 0, 100, 100, 100, 128]);
  const pgm = OCR.rgbaToPGM(2, 2, rgba);
  const ph = "P5\n2 2\n255\n";
  assert.strictEqual(new TextDecoder().decode(pgm.slice(0, ph.length)), ph); checks++;
  // 黑→0；紅章（max=255）→255；alpha 0 → 白；半透明灰 → 與白合成
  assert.deepStrictEqual(Array.from(pgm.slice(ph.length)), [0, 255, 255, 177]); checks++;
  assert.deepStrictEqual(Array.from(OCR.rgbaToPGM(1, 1, new Uint8ClampedArray([255, 0, 0, 255]), "luma").slice(ph.length)), [76]); checks++;
  assert.strictEqual(await OCR.toImageBytes(null), null); checks++;
  assert.strictEqual(await OCR.toImageBytes(new Uint8Array(0)), null); checks++;
  assert.strictEqual((await OCR.toImageBytes(new Uint8Array([1, 2, 3]).buffer)).length, 3); checks++;
  assert.strictEqual(new TextDecoder().decode((await OCR.toImageBytes(bm)).slice(0, 2)), "P4"); checks++;
  assert.strictEqual(new TextDecoder().decode((await OCR.toImageBytes({ width: 2, height: 2, data: rgba })).slice(0, 2)), "P5"); checks++;
  await expectReject(OCR.toImageBytes({ width: 3, height: 3, data: new Uint8Array(5) }), /長度不符/); checks++;
  await expectReject(OCR.toImageBytes({ foo: 1 }), /不支援/); checks++;
  const dv = new DataView(new Uint8Array([9, 8, 7]).buffer, 1, 2);
  assert.deepStrictEqual(Array.from(await OCR.toImageBytes(dv)), [8, 7]); checks++;

  /* ---------- 路徑 ---------- */
  assert.strictEqual(OCR.resolveBase("https://x.github.io/yang-analyze-web"), "https://x.github.io/yang-analyze-web/"); checks++;
  assert.strictEqual(OCR.resolveBase("https://x.github.io/app/?v=1#a"), "https://x.github.io/app/"); checks++;
  assert.strictEqual(OCR.defaultWorkers() >= 1 && OCR.defaultWorkers() <= 3, true); checks++;

  /* ---------- available() ---------- */
  OCR._setTesseract(null);
  ok(!OCR.available().ok, "沒有 Tesseract 時不可用");
  await expectReject(OCR.recognize(enc("TXT:1")), /Worker|Tesseract|OCR/); checks++;
  globalThis.location = { protocol: "file:", href: "file:///C:/x/index.html", origin: "null" };
  OCR._setTesseract(makeFake().T);
  const av = OCR.available();
  ok(!av.ok && /serve\.bat/.test(av.reason), "file:// 不可用並提示 serve.bat");
  await expectReject(OCR.recognize(enc("TXT:1")), /serve\.bat/); checks++;
  ok(OCR.info().queued === 0, "init 失敗的工作不可殘留在佇列");
  delete globalThis.location;

  /* ---------- 基本分派 ---------- */
  let F = makeFake();
  OCR._setTesseract(F.T);
  const prog = [];
  const inf = await OCR.init({ workers: 2, base: "https://example.org/site", onProgress: (p) => prog.push(p) });
  ok(inf.ready && inf.workers === 2, "init 建立 2 個 worker");
  ok(OCR.init() === OCR.init(), "重複 init 回傳同一 Promise");
  const c0 = F.log.created[0];
  ok(c0.langs === "chi_tra+eng" && c0.oem === 1, "langs / OEM LSTM_ONLY");
  ok(c0.o.workerPath === "https://example.org/site/lib/tesseract/worker.min.js", "workerPath " + c0.o.workerPath);
  ok(c0.o.corePath === "https://example.org/site/lib/tesseract/core", "corePath 為目錄");
  ok(c0.o.langPath === "https://example.org/site/lib/tessdata", "langPath");
  ok(c0.o.gzip === true && c0.o.cacheMethod === "write" && /yangfill/.test(c0.o.cachePath), "gzip / IndexedDB 快取");
  ok(typeof c0.o.errorHandler === "function", "提供 errorHandler（避免未捕捉例外）");
  ok(c0.params[0].tessedit_pageseg_mode === "6" && c0.params[0].user_defined_dpi === "200", "初始參數");
  ok(prog.length >= 3 && prog[prog.length - 1].progress === 1 && /模型|引擎/.test(prog[prog.length - 1].status), "init 進度");

  const jobs = [];
  for (let i = 0; i < 12; i++) jobs.push({ bytes: enc("SLOW:" + (5 + (i % 3) * 4) + ":v" + i), psm: "7" });
  const pr = [];
  const res = await OCR.recognizeCells(jobs, (d, t) => pr.push(d + "/" + t));
  ok(res.every((r, i) => r.text === "v" + i && r.conf === 91), "結果順序與 jobs 相同");
  ok(pr[0] === "0/12" && pr[pr.length - 1] === "12/12" && pr.length === 13, "recognizeCells 進度");
  ok(F.log.maxActive === 2, "同時執行數 = worker 數（" + F.log.maxActive + "）");
  ok(F.log.created.every((c) => c.jobs > 0), "兩個 worker 都有分到工作");
  ok(c0.out && c0.out.blocks === false && c0.out.hocr === false && c0.out.tsv === false && c0.out.text === true, "只要求 text 輸出");

  // PSM 快取：連續相同 PSM 不重複 setParameters
  const before = F.log.created.map((c) => c.params.length);
  await OCR.recognizeCells([1, 2, 3, 4, 5, 6].map(() => ({ bytes: enc("TXT:x"), psm: "7" })));
  ok(F.log.created.every((c, i) => c.params.length === before[i]), "PSM 已是 7 時不再 setParameters");
  const r6 = await OCR.recognize(enc("PSM?"), { psm: "6" });
  ok(r6.text === "psm6", "切換 PSM 6 後生效：" + r6.text);
  const r7 = await OCR.recognize(enc("PSM?"), { psm: 7 });
  ok(r7.text === "psm7", "數字 PSM 也可：" + r7.text);
  const rBad = await OCR.recognize(enc("PSM?"), { psm: "99" });
  ok(rBad.text === "psm6", "無效 PSM → 6");

  // 空輸入不進佇列
  const jb = F.log.created.reduce((s, c) => s + c.jobs, 0);
  const re = await OCR.recognize(null);
  ok(re.text === "" && re.conf === 0 && F.log.created.reduce((s, c) => s + c.jobs, 0) === jb, "null 不送 OCR");
  const rEmpty = await OCR.recognize(enc("TXT:   "));
  ok(rEmpty.text === "" && rEmpty.conf === 0, "空結果 conf=0");

  /* ---------- 數字 worker ---------- */
  const rn = await OCR.recognize(enc("TXT:0 .0 34"), { numeric: true });
  const numRec = F.log.created[F.log.created.length - 1];
  ok(numRec.langs === "eng" && numRec.config.load_system_dawg === "0", "數字 worker：eng、關字典");
  ok(numRec.params[0].tessedit_char_whitelist === "0123456789.<>-NDnd" && numRec.params[0].tessedit_pageseg_mode === "7", "白名單 + PSM 7");
  ok(rn.text === "0.034", "數字結果移除空白：" + rn.text);
  ok(OCR.info().numeric === true, "info().numeric");
  const nCreated = F.log.created.length;
  await Promise.all([OCR.recognize(enc("TXT:1"), { numeric: true }), OCR.recognize(enc("TXT:2"), { numeric: true })]);
  ok(F.log.created.length === nCreated, "數字 worker 只建立一次");

  /* ---------- 單格錯誤 / 逾時 / 當機 / wasm abort ---------- */
  const mixed = await OCR.recognizeCells([{ bytes: enc("TXT:a") }, { bytes: enc("FAIL") }, { bytes: enc("TXT:c") }]);
  ok(mixed[0].text === "a" && mixed[2].text === "c" && /讀取|read image/.test(mixed[1].error) && mixed[1].text === "", "單格失敗不影響整批");

  let created0 = F.log.created.length;
  const tmo = await OCR.recognizeCells([{ bytes: enc("HANG"), timeout: 30 }, { bytes: enc("TXT:after") }]);
  ok(/逾時/.test(tmo[0].error) && tmo[1].text === "after", "逾時回報錯誤：" + tmo[0].error);
  await sleep(30);
  ok(F.log.created.length === created0 + 1 && F.log.created.some((c) => c.terminated), "逾時的 worker 被終止並重建");
  ok(OCR.info().workers === 2, "重建後仍 2 個 worker");

  created0 = F.log.created.length;
  const crash = await OCR.recognizeCells([{ bytes: enc("CRASH") }, { bytes: enc("TXT:ok") }]);
  ok(/OCR worker 發生錯誤/.test(crash[0].error) && crash[1].text === "ok", "worker error 事件 → 該格錯誤：" + crash[0].error);
  await sleep(30);
  ok(F.log.created.length === created0 + 1, "當機 worker 重建");

  created0 = F.log.created.length;
  const ab = await OCR.recognizeCells([{ bytes: enc("ABORT") }, { bytes: enc("TXT:z") }]);
  ok(/Aborted/.test(ab[0].error) && ab[1].text === "z", "wasm abort 回報");
  await sleep(30);
  ok(F.log.created.length === created0 + 1, "wasm abort 後重建 worker");
  const after = await OCR.recognizeCells([1, 2, 3, 4].map((i) => ({ bytes: enc("TXT:" + i) })));
  ok(after.map((r) => r.text).join() === "1,2,3,4", "重建後正常");
  ok(OCR.info().respawns === 3, "respawns 計數 " + OCR.info().respawns);

  // 舊 worker 被逾時終止後才回報 abort：不得把已重建的新 worker 也殺掉
  created0 = F.log.created.length;
  const rs0 = OCR.info().respawns;
  const late = await OCR.recognizeCells([{ bytes: enc("LATEABORT"), timeout: 15 }]);
  ok(/逾時/.test(late[0].error), "LATEABORT 先逾時");
  await sleep(25);
  const busy = OCR.recognizeCells([1, 2, 3, 4, 5, 6].map((i) => ({ bytes: enc("SLOW:15:L" + i) })));
  await sleep(60);                             // 期間舊 worker 的 abort 到達
  const lr = await busy;
  ok(lr.map((r) => r.text).join() === "L1,L2,L3,L4,L5,L6", "新 worker 不受舊結果影響：" + JSON.stringify(lr));
  ok(OCR.info().respawns === rs0 + 1 && F.log.created.length === created0 + 1, "只重建一次（" + (OCR.info().respawns - rs0) + "）");

  /* ---------- cancel ---------- */
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ bytes: enc("SLOW:10:c" + i) });
  const pm = OCR.recognizeCells(many);
  const nc = OCR.cancel();                    // 同步呼叫：影像轉換尚未完成也要能取消
  ok(nc === 20, "cancel 回傳筆數 " + nc);
  const err = await expectReject(pm);
  ok(err.name === "AbortError", "整批 AbortError");
  const pm2 = OCR.recognizeCells(many.slice(0, 10));
  await sleep(12);                            // 已有工作在跑
  OCR.cancel();
  await expectReject(pm2); checks++;
  await sleep(20);
  ok(OCR.info().running === 0 && OCR.info().queued === 0, "cancel 後佇列清空、執行中的會完成");
  const rAfter = await OCR.recognize(enc("TXT:alive"));
  ok(rAfter.text === "alive", "cancel 後仍可使用");

  /* ---------- terminate ---------- */
  const pend = OCR.recognizeCells([1, 2, 3, 4, 5, 6].map(() => ({ bytes: enc("SLOW:20:t") })));
  await sleep(5);
  await OCR.terminate();
  const te = await expectReject(pend);
  ok(te.name === "AbortError", "terminate → 進行中與排隊工作 AbortError");
  const live = F.log.created.filter((c) => !c.terminated);
  ok(live.length === 0, "所有 worker 已終止（剩 " + live.length + "）");
  ok(!OCR.info().ready && OCR.info().workers === 0, "terminate 後狀態重置");
  const rr = await OCR.recognize(enc("TXT:again"));
  ok(rr.text === "again" && OCR.info().ready, "terminate 後自動重新 init");
  await OCR.terminate();

  /* ---------- 初始化失敗 ---------- */
  F = makeFake({ initFail: () => true });
  OCR._setTesseract(F.T);
  const pj = OCR.recognize(enc("TXT:q"));
  await expectReject(OCR.init({ workers: 2 }), /OCR 初始化失敗：worker 404/); checks++;
  await expectReject(pj, /OCR 初始化失敗/); checks++;
  ok(OCR.info().queued === 0 && !OCR.info().ready, "失敗後佇列清空");
  // 下次 init 可重試成功
  F = makeFake();
  OCR._setTesseract(F.T);
  ok((await OCR.init({ workers: 1 })).ready, "失敗後可重新 init");
  await OCR.terminate();

  // errorHandler 路徑（tesseract.js 下載語言檔失敗時 createWorker 永不 resolve）
  F = makeFake({ initFail: () => "handler" });
  OCR._setTesseract(F.T);
  await expectReject(OCR.init({ workers: 1 }), /Network error/); checks++;
  ok(F.log.created.length === 1, "");
  await OCR.terminate();

  // 初始化逾時
  F = makeFake({ initMs: 200 });
  OCR._setTesseract(F.T);
  await expectReject(OCR.init({ workers: 1, initTimeout: 20 }), /逾時/); checks++;
  await sleep(220);
  ok(F.log.created[0].terminated, "逾時後晚到的 worker 會被終止");
  await OCR.terminate();

  // 部分 worker 失敗：以成功的數量運作
  let k = 0;
  F = makeFake({ initFail: () => (k++ === 1) });
  OCR._setTesseract(F.T);
  const pi = await OCR.init({ workers: 3 });
  ok(pi.workers === 2 && /部分/.test(pi.lastError), "部分失敗：" + JSON.stringify(pi));
  const pr3 = await OCR.recognizeCells([1, 2, 3].map((i) => ({ bytes: enc("TXT:" + i) })));
  ok(pr3.map((r) => r.text).join() === "1,2,3", "部分失敗仍可辨識");
  await OCR.terminate();

  // 數字 worker 建立失敗 → 改用一般 worker
  F = makeFake({ initFail: (rec) => rec.langs === "eng" });
  OCR._setTesseract(F.T);
  await OCR.init({ workers: 1 });
  const nf = await OCR.recognize(enc("TXT:1 2"), { numeric: true });
  ok(nf.text === "12" && !OCR.info().numeric, "數字 worker 失敗 → 一般 worker（仍移除空白）：" + nf.text);
  await OCR.terminate();

  // init 進行中呼叫 terminate：晚到的 worker 必須被終止、不得加入新的工作池
  F = makeFake({ initMs: 40 });
  OCR._setTesseract(F.T);
  const racing = OCR.init({ workers: 2 });
  await sleep(5);
  await OCR.terminate();
  const re2 = await expectReject(racing);
  ok(re2.name === "AbortError", "init 中 terminate → AbortError");
  await sleep(60);
  ok(F.log.created.length === 2 && F.log.created.every((c) => c.terminated), "晚到的 worker 已終止");
  ok(OCR.info().workers === 0 && !OCR.info().ready, "terminate 後不會被舊 init 復活");

  // 定期重建 worker（recycleAfter）：結果不受影響、不算失敗
  F = makeFake();
  OCR._setTesseract(F.T);
  await OCR.init({ workers: 1, recycleAfter: 5 });
  const rc = await OCR.recognizeCells(Array.from({ length: 23 }, (_, i) => ({ bytes: enc("TXT:r" + i) })));
  ok(rc.every((r, i) => r.text === "r" + i && !r.error), "重建期間結果正確");
  const ri = OCR.info();
  ok(ri.recycled === 4 && ri.respawns === 0 && F.log.created.length === 5, "每 5 件重建一次：" + JSON.stringify({ recycled: ri.recycled, created: F.log.created.length }));
  ok(F.log.created.slice(0, 4).every((c) => c.terminated && c.jobs === 5), "舊 worker 已終止且各跑 5 件");
  await OCR.terminate();
  F = makeFake();
  OCR._setTesseract(F.T);
  await OCR.init({ workers: 2, recycleAfter: 0 });
  await OCR.recognizeCells(Array.from({ length: 30 }, () => ({ bytes: enc("TXT:x") })));
  ok(OCR.info().recycled === 0 && F.log.created.length === 2, "recycleAfter:0 不重建");
  await OCR.terminate();

  // 重建失敗會延遲重試；全部失敗才放棄（排隊工作在重試期間等待，不會立刻失敗）
  OCR._setRetryMs(10);
  let failN = 0;
  F = makeFake({ initFail: (rec) => rec.id >= 1 && failN++ < 2 });   // 第 1 次重建、第 2 次失敗，第 3 次成功
  OCR._setTesseract(F.T);
  await OCR.init({ workers: 1 });
  const rt = await OCR.recognizeCells([{ bytes: enc("CRASH") }, { bytes: enc("TXT:wait1") }, { bytes: enc("TXT:wait2") }]);
  ok(/發生錯誤/.test(rt[0].error) && rt[1].text === "wait1" && rt[2].text === "wait2", "重建重試成功後繼續：" + JSON.stringify(rt));
  ok(F.log.created.length === 4, "共建立 4 次（1 + 失敗 2 + 成功 1）：" + F.log.created.length);
  await OCR.terminate();
  F = makeFake({ initFail: (rec) => rec.id >= 1 });                  // 重建永遠失敗
  OCR._setTesseract(F.T);
  await OCR.init({ workers: 1 });
  const rf = await OCR.recognizeCells([{ bytes: enc("CRASH") }, { bytes: enc("TXT:never") }]);
  ok(rf[1].error && /停止運作/.test(rf[1].error), "重建全部失敗 → 排隊工作回報錯誤：" + JSON.stringify(rf[1]));
  ok(F.log.created.length === 4, "最多重試 3 次：" + F.log.created.length);
  await OCR.terminate();
  OCR._setRetryMs(1000);

  // 參數夾限
  F = makeFake();
  OCR._setTesseract(F.T);
  const i9 = await OCR.init({ workers: 9, dpi: 0, langs: "chi_tra" });
  ok(i9.workers === 4 && F.log.created[0].langs === "chi_tra" && !("user_defined_dpi" in F.log.created[0].params[0]), "workers 上限 4、dpi:0 不設、langs 可改");
  await OCR.terminate();

  OCR._setTesseract(null);
  finished = true;
  clearTimeout(watchdog);
  console.log("PASS ocr.test.js: " + checks + " checks");
})().catch((e) => {
  console.error("FAIL ocr.test.js:", e && e.stack || e);
  process.exit(1);
});
