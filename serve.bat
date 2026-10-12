@echo off
rem =====================================================================
rem Yang-analyze web 本機啟動器（雙擊即可，不需安裝 Python）
rem 使用 Windows 內建的 PowerShell 啟動 serve.ps1
rem 網址：http://localhost:8788/   測試頁：http://localhost:8788/tests/
rem 關閉此視窗即停止伺服器。
rem =====================================================================
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  Yang-analyze web 本機啟動器
echo  網址：http://localhost:8788/
echo  關閉此視窗即停止伺服器。
echo ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
if errorlevel 1 (
  echo.
  echo [錯誤] 伺服器無法啟動或已停止。常見原因是連接埠 8788 已被其他視窗占用，請關閉其他已開啟的本網站視窗後再試。
  pause
)
