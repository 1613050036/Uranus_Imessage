# FaceTime 通话节点

让一台 Ubuntu VPS 作为 FaceTime 网页版的入会节点，给 Uranus 的角色当「电话那头」。

实测机器：阿里云马来西亚 2h2g Ubuntu 24.04

## 验证结论（2026-10-11，全部通过）

| 项目 | 结果 |
|---|---|
| Linux 上的 Chrome 能入会 | ✅ 伪装成 Windows UA，官方名单里没有 Linux 但能用 |
| 地区封锁 | ✅ 马来西亚直连，不用代理 |
| 收对方画面和声音 | ✅ 能到高清 |
| 虚拟麦克风送出声音 | ✅ 要用 `module-remap-source`，直接给 monitor 不认 |
| 虚拟摄像头送出画面 | ✅ 要加噪点，纯静止帧会被判成卡死 |
| 内存 | ✅ 峰值 1.0G / 1.6G，swap 没动 |
| CPU | ✅ 约 26%，两核有余量 |
| FaceTime 自身延迟 | 1～2 秒 |

踩过的坑都已经写进脚本，不用再试一遍。

## 步骤

### 1. 搭环境

```bash
sudo bash setup.sh
```

装 Chrome（必须是官方版，开源 Chromium 没有 H.264，FaceTime 用不了）、v4l2loopback 虚拟摄像头、PulseAudio 虚拟声卡、Xvfb、x11vnc，顺带加 2G swap。

装完**退出 SSH 重新登录**（加了 video 组要重新登录才生效）。

### 2. 放角色头像

覆盖脚本目录下的 `avatar.png`，不放的话会用一张写着 Uranus 的占位图。

通话中换头像不用挂断：

```bash
bash restart-cam.sh              # contain：整张图都在，留黑边（默认）
FT_FIT=cover bash restart-cam.sh # 裁掉多余部分填满
FT_FIT=blur  bash restart-cam.sh # 空白处用模糊的自身填充，最好看但费 CPU
```

换完要在通话界面里把摄像头**关一下再开**，让 Chrome 重新抓设备 —— ffmpeg 一重启，Chrome 原来那条视频轨就断了，对方会看到三角感叹号。

### 3. 发起通话

iPhone 的 FaceTime → 创建链接 → 把链接发到 VPS 上：

```bash
bash call.sh 'https://facetime.apple.com/join#v=1&p=...&k=...'
```

### 4. 连 VNC 点「加入」

在自己电脑上开隧道：

```bash
ssh -N -L 5900:127.0.0.1:5900 <用户名>@<VPS的IP>
```

VNC 客户端连 `127.0.0.1:5900`，在画面里点「加入」，然后在 iPhone 上允许。

### 5. 验音频

接通后另开一个 SSH 窗口：

```bash
bash check-audio.sh
```

会依次测上行（角色 → 你）、下行（你 → 角色），最后打印内存和 CPU。

### 6. 收工

```bash
bash stop.sh
```

## 音频是怎么接的

```
角色 TTS ──放音──> vmic (null sink)
                      │
                      └── vmic.monitor ──当麦克风──> Chrome ──> FaceTime ──> 你的 iPhone

你的 iPhone ──> FaceTime ──> Chrome ──放音──> vspk (null sink)
                                                  │
                                                  └── vspk.monitor ──录音──> STT ──> 角色
```

两条路各走各的 sink，不会像 Windows 上那样绕成一个环产生回声。

## 已知限制

- **共享屏幕用不了**。苹果明确写了网页参与者不支持 SharePlay 和屏幕共享，协议层面就不通，没有变通办法
- **角色没法主动打给你**。网页端发不起 FaceTime 呼叫，只能你建链接、角色入会
- **国行 iPhone 的 FaceTime 没有纯语音模式**，摄像头关不掉，划到后台可以让画面暂停

## 排查

**Chrome 起不来 / 画面全黑**
看 `~/facetime-node/run/chrome.log`，大概率是 Xvfb 没起来或者 DISPLAY 没对上。

**FaceTime 说浏览器不支持**
Linux 不在官方名单里。在 `call.sh` 的 Chrome 参数里加一行伪装成 Windows：

```
--user-agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
```

**看不到摄像头设备**
```bash
ls -l /dev/video10
v4l2-ctl --list-devices
sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="Uranus Camera" exclusive_caps=1
```

**没声音**
```bash
pactl list short sinks     # 应该有 vmic 和 vspk
pactl list short sources   # 应该有 vmic.monitor 和 vspk.monitor
pactl info | grep Default
```
