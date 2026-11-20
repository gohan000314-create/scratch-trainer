@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8765

echo ==========================================
echo   Scratch Trainer 正在启动...
echo   访问地址: http://localhost:%PORT%
echo   提示: 请使用 Chrome 或 Edge 打开以支持 Web MIDI
echo   关闭本窗口即可停止服务
echo ==========================================

start "" "http://localhost:%PORT%"
python -m http.server %PORT%
