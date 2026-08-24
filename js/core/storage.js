/* =========================================================================
 * Yang-analyze web — core/storage.js
 * IndexedDB 儲存層 + JSON 備份/還原。
 * 儲存內容：
 *   projects  案場（監測點基本資料）        keyPath: code
 *   stations  測站記憶（座標、別名、上次時間迄） keyPath: name
 *   imports   匯入紀錄（解析結果快照）       keyPath: id (auto)
 *   tables    對照表覆寫（對照表編輯頁）      keyPath: name
 *   settings  雜項設定（作用中案場等）        keyPath: key
 * ========================================================================= */
(function () {
  "use strict";
  window.YangCore = window.YangCore || {};

  var DB_NAME = "yang-analyze-web", DB_VER = 1, STORES = ["projects", "stations", "imports", "tables", "settings"];
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "code" });
        if (!db.objectStoreNames.contains("stations")) db.createObjectStore("stations", { keyPath: "name" });
        if (!db.objectStoreNames.contains("imports")) db.createObjectStore("imports", { keyPath: "id", autoIncrement: true });
        if (!db.objectStoreNames.contains("tables")) db.createObjectStore("tables", { keyPath: "name" });
        if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode), os = t.objectStore(store), out = fn(os);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  function reqToPromise(storeName, mode, makeReq) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        var req = makeReq(t.objectStore(storeName));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  var storage = {
    get: function (store, key) { return reqToPromise(store, "readonly", function (os) { return os.get(key); }); },
    getAll: function (store) { return reqToPromise(store, "readonly", function (os) { return os.getAll(); }); },
    put: function (store, obj) { return reqToPromise(store, "readwrite", function (os) { return os.put(obj); }); },
    del: function (store, key) { return reqToPromise(store, "readwrite", function (os) { return os.delete(key); }); },
    clearStore: function (store) { return reqToPromise(store, "readwrite", function (os) { return os.clear(); }); },

    getSetting: function (key) {
      return storage.get("settings", key).then(function (r) { return r ? r.value : null; });
    },
    setSetting: function (key, value) { return storage.put("settings", { key: key, value: value }); },

    /* ---------- JSON 備份 / 還原 ---------- */
    backupAll: function () {
      var data = {};
      return Promise.all(STORES.map(function (s) {
        return storage.getAll(s).then(function (rows) { data[s] = rows; });
      })).then(function () {
        return { app: "yang-analyze-web", version: 1, exportedAt: new Date().toISOString(), data: data };
      });
    },
    restoreAll: function (json) {
      if (!json || json.app !== "yang-analyze-web" || !json.data) {
        return Promise.reject(new Error("備份檔格式不正確"));
      }
      var chain = Promise.resolve();
      STORES.forEach(function (s) {
        chain = chain.then(function () { return storage.clearStore(s); }).then(function () {
          var rows = json.data[s] || [];
          return Promise.all(rows.map(function (r) { return storage.put(s, r); }));
        });
      });
      return chain;
    },
    clearAll: function () {
      return Promise.all(STORES.map(function (s) { return storage.clearStore(s); }));
    }
  };

  YangCore.storage = storage;
})();
