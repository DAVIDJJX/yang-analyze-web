# GitHub Pages 部署教學（初學者版）

這份教學說明 Yang-analyze web 是怎麼放上網路的，以及日常怎麼更新。
照著做即可，不需要程式背景。

## 觀念：整件事只有三個角色

1. **你電腦上的資料夾**（`D:\Claude_use\yang-analyze-web`）— 程式碼的「工作區」
2. **GitHub 倉庫**（github.com/DAVIDJJX/yang-analyze-web）— 程式碼的「雲端保險箱」，
   每次上傳都留下版本紀錄，隨時可以回到任何舊版本
3. **GitHub Pages**（davidjjx.github.io/yang-analyze-web）— GitHub 免費幫你把倉庫內容
   變成網站；倉庫一更新，網站約 1 分鐘後自動跟著更新

把電腦上的修改送到雲端的動作叫 **push（推送）**；`git` 就是做這件事的工具。

## 第一次設定（本專案已完成，列出供日後建新站參考）

1. **安裝工具**（在 PowerShell 執行）：
   ```
   winget install Git.Git
   winget install GitHub.cli
   ```
2. **登入 GitHub**（會開瀏覽器要你輸入一組八碼授權碼）：
   ```
   gh auth login --hostname github.com --git-protocol https --web
   ```
3. **把資料夾變成 git 工作區並做第一次存檔**（在專案資料夾內）：
   ```
   git init -b main
   git add -A
   git commit -m "第一版"
   ```
4. **建立雲端倉庫並推送**：
   ```
   gh repo create 倉庫名稱 --public --source . --push
   ```
5. **開啟 GitHub Pages**：到倉庫網頁 → Settings → Pages →
   Source 選「Deploy from a branch」→ Branch 選 `main`、資料夾 `/ (root)` → Save。
   約 1 分鐘後網站就在 `https://帳號.github.io/倉庫名稱/`。
6. 專案根目錄放一個空檔案 `.nojekyll`（本專案已有），
   避免 GitHub 對網頁做多餘處理。

## 日常更新網站（最常用的三行）

程式碼改好、測試通過後，在專案資料夾開 PowerShell：

```
git add -A
git commit -m "這次改了什麼（寫給未來的自己看）"
git push
```

推上去約 1 分鐘後網站自動更新。看不到變化時先按 **Ctrl+F5** 強制重新整理
（本專案的 JS/CSS 引用帶 `?v=數字` 版本號，改版時會一併加 1，正常情況不用 Ctrl+F5）。

## 常用檢查指令

| 指令 | 用途 |
|---|---|
| `git status` | 看哪些檔案改了還沒存 |
| `git log --oneline -5` | 看最近 5 次存檔紀錄 |
| `git pull` | 把雲端最新版拉回電腦（換電腦或多人協作時先做這個） |
| `gh auth status` | 確認 GitHub 登入狀態 |

## 重要安全規則（本專案特別設定）

- `test_data/` 資料夾放真實監測數據，已在 `.gitignore` 排除——**永遠不會被推上雲端**。
  真實 raw data、成品檔只能放這裡。
- 推送前若不確定，先跑 `git status`，確認清單裡沒有不該公開的檔案。
- 倉庫是公開的（Pages 免費方案需公開）；程式碼與說明文件內不可含
  計畫代碼、書件名稱、測站座標等真實案件資料。

## 出問題時

- **推送失敗說要登入**：跑 `gh auth login --hostname github.com --git-protocol https --web` 重新登入
- **網站一直是舊的**：等 1~2 分鐘 → Ctrl+F5 → 還是舊的就到倉庫頁 Actions 分頁看 pages build 是否失敗
- **改壞了想回到上一版**：`git log --oneline` 找到想回去的版本號，
  `git revert 版本號` 會做一次「反向修改」的新存檔（安全，不會消滅歷史），再 `git push`
