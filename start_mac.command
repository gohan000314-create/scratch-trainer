#!/bin/bash
# macOS 一键启动 Scratch Trainer（请用 Chrome 或 Edge 打开以支持 Web MIDI）
cd "$(dirname "$0")"
PORT=8765

echo "=========================================="
echo "  Scratch Trainer 正在启动..."
echo "  访问地址: http://localhost:$PORT"
echo "  提示: 请使用 Chrome 或 Edge 打开以连接 Rane One MIDI"
echo "  关闭本窗口即可停止服务"
echo "=========================================="

# 延迟 1 秒自动打开浏览器（优先 Chrome）
(sleep 1 && (open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT")) &

python3 -m http.server $PORT
