#!/usr/bin/env bash
# 通话接通后验证音频双向 + 记录内存占用
# 用法：bash check-audio.sh
set -uo pipefail

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
# 工作目录默认就是脚本所在目录，避免和 $HOME 下的目录搞混
NODE_DIR="${FT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
RUN_DIR="$NODE_DIR/run"
mkdir -p "$RUN_DIR"

# 用原始 PCM 算 RMS，避免 wav 头没写完导致解析失败
rms() {
  python3 - "$1" <<'PY'
import sys, struct, math
data = open(sys.argv[1], 'rb').read()
n = len(data) // 2
if n == 0:
    print("NO_DATA"); raise SystemExit
vals = struct.unpack('<%dh' % n, data[:n*2])
rms = math.sqrt(sum(v*v for v in vals) / n)
db = 20 * math.log10(rms / 32768) if rms > 0 else -99
peak = max(abs(v) for v in vals)
print("%.1f %.1f" % (db, 20 * math.log10(peak/32768) if peak else -99))
PY
}

echo "=============================================="
echo " 设备检查"
echo "=============================================="
pactl list short sources | grep -E 'vmic|vspk' || echo "  !! 没找到虚拟设备"
echo "默认输入：$(pactl info | grep 'Default Source' | cut -d: -f2-)"
echo "默认输出：$(pactl info | grep 'Default Sink' | cut -d: -f2-)"
echo
echo "Chrome 正在播放到："
pactl list short sink-inputs || true
echo "Chrome 正在录自："
pactl list short source-outputs || true
echo

echo "=============================================="
echo " 测试 1/3：上行（角色说话 → 你的 iPhone）"
echo "=============================================="
echo "往虚拟麦克风放 6 秒提示音，注意听 iPhone..."
ffmpeg -loglevel error -nostdin \
  -f lavfi -i "sine=frequency=440:duration=6" \
  -f pulse -device vmic - >/dev/null 2>&1
echo
read -rp "iPhone 上听到「嘀——」声了吗？(y/n) " UP_OK
echo

echo "=============================================="
echo " 测试 2/3：下行（你说话 → 这台机器）"
echo "=============================================="
echo "接下来 8 秒，对着 iPhone 大声连续说话（念数字就行）..."
sleep 1
timeout 8 parecord --device=vspk.monitor --raw \
  --format=s16le --rate=16000 --channels=1 "$RUN_DIR/downlink.raw" 2>/dev/null
RESULT=$(rms "$RUN_DIR/downlink.raw")
echo
if [ "$RESULT" = "NO_DATA" ]; then
  echo ">> 一个字节都没录到，下行不通"
  DOWN_OK=n
else
  MEAN=$(echo "$RESULT" | cut -d' ' -f1)
  PEAK=$(echo "$RESULT" | cut -d' ' -f2)
  echo "平均电平：${MEAN} dB   峰值：${PEAK} dB"
  # 纯静音在 -90 dB 以下，有人说话一般在 -40 ~ -15 dB
  if python3 -c "import sys; sys.exit(0 if float('$PEAK') > -50 else 1)"; then
    echo ">> 有声音，下行通了"
    DOWN_OK=y
  else
    echo ">> 基本是静音，下行没通"
    DOWN_OK=n
  fi
fi
echo

echo "=============================================="
echo " 测试 3/3：资源占用"
echo "=============================================="
free -h
echo
ps -C chrome -o rss= 2>/dev/null | awk '{s+=$1} END {printf "Chrome 合计: %.0f MB（含共享内存，实际更低）\n", s/1024}'
ps -C ffmpeg -o rss= 2>/dev/null | awk '{s+=$1} END {printf "ffmpeg 合计: %.0f MB\n", s/1024}'
echo
top -bn2 -d3 | grep -E '^%Cpu' | tail -1
echo

echo "=============================================="
echo "  上行（角色 → 你）：$UP_OK"
echo "  下行（你 → 角色）：$DOWN_OK"
echo "=============================================="
