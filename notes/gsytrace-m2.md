<!-- notebook: {"version":1,"title":"GsyTrace M2 · 并发录制、分段存储与小屏控制","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->
# GsyTrace M2 · 并发录制、分段存储与小屏控制

[![M2 录制架构图。摄像头和声卡各有采集线程、队列和写盘线程，SD 上分别保存 MP4、WAV 和清单。](assets/gsytrace/m2.png)](assets/gsytrace/m2.png)

[项目总览](#note/notes%2Fgsytrace-overview.md) · [上一篇 M1](#note/notes%2Fgsytrace-m1.md) · [下一篇 M3](#note/notes%2Fgsytrace-m3.md)

## 从两个探针变成一次录制

M1 的两个小程序各自启动、结束、产出一个文件。M2 增加了三个约定。第一，按一次开始就产生一个录制会话，声音和画面都进入它。第二，写盘速度有波动，采集与写盘之间有边界清楚的缓冲。第三，程序关闭后留下足够的文件和时间信息，下个阶段可以读明白发生了什么。

实际产物是 **每个会话里同时保存一组纯视频 MP4 和一组 PCM WAV**。 `session.json` 记会话状态、开始结束时间及启动标识。 `segments.jsonl` 每行描述一个片段的轨道、编号、文件名、起止时间、字节数和摘要。 **JSON（JavaScript Object Notation，JavaScript 对象表示法）**便于程序与人共读。 **JSONL（JSON Lines，逐行 JSON）**让程序按行追加和检查。 **SD（Secure Digital，安全数字存储卡）**提供录制的持久化空间。

## 第一步 · 主线程协调声音和视频

看 `m2/recorder.c`、`m2/video_capture.c` 与 `m2/audio_capture.c`。把 M1 验证过的媒体流程做成 `video_capture_run()` 和 `audio_capture_run()`，由录制程序协调。两路各自初始化设备，报告就绪。主线程看到两路都准备好才记录开始时刻、打开开始门闩并计算截止时间。代码使用 `pthread_create()` 和 `pthread_join()` 创建和收回线程。 **POSIX（Portable Operating System Interface，可移植操作系统接口）**规定了这类线程接口的一部分，Pthreads 是 POSIX Threads。

| 关键函数或常量 | 在项目里的动作 |
|---|---|
| `recorder_wait_start()`、`atomic_fetch_add()` | 采集线程报告就绪，然后等待统一启动标志 |
| `clock_gettime(CLOCK_MONOTONIC, ...)` | 读单调时钟，作为录制期限和采集时间的基础 |
| `pthread_sigmask()`、`sigtimedwait()` | 主线程在可控的等待循环处理 `SIGINT` 和 `SIGTERM` |
| `atomic_store()`、`pthread_join()` | 发布停止状态，等待采集及写盘工作收尾 |

**CLI（Command-Line Interface，命令行接口）**里的 Ctrl+C 通常向前台进程送 `SIGINT`（Interrupt signal，中断信号）。独立运行时，定时结束和收到停止信号都走收尾流程。正常结束后，采集线程关闭队列并等写盘线程排空，再由主线程结束会话。连续数据发生错误时，会话可标为 `interrupted`，便于下一阶段跳过不完整结果。

## 第二步 · 先拿一份自己的数据，再交给写盘线程

看 `m2/video_queue.c`、`m2/video_capture.c` 与 `m2/audio_capture.c`。视频数据来自 **VENC（Video Encoder，视频编码器）**内存池。生产线程先把编码包和时间戳拷到应用的内存，再调用 `RK_MPI_VENC_ReleaseStream()` 归还编码器的内存，之后写盘线程才使用副本。

```text
GetStream 成功 → 检查长度 → malloc + memcpy → ReleaseStream
             → video_queue_try_push → 写线程 video_queue_pop
             → mp4_segmenter_packet → 释放应用的副本
```

队列采用 **FIFO（First In, First Out，先进先出）**。每个包大小不同，故同时限制为 **64 包和 4 MiB**。 **MiB（mebibyte，2 的 20 次方字节）**便于写清内存限额。音频队列另设 50 个槽，每块最多 640 个单通道样本，按每秒 16,000 样本折算一块最多约 40 毫秒。生产者推新数据，消费者按顺序取。互斥锁让 `head`、`count` 等共享状态一次只由一个线程改，条件变量让空队列上的消费者休眠并在有数据或关闭时醒来。

`video_queue_close()` 后不会再收新包，已经进来的包仍按 FIFO 排空。采集线程发现队列满会报告错误并结束该次会话，避免静默丢一批可能被后续 H.264 画面引用的帧。 `video_queue_test.c` 可先验证满队列、关闭和顺序等边界。真实板子的 SD 写入是另一项验收。

## 第三步 · 把音视频放在同一条时间线

[![M2 单调时间轴图。视频 PTS 与音频首采样时刻接到同一个会话时间线，音频后续按样本数递进。](assets/gsytrace/m2-time.png)](assets/gsytrace/m2-time.png)

对齐的起点是 **单调时钟**。系统修改墙上时间时，单调时钟通常持续向前。系统重启会建立新的时间基准，因此清单保存 `boot_id`（boot identifier，系统启动标识）。在同一个启动内，用片段起点减会话起点，就能得到“录制开始后的第几秒”。

- 视频读取 `pack.u64PTS`。 **PTS（Presentation Time Stamp，呈现时间戳）**说明一帧适合在哪个时刻展示。代码检查首个硬件 PTS 与单调时钟的接近程度。明显不同源时，以首包到达时刻为基准，保留后续 PTS 的差值。
- 音频用 ALSA 的 `snd_pcm_sw_params_set_tstamp_type()` 选择单调时间，再通过 `snd_pcm_status_get_htstamp()` 和缓冲区里还排着的样本数估算首样本位置。后续用累计样本数 ÷ 16,000 推进。有问题时以单调时钟的读取时刻估算并记录采用的方式。
- 两种分片边界自然会错开。视频等关键帧，WAV 按样本数切。要找同一时刻的证据，按两个轨道的实际时间范围选片。

实板做过八次拍手对照。声音用暂态峰定位，画面在手还分开与第一张明确接触的帧之间取区间。该组八个区间的合并边界约为 −19.9 至 +78.6 毫秒。这描述了当时人工可定位的范围，分辨率受帧周期、拍摄情况和标注方式影响。

## 第四步 · 关键帧切视频，固定采样数切音频

看 `m2/mp4_segmenter.c` 和 `m2/wav_segmenter.c`。MP4 是 MPEG-4 Part 14 容器，**MPEG（Moving Picture Experts Group，动态图像专家组）**制定了一系列视音频标准。M1 已经有 H.264 编码数据，只需把它包装成可独立播放的 MP4。

| 名称 | 英文全称 | 初学时记住什么 |
|---|---|---|
| NAL | Network Abstraction Layer | 码流里的基本单元，可装画面或参数 |
| SPS | Sequence Parameter Set | 包含解码整段序列所需的参数 |
| PPS | Picture Parameter Set | 包含解码图片所需的参数 |
| IDR | Instantaneous Decoding Refresh | 给解码器一个可重新开始的位置，后续画面不会引用它之前的图像 |
| AVC | Advanced Video Coding | 也就是 H.264 |
| WAV | Waveform Audio File Format | 这里每段文件都带自己的 WAV 头及 PCM 数据 |

`mp4_segmenter_packet()` 扫描 H.264 Annex B 的起始码，缓存 SPS/PPS，等待 IDR 后开写。它将画面单元换成容器需要的长度前缀，达到约 10 秒后在下一个 IDR 切片，前一片以该时间为边界，后一片携带足够的解码参数。minimp4 负责容器，主要调用是 `MP4E_open()`、`MP4E_add_track()`、`MP4E_set_sps()`、`MP4E_set_pps()`、`MP4E_put_sample()` 和 `MP4E_close()`。视频轨时间尺度是每秒 90,000 个计数单位。

`wav_segmenter_write()` 每累计 160,000 个样本生成一段，即 10 秒。最后一段可能不足 10 秒，完成时用实际样本数重写 WAV 头。正常的末段大小和播放时长因此能对上。

看 `m2/session_store.c` 的 `session_store_submit()` 与 `session_store_finish()`。片段先写到 `.part`。收尾写好 `.pending` 记录，`renameat()` 把已封装的片段换成正式文件名并同步目录。在后台算 SHA-256、追加清单、同步写入，再处理待办记录。这个流程为中断恢复提供依据。有遗留记录时会按保存的元数据检查能否恢复。会话在音视频、摘要和清单都成功收尾时才写成 `complete`。 `fsync()` 请求将相关写入同步到存储设备，断电恢复仍受介质、文件系统和中断时机影响。

## 第五步 · 用一个本机接口同时服务命令行和 LVGL

[![M2 录制状态机图。空闲接受开始请求，两路就绪后进入录制，结束请求或定时触发排空，回到空闲。](assets/gsytrace/m2-state.png)](assets/gsytrace/m2-state.png)

`m2-recorder serve` 在 `/tmp/gsytrace-m2/rec.sock` 提供 **Unix domain socket（Unix 域套接字）**。这个路径就像给同一块板上的其他进程留了个入口。 `m2-ctl` 和小屏用同一套 JSON 请求 `start`、`stop`、`status`。 `control_serve()` 接受请求并管理录制子进程。客户端拿到 `STARTING` 表示命令已接收，要等到 `RECORDING` 才有两路正在录的证据。 `STOPPING` 对应排空和落盘，回到 `IDLE` 后再结合 `last_session_id`、`error` 与会话状态判断成功。

`m2/ui/platform.c` 把 **LVGL（Light and Versatile Graphics Library，轻量且通用的图形库）**接到 `/dev/fb0` 与触摸输入。 **Framebuffer（帧缓冲设备）**暴露显示像素。**evdev（event device，事件设备接口）**将触摸数据交给应用。录制 UI 的主线程运行 `lv_timer_handler()`、刷新控件和提交动作，`m2/ui/recorder_client.c` 的工作线程请求套接字以及轮询状态。短时间持锁读写状态快照，网络式等待留在工作线程，屏幕能继续处理点击与重绘。

## 第六步 · 编译并用 MobaXterm 上板验收

在 WSL 项目根目录，沿用 M0 的 `SDK` 与 `TC`。 `LVGL_DIR` 指向本项目固定版本的 LVGL 源码目录。发布版本在 M7 固定构建依赖的版本和摘要。

```sh
LVGL_DIR=/path/to/lvgl
cmake -S . -B build/m2-rv1106 \
  -DCMAKE_TOOLCHAIN_FILE="$PWD/cmake/rv1106-toolchain.cmake" \
  -DCMAKE_C_COMPILER="$TC-gcc" -DCMAKE_CXX_COMPILER="$TC-g++" \
  -DCMAKE_ASM_COMPILER="$TC-gcc" -DGSY_SDK_ROOT="$SDK" \
  -DGSY_LVGL_ROOT="$LVGL_DIR" -DGSY_BUILD_M2_UI=ON
cmake --build build/m2-rv1106 --target m2-recorder m2-ctl m2-ui m2-video-queue-test
wslpath -w "$PWD/build/m2-rv1106"
```

从 MobaXterm 上传四个程序到 RV1106 的试验目录。用板上 `mount` 和 `df -h` 确认 SD 已挂载并有空间。先单独做队列测试，再用 30 秒自动停止和 Ctrl+C 各录一次。若应用已由 M7 启动，可以先用正式脚本检查是否空闲并停止，给试验进程腾出采集设备和屏幕。

```sh
chmod +x m2-video-queue-test m2-recorder m2-ctl m2-ui
./m2-video-queue-test
./m2-recorder record --seconds 30 --mic 0
# 上一条退出后再做第二次。在正在录制时按 Ctrl+C。
./m2-recorder record --seconds 60 --mic 0
```

记下每次的 `session_dir`，通过 MobaXterm 下载会话目录。在 WSL 进入下载结果所在目录，用变量指向一份具体会话，检查退出记录、文件数量、摘要和独立可解码性。下面的解码命令适合配置好了 FFmpeg 的 WSL。

```sh
SESSION=./downloaded-session
cat "$SESSION/session.json"
cat "$SESSION/segments.jsonl"
for media in "$SESSION"/*.mp4 "$SESSION"/*.wav; do
    sha256sum "$media"
    ffmpeg -v error -xerror -i "$media" -f null - || break
done
ffprobe -v error -select_streams v:0 -read_intervals '%+#1' \
  -show_entries packet=flags "$SESSION/video-000000.mp4"
```

首视频包的 `flags` 应含 `K`，代表工具识别到关键包。继续对每个 MP4 检查首包，核对清单中的 SHA-256 与这里的计算结果。实际 30 秒验收视频入队与写盘均为 901，音频采集与写盘均为 478,720 个样本，得到 3 个 MP4 和 3 个 WAV。Ctrl+C 一次得到 2 个 MP4 和 2 个 WAV。两种情况都通过状态、时间、字节数、摘要和独立解码检查。软件与设备启动有时差，视频会等关键帧，最后一段音频按实际样本收尾，文件时长会略有差异。

最后再做本机控制和小屏。一个 SSH 标签用 `./m2-recorder serve` 运行服务，另一个标签用下方命令测试状态，然后启动 UI。在开始和结束之间留几秒，结束后等到再次空闲。

```sh
./m2-ctl status
./m2-ctl start --seconds 60 --mic 0
./m2-ctl status
# 录几秒后，执行下一行
./m2-ctl stop
./m2-ctl status
# 状态回 IDLE 后启动小屏，实点开始与结束
./m2-ui
```

一次小屏验收中，日志给出 240/240 视频包、126,080/126,080 音频样本。SD 上一段 MP4 和一段 WAV 单独解码并通过摘要核对。源码可回看 `df1e187`、`e41dcfd`、`c66a071`。

## 开发中碰到的坑

- **触摸测试工具有输入，小屏按钮却难点中。** 将触摸设备的原始轴、配置里的屏幕坐标、物理旋转和 LVGL 控件命中逐层核对。FocalTech 的 `fts_ts` 报出的轴范围大于实际面板标定范围，显示是 320×240，面板映射要旋转 270°。代码用 `EVIOCGNAME` 识别设备，用 `lv_evdev_set_swap_axes()` 交换轴，再用 `lv_evdev_set_calibration()` 按板级坐标校正。先测四角，再点真实录制按钮。
- **返回 STARTING，随后又变成空闲。** 看状态中的 `error` 与会话日志。历史一次是 RKAIQ 枚举传感器返回错误。若重启后连套接字都打不开，先确认 `m2-recorder serve` 是否在运行，再分别检查传感器、声卡和挂载点。
- **写盘慢或者拔卡。** 查标准错误、挂载与空间，观察队列计数，保存已完成片段和会话状态。设计上队列的上限能约束内存，启动与写入也会检查 SD 挂载和预留空间。
- **停止后少了末尾。** 先查是按正常停止流程，还是直接杀掉了进程。正常路径停止生产、关闭并排空队列、封装末段、等待摘要，最后才完成会话。可以比较 `captured/written` 和 `enqueued/written`，再用 ffmpeg 解码末段。

## 常见面试问法

### 为什么队列既限制包数又限制字节数？

**可以这样答。** H.264 一包有大有小，只限制包数可能被少量大包占满内存，只限制字节容易遇到很多小包的管理开销。这里是 64 包和 4 MiB 两个上限。生产线程只把自己拥有的拷贝交给队列，消费线程写完后释放。

**追问。队列满为什么要报错？** 这条链路保存后续分析证据，静默丢包会留下不知道少了哪些数据的文件。H.264 有帧间参考，丢一帧还可能让后续片段受影响。明确中断并保存已封口部分，故障能定位。

### 怎么保证视频每个文件能单独解码？

**可以这样答。** 分片首帧选 IDR，并将解码器需要的 SPS/PPS 写进每个 MP4 的轨道配置。片段有自己的容器信息和时间，封口后可以逐个从头解码。压缩使用硬件编码，M2 的步骤是封装。

**追问。能精确切成每片 10 秒吗？** 视频按目标时间再等待合适的 IDR，实际长度随 GOP 边界变化。WAV 以采样数切，完整片段可恰好是 10 秒。

### 有画面也有声音，怎样证明它们对得上？

**可以这样答。** 我用同一启动内的单调时间轴表示两路时间。视频有 PTS，音频用首样本的估算时刻加样本计数。验收时看拍手波形与相邻视频帧，用一段区间表达实际能定位到的精度。

**追问。为什么不用电脑显示的当前时间？** 当前时间会被校时调整，还可能跨设备和重启。录像链路关心同一启动内的先后和时差。保存 `boot_id` 和相对时间更容易验证。

[回到项目总览](#note/notes%2Fgsytrace-overview.md) · [继续 M3](#note/notes%2Fgsytrace-m3.md)
