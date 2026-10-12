#!/usr/bin/env bash
# 重新推头像到虚拟摄像头。换了 avatar.png 之后跑这个，不用挂断通话。
# 用法：bash restart-cam.sh
set -uo pipefail

# 工作目录默认就是脚本所在目录，避免和 $HOME 下的目录搞混
NODE_DIR="${FT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
AVATAR="$NODE_DIR/avatar.png"
RUN_DIR="$NODE_DIR/run"
mkdir -p "$RUN_DIR"

if [ ! -f "$AVATAR" ]; then
  echo "找不到 $AVATAR" >&2
  exit 1
fi

pkill -f 'ffmpeg.*video10' 2>/dev/null || true
sleep 1

W=960
H=540

# 画面怎么填进 16:9：
#   contain（默认）= 整张图都在，上下或左右留黑边，不变形
#   cover          = 裁掉多余部分填满，不变形但会切掉边缘
#   blur           = 留白处用放大模糊的自身填充，最好看，但更费 CPU
case "${FT_FIT:-contain}" in
  cover)
    FIT="scale=$W:$H:force_original_aspect_ratio=increase,crop=$W:$H"
    ;;
  blur)
    FIT="split[bg][fg];[bg]scale=$W:$H:force_original_aspect_ratio=increase,crop=$W:$H,gblur=sigma=20[bgb];[fg]scale=$W:$H:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2"
    ;;
  *)
    FIT="scale=$W:$H:force_original_aspect_ratio=decrease,pad=$W:$H:(ow-iw)/2:(oh-ih)/2:color=black"
    ;;
esac

# -loop 1 才是图片的正确循环方式（-stream_loop 对图片不可靠，推一会儿就停）
# noise 加极轻微的噪点，让每一帧都不同 —— 完全静止的画面会被 WebRTC 判成卡死，
# 接收端就会显示那个三角感叹号
# 540p 足够，比 720p 省三成 CPU
ffmpeg -loglevel warning -nostdin \
  -re -loop 1 -framerate 10 -i "$AVATAR" \
  -vf "$FIT,format=yuv420p,noise=alls=3:allf=t" \
  -r 10 -fps_mode cfr \
  -f v4l2 /dev/video10 >"$RUN_DIR/vcam.log" 2>&1 &

echo $! >"$RUN_DIR/vcam.pid"
sleep 2

if kill -0 "$(cat "$RUN_DIR/vcam.pid")" 2>/dev/null; then
  echo "摄像头已推流（$(basename "$AVATAR") → /dev/video10, ${W}x${H}@10fps, fit=${FT_FIT:-contain}）"
else
  echo "ffmpeg 没起来，看日志：" >&2
  cat "$RUN_DIR/vcam.log" >&2
  exit 1
fi
