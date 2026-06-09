# Restart Polyplatform backend + frontend
# Usage: .\restart.ps1          (start only)
#        .\restart.ps1 -Build   (build backend first, then start)

param([switch]$Build)

function Kill-Port($port) {
    $pids = (netstat -ano | Select-String ":$port\s" | ForEach-Object {
        ($_ -split '\s+')[-1]
    } | Sort-Object -Unique)
    foreach ($p in $pids) {
        if ($p -match '^\d+$' -and $p -ne '0') {
            Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host "Stopping backend (3001) and frontend (5173)..." -ForegroundColor Yellow
Kill-Port 3001
Kill-Port 5173
Start-Sleep -Seconds 1

if ($Build) {
    Write-Host "Building backend..." -ForegroundColor Cyan
    Push-Location "E:\Polyplatform\packages\backend"
    npm run build
    if ($LASTEXITCODE -ne 0) { Write-Host "Build failed!" -ForegroundColor Red; Pop-Location; exit 1 }
    Pop-Location
    Write-Host "Build complete." -ForegroundColor Green
}

Write-Host "Starting backend..." -ForegroundColor Cyan
Start-Process -NoNewWindow -FilePath "node" `
    -ArgumentList "E:\Polyplatform\packages\backend\dist\index.js" `
    -RedirectStandardOutput "E:\Polyplatform\backend.log" `
    -RedirectStandardError  "E:\Polyplatform\backend.err"

Write-Host "Starting frontend..." -ForegroundColor Cyan
Start-Process -NoNewWindow -FilePath "cmd" `
    -ArgumentList "/c cd E:\Polyplatform\packages\frontend && npx vite --port 5173 > E:\Polyplatform\frontend.log 2>&1"

# Wait and verify
Start-Sleep -Seconds 5
$be = netstat -ano | Select-String ":3001.*LISTEN"
$fe = netstat -ano | Select-String ":5173.*LISTEN"

if ($be) { Write-Host "Backend  UP  — http://localhost:3001" -ForegroundColor Green }
else      { Write-Host "Backend  FAILED — check E:\Polyplatform\backend.err" -ForegroundColor Red }

if ($fe) { Write-Host "Frontend UP  — http://localhost:5173" -ForegroundColor Green }
else      { Write-Host "Frontend FAILED — check E:\Polyplatform\frontend.log" -ForegroundColor Red }
