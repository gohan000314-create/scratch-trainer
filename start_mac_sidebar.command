#!/bin/bash
# macOS 侧边栏模式一键启动（无地址栏 Chrome 独立竖窗，适合贴在 Serato / djay 右侧）
cd "$(dirname "$0")"
PORT=8765

echo "=========================================="
echo "  Scratch Trainer 侧边栏模式正在启动..."
echo "  访问地址: http://localhost:$PORT"
echo "  提示: 将以 400px 窄窗独立模式在 Chrome 打开"
echo "  关闭本窗口即可停止服务"
echo "=========================================="

# 延迟 1 秒以 Chrome App 独立竖窗打开（无地址栏、无标签页）
(sleep 1 && (
  if [ -d "/Applications/Google Chrome.app" ]; then
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
      --app="http://localhost:$PORT" \
      --window-size=400,900 >/dev/null 2>&1 &
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
      --app="http://localhost:$PORT" \
      --window-size=400,900 >/dev/null 2>&1 &
  else
    open "http://localhost:$PORT"
  fi
)) &

python3 -m http.server $PORT
