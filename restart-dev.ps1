# Restart the pi-web dev server atomically (kill old -> clean cache -> start new)
# Run detached so the calling session is never disconnected.
$ErrorActionPreference = "SilentlyContinue"
$project = "C:\Users\zheng\Desktop\pi-web\pi-web-main"
Set-Location $project

# 1) kill old dev server tree (npm wrapper + next dev + workers)
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine -like "*next*dev*10141*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# also kill anything listening on 10141
Get-NetTCPConnection -LocalPort 10141 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

Start-Sleep -Seconds 2

# 2) clean cache
Remove-Item -Recurse -Force "$project\.next" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$project\node_modules\.cache" -ErrorAction SilentlyContinue

# 3) start dev server fully detached (own window, survives this script)
$logOut = "$project\dev-out.log"
$logErr = "$project\dev-err.log"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run dev" -WorkingDirectory $project `
  -WindowStyle Minimized -RedirectStandardOutput $logOut -RedirectStandardError $logErr

# 4) wait for readiness (up to 120s)
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:10141/api/models" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
      Write-Output "DEV_READY after ~$(( $i + 1 ) * 3)s"
      exit 0
    }
  } catch {}
}
Write-Output "DEV_NOT_READY"
exit 1
