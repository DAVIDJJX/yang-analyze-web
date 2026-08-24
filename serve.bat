@echo off
rem =====================================================================
rem Yang-analyze web 本機啟動器
rem 雙擊本檔 → 啟動本機伺服器並自動開啟瀏覽器
rem 主程式  http://localhost:8788/        驗收測試  http://localhost:8788/tests/
rem 關閉：關掉這個黑色視窗即可
rem =====================================================================
chcp 65001 >nul
cd /d "%~dp0"
set PY=C:\Users\david\AppData\Local\Programs\Python\Python312\python.exe
if not exist "%PY%" set PY=python
start "" http://localhost:8788/
echo Yang-analyze web 已啟動： http://localhost:8788/  （測試頁 /tests/）
echo 關閉此視窗即停止伺服器。
"%PY%" -m http.server 8788
