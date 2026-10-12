# Yang-analyze web - 本機靜態伺服器（不需安裝 Python，使用 Windows 內建的 PowerShell）
# 由 serve.bat 呼叫，雙擊 serve.bat 即可；預設網址 http://localhost:8788/
param([int]$Port = 8788)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.md' = 'text/markdown; charset=utf-8'
  '.txt' = 'text/plain; charset=utf-8'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
  '.gif' = 'image/gif'; '.webp' = 'image/webp'; '.ico' = 'image/x-icon'
  '.wasm' = 'application/wasm'; '.gz' = 'application/gzip'
  '.bcmap' = 'application/octet-stream'; '.pdf' = 'application/pdf'
  '.xlsx' = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  '.xls' = 'application/vnd.ms-excel'
  '.docx' = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

# 先試 localhost，不行再試 127.0.0.1（部分電腦對 localhost 有權限限制）
$listener = $null
$address = $null
foreach ($h in @('localhost', '127.0.0.1')) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://${h}:$Port/")
    $l.Start()
    $listener = $l
    $address = "http://${h}:$Port/"
    break
  } catch {
    try { $l.Close() } catch {}
  }
}
if (-not $listener) {
  Write-Host "無法在連接埠 $Port 啟動伺服器。請關閉其他已開啟的 Yang-analyze web 視窗後再試。"
  exit 2
}

Write-Host "Yang-analyze web 已啟動：$address"
Write-Host "填表核對測試頁：${address}tests/"
Write-Host "關閉此視窗即停止伺服器。"
try { Start-Process $address } catch { Write-Host "請手動用瀏覽器開啟 $address" }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $urlPath = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($urlPath.EndsWith('/')) { $urlPath = $urlPath + 'index.html' }
    $rel = $urlPath.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
    $full = [IO.Path]::GetFullPath((Join-Path $root $rel))
    $inside = $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
    if ($inside -and (Test-Path -LiteralPath $full -PathType Leaf)) {
      $bytes = [IO.File]::ReadAllBytes($full)
      $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
      $ct = $mime[$ext]
      if (-not $ct) { $ct = 'application/octet-stream' }
      $res.StatusCode = 200
      $res.ContentType = $ct
      $res.Headers['Cache-Control'] = 'no-cache'
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $res.ContentLength64 = $msg.Length
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
    try { $res.StatusCode = 500 } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}
