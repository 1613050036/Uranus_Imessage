#!/usr/bin/env bash
# 拉起一次 FaceTime 通话节点
# 用法：bash call.sh 'https://facetime.apple.com/join#v=1&p=...&k=...'
# 停止：bash stop.sh
set -euo pipefail

LINK="${1:-}"
if [ -z "$LINK" ]; then
  echo "用法: bash call.sh '<FaceTime 链接>'" >&2
  exit 1
fi

# 工作目录默认就是脚本所在目录，避免和 $HOME 下的目录搞混
NODE_DIR="${FT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
AVATAR="$NODE_DIR/avatar.png"
DISPLAY_NUM=99
VNC_PORT=5900
RUN_DIR="$NODE_DIR/run"
mkdir -p "$RUN_DIR"

# 苹果官方只支持 Windows / 安卓的 Chrome，Linux 不在名单里，默认伪装成 Windows。
# 想用原生 UA 测试：FT_UA=native bash call.sh '<链接>'
CHROME_VER="$(google-chrome --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 131)"
UA_FLAGS=()
if [ "${FT_UA:-win}" != native ]; then
  UA_FLAGS=(--user-agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER}.0.0.0 Safari/537.36")
fi

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
[ -d "$XDG_RUNTIME_DIR" ] || { export XDG_RUNTIME_DIR="$NODE_DIR/xdg"; mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"; }

echo "==> 启动 PulseAudio"
pulseaudio --check || pulseaudio --start --exit-idle-time=-1
sleep 1

echo "==> 建虚拟声卡"
# vmic：角色的声音放进这里，Chrome 把它的 monitor 当麦克风
# vspk：Chrome 的输出（也就是对方的声音），之后从它的 monitor 录
pactl list short sinks | grep -q '^\S*\s*vmic' || \
  pactl load-module module-null-sink sink_name=vmic sink_properties=device.description=Uranus_Mic >/dev/null
pactl list short sinks | grep -q '^\S*\s*vspk' || \
  pactl load-module module-null-sink sink_name=vspk sink_properties=device.description=Uranus_Speaker >/dev/null
# monitor 是「监听口」，部分应用（包括 FaceTime 网页版）不把它当输入设备，
# 用 remap-source 包成一个正经麦克风
pactl list short sources | grep -q 'vmic_src' || \
  pactl load-module module-remap-source master=vmic.monitor source_name=vmic_src \
    source_properties=device.description=Uranus_Microphone >/dev/null
pactl set-default-sink vspk
pactl set-default-source vmic_src
pactl list short sinks
pactl list short sources

echo "==> 推头像到虚拟摄像头 /dev/video10"
bash "$(dirname "$0")/restart-cam.sh"

echo "==> 启动 Xvfb :$DISPLAY_NUM"
pkill -f "Xvfb :$DISPLAY_NUM" 2>/dev/null || true
Xvfb ":$DISPLAY_NUM" -screen 0 1280x800x24 -nolisten tcp >"$RUN_DIR/xvfb.log" 2>&1 &
echo $! >"$RUN_DIR/xvfb.pid"
sleep 1
export DISPLAY=":$DISPLAY_NUM"

echo "==> 启动 x11vnc（只监听本机，用 SSH 隧道连）"
pkill -f "x11vnc.*:$DISPLAY_NUM" 2>/dev/null || true
x11vnc -display ":$DISPLAY_NUM" -localhost -rfbport "$VNC_PORT" -forever -shared -nopw \
  >"$RUN_DIR/vnc.log" 2>&1 &
echo $! >"$RUN_DIR/vnc.pid"

echo "==> 启动 Chrome 并打开链接"
rm -rf "$RUN_DIR/chrome-profile"
# Chrome 不允许以 root 直接跑，必须关沙箱
ROOT_FLAGS=()
if [ "$(id -u)" -eq 0 ]; then
  ROOT_FLAGS=(--no-sandbox --disable-dev-shm-usage)
fi
google-chrome \
  "${ROOT_FLAGS[@]}" \
  --user-data-dir="$RUN_DIR/chrome-profile" \
  --use-fake-ui-for-media-stream \
  --autoplay-policy=no-user-gesture-required \
  --disable-extensions --disable-sync --disable-background-networking \
  --disable-features=Translate,MediaRouter \
  "${UA_FLAGS[@]}" \
  --renderer-process-limit=2 \
  --no-first-run --no-default-browser-check \
  --window-size=1280,800 \
  --window-position=0,0 \
  "$LINK" >"$RUN_DIR/chrome.log" 2>&1 &
echo $! >"$RUN_DIR/chrome.pid"

cat <<EOF

都起来了。

在你自己的电脑上开隧道看画面：
  ssh -N -L 5900:127.0.0.1:$VNC_PORT <用户名>@<这台机器的IP>
然后用 VNC 客户端连 127.0.0.1:5900（Windows 上可以用 TightVNC / RealVNC Viewer）

在 VNC 里点「加入」，然后在 iPhone 上允许。

接通后另开一个 SSH 窗口验证音频：
  bash check-audio.sh

结束：
  bash stop.sh
EOF
