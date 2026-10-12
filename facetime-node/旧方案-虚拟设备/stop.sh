#!/usr/bin/env bash
# 关掉通话节点的所有进程
set -uo pipefail

# 工作目录默认就是脚本所在目录，避免和 $HOME 下的目录搞混
NODE_DIR="${FT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
RUN_DIR="$NODE_DIR/run"

for name in chrome vnc xvfb vcam; do
  PIDFILE="$RUN_DIR/$name.pid"
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
done

pkill -f 'google-chrome.*facetime-node' 2>/dev/null || true
pkill -f 'ffmpeg.*video10' 2>/dev/null || true
pkill -f 'x11vnc.*:99' 2>/dev/null || true
pkill -f 'Xvfb :99' 2>/dev/null || true

echo "已停止。"
free -h
