<!-- notebook: {"version":1,"title":"GsyTrace 应用层总览 · 从一段录像读懂 M0–M7","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->

# GsyTrace 应用层总览 · 从一段录像读懂 M0–M7

设想你要记录一次小实验。对着摄像头做一个动作，顺口说出操作和观察。录完后想核对自己当时说了什么，也想点进度条跳回某一刻。GsyTrace 把这些事分给两块开发板，录像留在现场，清单和需要的原片可以交给另一块板处理。

[![GsyTrace 双板架构图。RV1106 采集并写 SD 卡，RK3576 接收清单、按需取原片，处理语音复盘、图注和小屏短片](assets/gsytrace/overview.png)](assets/gsytrace/overview.png)

图可以点开看大图。读图时追三样东西就够了。第一是**媒体**，即摄像头拍到的画面和麦克风收到的声音。第二是**清单**，写着每个文件的名字、起止时间、大小和摘要。第三是**控制消息**，例如「开始录制」「这个清单已经保存」「请把这段原片发过来」。把它们分清，后面的代码会好找很多。

## 两块板各负责什么

**RV1106 在现场。** 它通过 Rockchip 媒体接口取编码后的画面，通过 ALSA 取音频样本。录制程序让两路并行工作，把视频写进 MP4、声音写进 WAV，并把每个分片登记在 SD 卡（Secure Digital card）上的会话目录。小屏既能控制录制，也能打开回放。即使与 Hub 暂时失联，已经开始的录制仍可在本机收尾。

**RK3576 是 Hub。** Hub 可以理解为接收和处理数据的一端。它收到清单后写入 SQLite，需要用哪段时再向 RV1106 请求哪份 MP4 或 WAV。它用 SenseVoice 把口述转成文字，用图注工具给选定的画面生成一句描述，也能把短片处理成 RV1106 小屏可以显示和播放的格式。发布版由两项 systemd 服务常驻提供同步和短片接口，口述处理与图注由已配置的工具按需运行。

**WSL 和 MobaXterm 把开发电脑和板端连起来。** 在 Windows 打开 WSL（Windows Subsystem for Linux，适用于 Linux 的 Windows 子系统）编译。MobaXterm 通过 SSH（Secure Shell，安全远程终端）打开板端命令行，通过 SFTP（SSH File Transfer Protocol，SSH 文件传输协议）上传产物、下载验证记录。读到「在板上执行」时，先确认当前标签页对应哪块板。

### 先认识目录里最常出现的三样东西

| 内容 | 它回答的问题 | 本项目的例子 |
|---|---|---|
| 会话 | 这是哪一次从开始到结束的录制？ | 一次启动录制对应一个会话目录，`session.json` 记会话状态及时间。 |
| 分片 | 我要找动作发生时的原始声音或画面，该打开哪份文件？ | `segments.jsonl` 一行一条分片记录，文件名类似 `video-000002.mp4`、`audio-000002.wav`。 |
| 摘要 | 取回的文件是否与清单描述的那份一致？ | SHA-256（Secure Hash Algorithm 256-bit）基于文件内容算出 256 位摘要，复核时还要对照长度。 |

`JSON` 是 JavaScript Object Notation，一种可供程序和人阅读的数据格式。`JSONL` 是 JSON Lines，每行放一条独立的 JSON 记录。打开清单时可以先读懂一行，再看程序怎样一行一行处理。

## 从最小程序走到双板发布

[![M0 到 M7 验收路线。由独立上板、单路采集、两路录制、同步、复盘、图注、回放走到发布回滚](assets/gsytrace/roadmap.png)](assets/gsytrace/roadmap.png)

| 从哪篇开始 | 这一关过关时，手上应该有什么 |
|---|---|
| [M0 · 从 hello-rv 到上板运行](#note/notes%2Fgsytrace-m0.md) | RV1106 终端实际打印出 `hello-rv`。能从产物里读出架构和动态链接器。 |
| [M1 · 摄像头和麦克风分别采集](#note/notes%2Fgsytrace-m1.md) | 一份可解码的 H.264 和一份能听到原声的 WAV。两路分别能测，再给 M2 组合。 |
| [M2 · 双路录制、分片与触摸控制](#note/notes%2Fgsytrace-m2.md) | 定时停或手动停都能排空队列。各分片有独立可用的媒体文件，清单可用摘要复核。 |
| [M3 · 双板同步和原片断点续传](#note/notes%2Fgsytrace-m3.md) | 恢复连接后能补交同一会话。Hub 重启和重复提交后，清单仍能查询，断开的文件能从偏移继续。 |
| [M4 · 离线语音复盘](#note/notes%2Fgsytrace-m4.md) | 三次尝试的复盘可保存校正并离线回听。只口述操作的那次，观察字段显示「未记录」。 |
| [M5 · NPU 图注与原片溯源](#note/notes%2Fgsytrace-m5.md) | 控制图能跑通推理，三个真实样本的帧可回查。图注误判和人工结论也有记录。 |
| [M6 · 小屏原声回放与跳转](#note/notes%2Fgsytrace-m6.md) | 有原片缓存和临时取片两种情况下都能回放。拖动之后能找到对应的原片画面。 |
| [M7 · 交付、安装和回滚](#note/notes%2Fgsytrace-m7.md) | 从干净检出构建的双板包摘要一致。在实板回滚再恢复后能打开同一段回放。 |

不熟悉 Linux 时从 M0 一路读下来。如果已经能交叉编译，可以先从感兴趣的一篇切入。想补项目面试，先看本页两张图，然后打开那一阶段的「常见面试问法」和「验收」。回答时能讲出一个函数、一条日志和一次复测，比复述一串缩写更容易让对方跟上。

## 容易混淆的几组词

| 常见词 | 用一句话记住 |
|---|---|
| API（Application Programming Interface，应用程序接口） | 函数、命令或网络入口约定好了怎么用。看到 `RK_MPI_VENC_GetStream()`，可以问它在哪一层、接收什么、谁负责释放拿到的数据。 |
| SDK（Software Development Kit，软件开发工具包）与 BSP（Board Support Package，板级支持包） | SDK 为写程序提供头文件、库和工具链。BSP 为操作系统在特定板子上运行提供板级支持。设备树和驱动是下层，录制程序通过板子提供的接口工作。 |
| ISP（Image Signal Processor，图像信号处理器）、VI（Video Input，视频输入）、VENC（Video Encoder，视频编码器） | 先处理摄像头得到的图像，再把画面交给编码器压缩。Linux 的 V4L2（Video for Linux 2）为下层视频设备提供接口，本项目的采集应用调用 Rockchip MPI（Media Processing Interface）。 |
| ALSA（Advanced Linux Sound Architecture，高级 Linux 声音架构）、PCM（Pulse-Code Modulation，脉冲编码调制） | ALSA 提供打开设备、读写声音等接口。PCM 是把声音采成一串数值的方法。 |
| H.264、MP4（MPEG-4 Part 14）、WAV（Waveform Audio File Format） | H.264 规定怎样编码视频，MP4 和 WAV 是容器。容器可以带时间、格式或索引等信息，播放器靠这些信息知道怎样读里面的数据。 |
| PTS（Presentation Time Stamp，显示时间戳）、单调时钟 | PTS 说明这一帧该在什么时候出现。单调时钟适合计算一次开机期间经过了多久，核对跨设备或跨重启的数据时还得带会话和启动标识。 |
| ASR（Automatic Speech Recognition，自动语音识别）、VAD（Voice Activity Detection，语音活动检测）、NPU（Neural Processing Unit，神经网络处理单元） | VAD 找出哪里有人声，ASR 把人声转成字。NPU 是加速神经网络计算的处理单元，项目用它跑图注模型。 |
| RGB565、LVGL（Light and Versatile Graphics Library，轻量图形库） | RGB 指 Red、Green、Blue。每个 RGB565 像素用 16 位装颜色，红 5 位、绿 6 位、蓝 5 位。LVGL 把画面、按钮和进度条组织成可触摸的界面。 |

## 源码和实测口径

正文以 GsyTrace **`v1.0.0`（`abb9fb8`）** 的应用层源码为参照，文件路径从项目根目录开始。历史里程碑有各自的编译产物和验收记录，所以早期命令、构建开关和数字都放回对应阶段讲。图中的媒体内容和部分时间点是示意，实测值会在各篇验收段落中注明。

几个容易记错的结论也可以从目录直接回查。M5 的原帧对得上，图注语义仍需要人工核对。M6 的约 10 帧每秒来自显示缓冲区的更新记录，首播包含整段短片下载时间。M7 验证的是应用版本切换和服务重启，整板断电重启没有记录在这次验收里。

[从 M0 开始，在 RV1106 上跑出第一行输出 →](#note/notes%2Fgsytrace-m0.md)
