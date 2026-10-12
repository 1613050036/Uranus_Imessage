#!/usr/bin/env bash
# FaceTime 通话节点环境搭建（Ubuntu 24.04）
# 装：Chrome（带 H.264）、虚拟摄像头、虚拟声卡、Xvfb、x11vnc
# 用法：sudo bash setup.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行" >&2
  exit 1
fi

REAL_USER="${SUDO_USER:-root}"
HOME_DIR="$(getent passwd "$REAL_USER" | cut -d: -f6)"
NODE_DIR="$HOME_DIR/facetime-node"

echo "==> 1/6 安装基础包"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  wget curl ca-certificates \
  xvfb x11vnc \
  pulseaudio pulseaudio-utils \
  ffmpeg \
  v4l2loopback-dkms v4l2loopback-utils \
  fonts-noto-cjk \
  linux-headers-"$(uname -r)" \
  >/dev/null

echo "==> 2/6 安装 Google Chrome（FaceTime 需要 H.264，开源 Chromium 不行）"
if ! command -v google-chrome >/dev/null 2>&1; then
  wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y -qq /tmp/chrome.deb >/dev/null
  rm -f /tmp/chrome.deb
fi
google-chrome --version

echo "==> 3/6 配置虚拟摄像头（v4l2loopback）"
cat >/etc/modprobe.d/facetime-vcam.conf <<'EOF'
options v4l2loopback devices=1 video_nr=10 card_label="Uranus Camera" exclusive_caps=1
EOF
echo v4l2loopback >/etc/modules-load.d/facetime-vcam.conf
modprobe -r v4l2loopback 2>/dev/null || true
modprobe v4l2loopback devices=1 video_nr=10 card_label="Uranus Camera" exclusive_caps=1
ls -l /dev/video10

echo "==> 4/6 准备工作目录"
mkdir -p "$NODE_DIR"
if [ ! -f "$NODE_DIR/avatar.png" ]; then
  # 没放头像就先生成一张占位图，之后直接覆盖这个文件即可
  ffmpeg -loglevel error -f lavfi -i color=c=0x1c1c1e:s=1280x720 \
    -vf "drawtext=fontfile=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc:text='Uranus':fontcolor=white:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2" \
    -frames:v 1 -y "$NODE_DIR/avatar.png"
fi
chown -R "$REAL_USER":"$REAL_USER" "$NODE_DIR"

echo "==> 5/6 增加 swap（2G 内存必须，防 OOM）"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
free -h

echo "==> 6/6 允许普通用户访问视频设备"
usermod -aG video "$REAL_USER" || true

cat <<EOF

搭建完成。

工作目录：$NODE_DIR
头像文件：$NODE_DIR/avatar.png （换成角色头像就直接覆盖它，1280x720）

下一步：
  bash call.sh '<FaceTime 链接>'

注意：刚加了 video 组，先退出 SSH 重新登录一次再跑。
EOF
