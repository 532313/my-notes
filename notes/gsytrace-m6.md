<!-- notebook: {"version":1,"title":"GsyTrace M6 · 小屏原声回放与进度跳转","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->
# GsyTrace M6 · 小屏原声回放与进度跳转

[![M6 数据流图。RK3576 读取缓存原件并制作短片包，RV1106 以声卡进度驱动画布与小屏播放](assets/gsytrace/m6.png)](assets/gsytrace/m6.png)

[返回应用层导读](#note/notes%2Fgsytrace-overview.md) · [上一章 M5](#note/notes%2Fgsytrace-m5.md) · [下一章 M7](#note/notes%2Fgsytrace-m7.md)

这一阶段让你在 RV1106 的屏上点 Play，看到实验片段，也能听到原声。RK3576 先把原视频和原音频变成小屏容易消费的短片包。RV1106 把包下载完，再播声音、画画面。第一次点开和之后拖动进度条走的是两条不同长度的路径，可以对照第二张图看。

## 先看两块板分别负责什么

| 名称 | 小白可以怎么理解 | 代码落点 |
|---|---|---|
| **RGB565**（Red, Green, Blue，红绿蓝） | 每像素 16 位，分别给红 5 位、绿 6 位、蓝 5 位。160×90 的画面一张占 28,800 字节 | RK 上 FFmpeg 转成 `rgb565le`，RV 上用 LVGL canvas 显示 |
| **PCM**（Pulse-Code Modulation，脉冲编码调制） | 声音变成一排采样数字。16 kHz、单声道、16 位原声，每 100 ms 有 1,600 个样本，占 3,200 字节 | WAV 读出短片所需的样本，RV 写入 ALSA |
| **ALSA**（Advanced Linux Sound Architecture，高级 Linux 声音架构） | 应用通过它给声卡喂样本，也能问已经喂进去的样本还剩多少没播放 | `snd_pcm_writei()` 和 `snd_pcm_delay()` |
| **LCD**（Liquid Crystal Display，液晶显示屏）与 framebuffer | framebuffer 是屏幕像素对应的内存。把像素写对后，还可以读回来独立核对 | LVGL 刷新并逐行回读 `/dev/fb0` |
| **HTTP**（Hypertext Transfer Protocol，超文本传输协议） | 播放器向 RK 请求一段短片。网络传输完毕后可在 RV 内存映射文件里就地取帧 | `GET /clip` |

M6 使用定长记录的 `GSY6` 包。每条记录包含 8 字节源时间、一个画面和对应时段的音频。每 100 ms 一条。8 秒一共 80 条，连同 32 字节头为 2,560,672 字节。小端 `LE`（Little Endian）描述多字节数字的存放顺序，低位字节在前。进度条给出第几条后，播放器能直接计算原始字节的位置。

```text
记录大小 = 8 + 160 × 90 × 2 + 1,600 × 2 = 32,008 字节
某条记录的文件位置 = 32 + 记录下标 × 32,008 字节
```

## 实施顺序和主要接口

### 1. 在 m6/hub.py 做原片缓存和短片打包

`segments()` 从 M3 清单找覆盖目标范围的分片，检查中间无空洞或重叠。`original()` 先检查缓存文件的大小和 SHA-256。已有文件直接用，缺原件就委托 M3 的原件任务，再等状态变成 `ready`。视频和声音走这一条统一的原件校验链路。

`video_slots()` 通过 ffprobe 读每帧 PTS（Presentation Time Stamp，呈现时间戳），给每个 100 ms 时间格找该时刻正在显示的帧。随后由 FFmpeg 选帧、缩放、转换成 160×90 的 RGB565。`audio_bytes()` 用同一来源时间选 WAV 样本，通过 `wave.setpos()` / `readframes()` 切出原声。它用累计采样数约束每段长度，避免跨片舍入一点点累计。

`build()` 写入定长记录并输出 `clip.json`，其中包括每张图的源时间与 RGB 摘要，以及整段 PCM 的摘要。`ClipHandler.do_GET()` 处理 `/clip`，短片制作成功返回 200，原件或构建不可用返回 503。该版本在服务端启动时设定会话和范围，按一个配置好的短片做验收。

### 2. 在 m6/player.c 接显示和原声

`play()` 用 `fork()` 产生子进程，子进程执行 `wget`。`tick()` 通过 `waitpid(..., WNOHANG)` 查询完成状态，界面循环在等待时可以继续处理事件。`load_clip()` 检查包头、版本标记、尺寸参数和文件长度，再用 `mmap()` 映射成可读取的内存。

开始播之后，`feed()` 用 `snd_pcm_writei()` 提交设备能收下的样本，再通过 `snd_pcm_delay()` 读出声卡还排着多少样本。这个数字跟实际播出的进度更接近。画面按听到第几条记录来选，下列是核心换算。

```text
已经播放的样本数 = 已写入样本数 − 声卡中尚未播放的样本数
当前画面下标 = 跳转起点下标 + floor(已播放样本数 / 1,600)
```

`lv_canvas_set_buffer()` 把一个像素缓冲区交给 LVGL 画布。`show()` 写新像素，用 `lv_obj_invalidate()` 标记待刷新，再用 `lv_refr_now()` 刷新。对 framebuffer 各行计算实际偏移时，代码使用驱动提供的行步长 `line_length`。逐行读回与源像素匹配后，才记入一条有效的 `FRAME` 日志。

### 3. 在同一个播放器接进度条

[![M6 跳转时序图。拖动松手触发 LVGL 事件，播放器丢弃旧声卡缓冲并由新记录位置重启声画](assets/gsytrace/m6-seek.png)](assets/gsytrace/m6-seek.png)

进度条在 `LV_EVENT_RELEASED`（松手）调用 `seek()`。这时短片文件已在 RV1106，`lv_slider_get_value()` 取得目标记录下标。`start_at()` 关闭旧音频，`snd_pcm_drop()` 丢弃声卡里还排着的旧样本，随后从新下标开始向声卡供样本并刷画面。整个短片已经转成原始画面，因此跳转就是直接定位一条记录。

## 在 WSL 构建，再用 MobaXterm 上板

在 WSL 的源码根目录执行。提示时输入已为 M0 准备好的 RV SDK（Software Development Kit，软件开发工具包）根目录，以及 LVGL 源码根目录。目标编译器来自 RV1106 工具链，`file` 应显示 ARM 32 位，动态加载器为 uClibc。

```bash
read -r -p 'RV1106 SDK 绝对路径 > ' SDK
read -r -p 'LVGL 源码绝对路径 > ' LVGL_SRC
TC="$SDK/tools/linux/toolchain/arm-rockchip830-linux-uclibcgnueabihf/bin/arm-rockchip830-linux-uclibcgnueabihf"
cmake -S m6 -B build/m6-player \
  -DCMAKE_TOOLCHAIN_FILE="$PWD/cmake/rv1106-toolchain.cmake" \
  -DGSY_PROJECT="$PWD" -DGSY_SDK_ROOT="$SDK" -DGSY_LVGL_ROOT="$LVGL_SRC" \
  -DCMAKE_C_COMPILER="$TC-gcc" -DCMAKE_CXX_COMPILER="$TC-g++" \
  -DCMAKE_ASM_COMPILER="$TC-gcc"
cmake --build build/m6-player --target m6-player
file build/m6-player/m6-player
"$TC-readelf" -l build/m6-player/m6-player | grep interpreter
tar -czf m6-hub-src.tar.gz m6/hub.py m6/lab.sh
```

MobaXterm SFTP 把短片服务源码包上传到 RK3576，把 `build/m6-player/m6-player` 上传到 RV1106 的练习目录。RK 上保留 M4 缓存与 M3 运行环境。下面的变量分别指向 M3 源码目录、M4 验收数据目录、含 `sources.py` 的 M4 源码目录、可运行 M3 的 Python、本次 Hub 的实际局域网地址和会话标识。

```bash
tar -xzf m6-hub-src.tar.gz
read -r -p '有 hub.py 与 original_receiver.py 的 M3 目录 > ' M3
read -r -p '有 hub.sqlite3 和 cache 的验收数据目录 > ' M4
read -r -p '有 sources.py 的 M4 源码目录 > ' READER
read -r -p 'M3 使用的 Python 绝对路径 > ' P
read -r -p 'RK3576 实际局域网 IPv4 地址 > ' HOST
read -r -p '覆盖录制开始后 22 到 30 秒的会话标识 > ' SID
M3="$M3" M4="$M4" READER="$READER" P="$P" HOST="$HOST" SID="$SID" bash m6/lab.sh
```

程序应显示 `READY warm=18778 cold=18779 originals=18769`。冷缓存和热缓存使用同一会话的清单。热缓存用已经下载的原件，冷缓存用实验新建的独立目录。保持 RK 这个窗口运行，在 RV1106 的 MobaXterm 标签页先确认屏幕空闲，再执行以下命令。

```bash
chmod +x ./m6-player
printf 'RK3576 实际局域网 IPv4 地址 > '
read -r HUB_IP
./m6-player "$HUB_IP" 18778 bench
```

`bench` 会自动播放、重复播放并跳一次。对于选定的 8 秒，看到 `RESULTS ... exit=0` 后打开该目录的 `play.log`，应有 `shown=80 expected=80` 和 `samples=128000`。省略 `bench` 后可以在屏上点播放和拖进度条。

测冷缓存时，在另一个 RV1106 标签页先启动 M3 原件发送端。按提示填入当前二进制与 SD 会话根目录，再填自己 RK 的局域网地址。

```bash
printf '已通过 M3 验收的 m3-originals 路径 > '
read -r ORIGINALS
printf 'SD 卡上的会话根目录 > '
read -r SESSION_ROOT
printf 'RK3576 实际局域网 IPv4 地址 > '
read -r HUB_IP
"$ORIGINALS" "ws://$HUB_IP:18769/originals" rv1106-01 "$SESSION_ROOT"
```

然后在播放器标签页切到冷缓存端口。RK 的 `cold/m3.log` 应先看到 `ORIGINAL_REQUEST`，再看到对应的 `ORIGINAL_READY`。同一冷目录上的第二次请求已具有缓存。要重复测冷启动，在新实验目录重新运行 `lab.sh`。

```bash
./m6-player "$HUB_IP" 18779 bench
```

最后保存各场景的 `play.log`、`first.rgb`、`seek.rgb`、Hub 的 `clip.json` 和冷缓存原件日志。额外验证扬声器真实发声时，M6 支持 `bench mic`，会用板载麦克风留一份验证录音。获得现场同意后再使用，需要时把证据留在本地。WSL 的 `m6/verify.py` 能对比原片解码、源时间、显示快照和 PCM。它需要 NumPy、SciPy、FFmpeg 与 ffprobe，入口为 `python3 m6/verify.py <验收目录> <源会话目录>`。

## 实板验收读数和排查顺序

| 同一段 8 秒实板样本 | 观测 |
|---|---|
| 首次播放，RK 已缓存原件 | 约 7.917 秒见首帧，80/80 帧，约 9.998 fps |
| 首次播放，RK 空缓存并经 M3 取回原件 | 约 20.879 秒见首帧，80/80 帧，约 10.002 fps |
| 小屏上人工拖动两次 | 松手到新画面分别约 47.40 和 51.35 ms，日志有对应来源时间 |
| 独立复验 | 80 帧源时间与 RGB 摘要一致，128,000 个 PCM 样本与原 WAV 一致，麦克风回录能匹配不同位置的原声 |

这里的 **fps**（frames per second，每秒帧数）是播放器有效刷新并回读 framebuffer 后计算的。约 15 ms 的最大音画差来自这次完整播放中，刷新时读取的 ALSA 播放位置与帧源时间之差。声学回录用来核对扬声器确实播放了原内容。每个缓存场景是一轮验收样本，实际耗时会受板卡、片段和网络影响。

- **首帧比预期慢**。先看 Hub 是否在等原件，再看 FFmpeg 处理和 HTTP 传输。本版等待整段下载，RK 热缓存只能免掉原件回传。首次等待与短片已在 RV 后的跳转耗时差距很合理。
- **画面有了，声音没听到**。先核对 Hub 导出的 PCM 摘要、RV 声卡的 ALSA 日志与样本数，再核对板端出声设备。必要时对三段声音做回录相关性比对。
- **画面显示了，无法证明拖动到了正确位置**。保存拖动后首帧，从原 MP4 按相同时间独立选帧，比较 RGB565 摘要。检查源时间的会话起点和分片起点是否一致。

## 常见面试问法

### 1. 为什么用声音推进画面？

**口语答法**　样本实际出声由声卡节奏决定。写进去多少只说明排进去了多少，我减去还在缓冲的样本，再根据听到哪一段选画面。

**追问**　定时函数醒得不准会发生什么？

**答法**　下一次醒来重新按声卡样本位置选帧，避免每轮用固定睡眠累积偏差。循环忙到跨过记录时，可能少刷新中间画面，所以验收需要看实际刷新次数。

### 2. 热缓存为什么还要等几秒，拖动为何是几十毫秒？

**口语答法**　热缓存里的东西是原始 MP4 和 WAV。Hub 仍要制作短片，播放器仍要下载完整包。拖动时包已在 RV 上，计算新记录位置就能开始。

**追问**　要改善首帧时间，可以从哪下手？

**答法**　先分段记录取原件、转码和下载时间。可以预生成或缓存成品。若改成边下边播，还要补齐分段缓冲、断网和跳转策略并重新做验收。

### 3. 怎么证明画面真刷新、原声真播放？

**口语答法**　用 framebuffer 回读比较画面，再独立从 MP4 解一次确认来源。每个音频样本能和 WAV 对比，另外现场回录能证明扬声器出声。

**追问**　回读帧率反映 LCD 的哪一部分？

**答法**　这里读数来自应用成功更新并回读的帧数和时间。面板的扫描频率或人眼实际看到的新画面时间需要单独的测量方法。
