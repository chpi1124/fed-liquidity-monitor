@echo off
chcp 936 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 鸿学院 · 金融指标监控

rem -- 服务已在运行：直接打开页面 --
curl -s -o nul -m 2 http://localhost:3000/api/status >nul 2>nul
if not errorlevel 1 (
  echo 服务已在运行，正在打开页面…
  start "" "http://localhost:3000/"
  exit /b 0
)

rem -- 检查 Node.js --
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js。请先安装 https://nodejs.org/ 后重试。
  pause
  exit /b 1
)

echo 正在启动前后端服务（同一进程提供 API 与页面）…
echo 首次启动需从美联储官方源拉取并交叉校验数据，约 1-2 分钟。
echo 服务就绪后会自动打开浏览器；关闭本窗口即停止服务。
echo.

rem -- 后台轮询：服务就绪即开页（最长等 5 分钟）--
start "fed-open-browser" /min powershell -NoProfile -Command "for($i=0;$i -lt 150;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000/api/status' -TimeoutSec 2; if($r.StatusCode -eq 200){ Start-Process 'http://localhost:3000/'; break } } catch {}; Start-Sleep -Seconds 2 }"

node backend/server.js

echo.
echo 服务已退出。若上方有错误信息（如端口被占用），请截图反馈。
pause