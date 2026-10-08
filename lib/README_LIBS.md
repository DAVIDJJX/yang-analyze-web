# lib/ 內建第三方函式庫

網站是純靜態頁面，所有函式庫都放在本資料夾，**執行時不連任何外部 CDN**（OCR、PDF 在離線 / 內網環境也能用）。
下列檔案皆為官方發行檔原樣複製（未修改；`*.min.js` 結尾的 `sourceMappingURL` 指向的 .map 未附上，只影響開發者工具）。

| 路徑 | 套件 / 版本 | 來源 | 授權 |
|---|---|---|---|
| `tesseract/tesseract.min.js` | tesseract.js 5.1.1 | npm `tesseract.js@5.1.1` → `dist/tesseract.min.js` | Apache-2.0（`tesseract/LICENSE`；內含元件見 `tesseract.min.js.LICENSE.txt`） |
| `tesseract/worker.min.js` | tesseract.js 5.1.1 | npm `tesseract.js@5.1.1` → `dist/worker.min.js` | Apache-2.0（內含 regenerator-runtime、buffer、ieee754、zlib.js 等 MIT/BSD 元件，見 `worker.min.js.LICENSE.txt`） |
| `tesseract/core/tesseract-core-simd-lstm.wasm.js` | tesseract.js-core 5.1.1（Tesseract 5 + Leptonica，WebAssembly，LSTM 專用、SIMD） | npm `tesseract.js-core@5.1.1` | Apache-2.0（`tesseract/core/LICENSE`） |
| `tesseract/core/tesseract-core-lstm.wasm.js` | 同上（不支援 wasm SIMD 的瀏覽器使用） | npm `tesseract.js-core@5.1.1` | Apache-2.0 |
| `tessdata/chi_tra.traineddata.gz` | tessdata_fast（繁體中文 LSTM 模型） | <https://github.com/tesseract-ocr/tessdata_fast> `chi_tra.traineddata`，以 `gzip -9 -n` 壓縮 | Apache-2.0（`tessdata/LICENSE`） |
| `tessdata/eng.traineddata.gz` | tessdata_fast（英文 LSTM 模型） | 同上 `eng.traineddata`，`gzip -9 -n` | Apache-2.0 |
| `pdfjs/pdf.min.js`、`pdfjs/pdf.worker.min.js` | pdf.js（pdfjs-dist）3.11.174，modern build | npm `pdfjs-dist@3.11.174` → `build/` | Apache-2.0（`pdfjs/LICENSE`） |
| `pdfjs/cmaps/*.bcmap` | pdf.js 3.11.174 CMap（中日韓非內嵌字型取字用，例如 `UniCNS-UCS2-H`、`ETen-B5-H`） | npm `pdfjs-dist@3.11.174` → `cmaps/` | Adobe CMap 授權（BSD 型，見 `pdfjs/cmaps/LICENSE`） |
| `xlsx.full.min.js` | SheetJS 社群版（既有） | <https://sheetjs.com> | Apache-2.0 |

SHA-256（驗證用）：

```
a8e29918d098b2b06e1012bdaeffb4aec0445c5d5654709023e0bd1f442a80e8  tesseract/tesseract.min.js
aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc  tesseract/worker.min.js
ce20eda9533cbed1e6c2b4276fbae1e0adc61b6754b5513084be601787b457cf  tesseract/core/tesseract-core-simd-lstm.wasm.js
8f04aa0cc81e7bde33f80e92fa01a7a665f0b4884d098acf5de9c7104a11dfaa  tesseract/core/tesseract-core-lstm.wasm.js
52ce5cdc5080a5847a02635b18a676fe41676840a86bd27e99954c24df9cd895  tessdata/chi_tra.traineddata.gz
2a66ec904bc0e7657b27e200a874c01e1bc8a58b756cbbaa9afbae736fa50edc  tessdata/eng.traineddata.gz
5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946  pdfjs/pdf.min.js
feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b  pdfjs/pdf.worker.min.js
```

## 使用方式（js/fill/ocr.js、js/fill/pdfread.js）

* 路徑一律相對於「網站根目錄」解析（預設由 `js/fill/*.js` 的 `<script src>` 推算），所以主頁 `/` 與測試頁
  `/tests/fill/` 都能正確載入；必要時可用 `YangFill.ocr.init({base})`、`YangFill.pdf.configure({base})` 指定。
* OCR 一律用 `OEM.LSTM_ONLY`，因此只附 `*-lstm` 兩種核心；tesseract.js 會依瀏覽器是否支援 wasm SIMD 自動選擇。
  語言檔以 gzip 傳送（`gzip: true`），解壓後快取在 IndexedDB（鍵名前綴 `yangfill-tessdata-fast-v1`，
  更換模型時請改這個前綴，避免讀到舊快取）。
* pdf.js 一律以 `isEvalSupported: false` 開啟（避免惡意 PDF 字型執行程式碼，CVE-2024-4367），
  `cMapUrl` 指向 `pdfjs/cmaps/`。
* 以 `file://` 直接開啟 index.html 時，瀏覽器禁止載入 Web Worker：OCR 不可用（會提示改用線上版或 serve.bat）；
  pdf.js 會自動改在主執行緒執行（較慢），中文非內嵌字型的 CMap 也可能讀不到。
* 本資料夾約 16 MB；首次使用 OCR 時瀏覽器實際下載約 7.7 MB（worker + 一種核心 + 兩個語言檔），之後由快取讀取。

## 更新方式

```sh
npm pack tesseract.js@5.1.1 tesseract.js-core@5.1.1 pdfjs-dist@3.11.174   # 或 npm install 後從 node_modules 複製
gzip -9 -n -c chi_tra.traineddata > lib/tessdata/chi_tra.traineddata.gz      # tessdata_fast
```

更新後請執行 `node tests/fill/ocr.test.js`、`node tests/fill/pdfread.test.js` 與
`node tests/fill/run_ocr_browser.mjs`（Playwright，離線驗證）。
