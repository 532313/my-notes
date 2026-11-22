<!-- notebook: {"version":1,"title":"GsyTrace 应用层总览 · 从一段录像读懂 M0–M7","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T15:25:04Z","favorite":false,"trashed":false,"source":null} -->

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

## 从采集、控制到上报如何设计

[![GsyTrace 单次录制架构图。小屏通过本机套接字控制录制，声画经有界队列写入 SD，完成后上报清单，Hub 提交数据库后回执](assets/gsytrace/capture-control-report.png)](assets/gsytrace/capture-control-report.png)

沿着一次录制看，先有**控制命令**，接着有**音视频数据**，收尾后才有**会话上报**。图里的 SD 卡也是两段流程的交接点。录制程序在这里交出一份已经收尾的目录，上报程序再从这里读清单。

### 1. 点「开始」以后，谁真的开始录？

在 `m2/ui/main.c`，`lv_obj_add_event_cb()` 把小屏按钮的点击接到 `start_clicked()` 或 `stop_clicked()`。回调通过 `ui_recorder_submit()` 交给工作线程。工作线程用 `socket(AF_UNIX, SOCK_STREAM, 0)` 打开 Unix 域套接字，通过 `connect()` 连接 `/tmp/gsytrace-m2/rec.sock`，再用 `control_write_line()` 和 `control_read_line()` 收发一行 JSON。你可以把这个 socket 路径当成**同一块板上两个程序约好交接命令的地址**。命令行工具 `m2-ctl` 也走这个入口，因此小屏和命令行共用一套控制逻辑。

`m2/control_server.c` 的 `control_serve()` 监听这个地址。收到 `start` 时，它先检查当前是 `IDLE`（空闲），再用 `fork()` 和 `execl()` 启动 `m2-recorder record` 子进程。这时是 `STARTING`（启动中）。等摄像头和声卡都准备好，子进程才写出开始日志，服务随后将状态更新为 `RECORDING`（录制中）。小屏通过工作线程定期查询 `status`，显示状态和时长。套接字收发在工作线程里，界面可以继续响应触摸。

### 2. 摄像头和麦克风怎样一边采集，一边写卡？

`m2/recorder.c` 启动视频和声音两路采集线程。两路都通过 `recorder_wait_start()` 报告就绪，主线程用 `clock_gettime(CLOCK_MONOTONIC, ...)` 取得共同的会话起点，再让两路开始采集。单调时钟适合算这一轮经过了多久。具体哪一帧、哪一个声音样本处在录制的哪一刻，还要用各自的采集时间戳和样本数来定位。

| 从哪里读代码 | 关键 API（Application Programming Interface，应用程序接口）怎么接 |
|---|---|
| `m2/video_capture.c` | `RK_MPI_VENC_GetStream()` 从 VENC（Video Encoder，视频编码器）借到 H.264 编码包，`RK_MPI_MB_Handle2VirAddr()` 拿到可读地址。采集线程先用 `memcpy()` 复制数据，再用 `RK_MPI_VENC_ReleaseStream()` 归还原缓冲，再用 `video_queue_try_push()` 把副本交给队列。写盘线程通过 `video_queue_pop()` 拿到副本，交给 `mp4_segmenter_packet()`。 |
| `m2/audio_capture.c` | `snd_pcm_readi()` 从 ALSA（Advanced Linux Sound Architecture，Linux 声音架构）读取声音。返回值按采样帧计数。在本板的双声道交错输入中，一帧包含左右两个采样值。采集线程选出配置的声道入队，写盘线程通过 `wav_segmenter_write()` 写 WAV。 |
| `m2/session_store.c` | 封好的片段由 `session_store_submit()` 交给后台任务算摘要并登记清单。 |

封装时，`m2/mp4_segmenter.c` 等到可独立解码的关键帧再切 MP4，`m2/wav_segmenter.c` 按采样数切 WAV。

队列像接力时的交接区。采集线程尽快把数据递出去，写盘遇到短时抖动时可以先消耗队列空间。视频队列同时限制 **64 个包和 4 MiB**，任一上限都会生效。超过上限时，这次录制报错收尾，避免悄悄丢包后还把会话标成成功。

点「结束」时，控制服务向录制子进程发送 `SIGINT`（和终端 Ctrl+C 一样的中断信号），状态进入 `STOPPING`（收尾中）。两路停止取新数据，关闭队列并等写盘线程把剩余数据写完。主线程通过 `pthread_join()` 等两路退出，`session_store_finish()` 再等后台清单任务收尾。两路成功、存储收尾也成功时，会话才写成 `complete`。界面回到 `IDLE` 后，通过 `last_session_id`、`error` 和对应目录的 `session.json` 核对这次录制。[查看 M2 的线程、时间轴和状态机](#note/notes%2Fgsytrace-m2.md)

### 3. 文件存好之后，怎么上报？断网怎么办？

`m3/edge_sync.cpp` 的 `m3-sync --watch` 是单独运行的上报进程。它用 `load_catalog()` 读 SD 卡上已经 `complete` 的会话，经 WebSocket 的 `/sync` 完成 `hello` 和 `hello_ack` 握手，再发 `manifest.put`。这条上报消息带有会话标识，以及每个分片的文件名、起止时间、大小和 SHA-256 摘要。断网时，本地录制照常收尾。上报进程等待后重试，网络恢复就可以补交。

RK3576 上，`m3/hub.py` 的 `receive_manifest()` 校验消息，调用 `m3/store.py` 的 `store_manifest()`。会话和分片写进同一笔 SQLite 事务，`commit()` 成功后才发送 `manifest.ack`。ACK（Acknowledgement）就是确认回执。即使 Hub 存好了、回执却在路上丢了，RV1106 也可以重发。Hub 用 `(device_id, session_id)` 找原记录并核对内容。重复提交相同内容会返回 `already_present`，同一标识提交不同内容会报冲突。

要做回放或分析时，Hub 再走 `/originals` 要指定的 MP4 或 WAV。接收方把原片分块存到 `.part` 临时文件，连接断开后用已写入的字节长度续传。收齐核对大小和 SHA-256 后，用 `os.replace()` 切换为正式文件名，再确认原片可用。因此查到一份会话和拿到那份原片，是两次可分别验证的交接。[查看 M3 的清单回执与原片续传](#note/notes%2Fgsytrace-m3.md)

### 面试口述版

> 这个项目有 RV1106 采集端和 RK3576 Hub。我在 RV1106 上把录制、控制和同步拆开。小屏和命令行通过 Unix 域套接字发开始、结束和状态查询，录制服务用子进程管理这一次录制。视频和麦克风两路准备好后一起开始。视频从 VENC 取编码包，先复制，再归还缓冲区，然后交给有界队列，声音也走自己的队列和写盘线程。按停止后要把队列排空，等文件和清单都收尾，才把这次会话标为完成。上报进程只扫描已完成的会话，网络断开时录制文件还在 SD 卡。Hub 把清单写进 SQLite 并提交后才回确认，重复的同一份清单只保留一份。真正需要回放时再取原片，中途断开可以从已保存的字节位置继续。

### 常见追问

**为什么不能把 VENC 的指针直接塞进队列？**

`ReleaseStream()` 会把原缓冲还给编码器，编码器随后可能拿它写下一帧。写盘线程用得晚，直接保存指针就可能读到被复用的数据。复制出来的副本由应用持有，写完再释放。

**SD 卡写不过来会怎样？**

先用有界队列吸收短时间的写入波动。视频队列同时限制包数和总字节数，避免少量大包占掉太多内存。队列满时，程序记录错误并停止本次录制，验收时查会话状态和录制日志。

**两个线程一起开始，声画怎么对齐？**

共同起点让两路的时间能换算为「录制开始后多少秒」。每帧还保留 PTS（Presentation Time Stamp，显示时间戳），音频用首段采样位置和累计样本数推进。视频和音频的分片边界会错开，所以按时间范围匹配两个轨道。

**界面显示开始成功，或已经回到空闲，能证明文件保存了吗？**

`STARTING` 说明服务接受了命令，`RECORDING` 说明采集已启动。结束后查看 `last_session_id`、`error` 和 `complete`，再检查分片能否独立解码、清单里的大小与摘要能否对上。

**为什么要写数据库之后才回 ACK？回执丢了怎么办？**

ACK 要证明会话和分片已经一起提交。回执丢了就重发，Hub 核对同一会话的内容并返回 `already_present`。面试中可以用「重复两次，再重启 Hub 查询」说明自己怎样核对幂等，也就是重复操作后落库结果仍相同。

**怎样证明断网补报和原片续传都有效？**

用两次独立的试验。第一次在录制中断开 Wi-Fi，核对 SD 卡正常收尾，恢复网络后出现同一会话的上报确认。第二次在传原片时中断连接，核对下一次请求是否使用非零字节偏移，并在收齐后对照清单验大小和 SHA-256。

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

不熟悉 Linux 时从 M0 一路读下来。如果已经能交叉编译，可以先从感兴趣的一篇切入。想补项目面试，先看本页的架构图和验收路线，然后打开那一阶段的「常见面试问法」和「验收」。回答时能讲出一个函数、一条日志和一次复测，比复述一串缩写更容易让对方跟上。

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
