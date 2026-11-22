<!-- notebook: {"version":1,"title":"GsyTrace 应用层总览 · 从一段录像读懂 M0–M7","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T16:34:02Z","favorite":false,"trashed":false,"source":null} -->

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

## 面试基础题 · Linux 与 C

这 11 道题从 Linux 排障和 C 的拷贝开始，接着练多线程、函数调用和结构体传参，最后用 C++ 看继承和哈希表。Linux 命令可以在 WSL 终端练，排查板端进程时在 MobaXterm 对应板子的 SSH 终端执行。

每道 C 或 C++ 题的完整示例各有一个 `main()`，一次复制一个来运行。C 示例存为 `demo.c`，C++ 示例存为 `demo.cpp`。在 WSL 终端进入源文件所在目录，按语言选对应的命令。`-pthread` 用于编译和链接 POSIX 线程示例。

```bash
# C 示例（包括线程题）
cc -std=c11 -Wall -Wextra -Werror -pthread demo.c -o demo && ./demo

# C++ 示例
c++ -std=c++17 -Wall -Wextra -Werror demo.cpp -o demo && ./demo
```

### 1. Linux 常用命令有哪些？平时怎么用？

**可以这样讲。** 我按手上的问题选命令。找文件用 `find`，找日志内容用 `grep`，盯新增日志用 `tail -f`。看进程先用 `ps` 定位，再用 `top` 观察。文件写不进去就用 `df -h` 看目标分区空间，用 `du -sh` 找哪个目录占用大。网络连不上时，我会确认板子有没有地址、程序有没有监听端口。

| 想查什么 | 常用命令 | 怎么读 |
|---|---|---|
| 我在哪，目录里有什么 | `pwd`、`ls -lah`、`cd ..` | `pwd` 打印当前位置。 `ls -lah` 列出含隐藏项的详细信息。 `cd ..` 退到上一级。 |
| 怎么管理文件 | `mkdir -p logs`、`cp 源文件 目标文件`、`mv 旧名 新名`、`rm -i 文件` | 分别是创建目录、复制、移动或改名、交互式删除。 |
| 怎么读文本和日志 | `cat 文件`、`less 文件`、`tail -n 50 文件`、`tail -f 文件` | 短文件可一次看完，长文件分屏看。调试常先看最后 50 行，再持续跟日志。 |
| 文件或文字在哪 | `find . -name '*.c'`、`grep -rn 'ERROR' 日志目录` | `find` 从当前目录按文件名找。 `grep -rn` 递归找包含关键字的行并打印行号。 |
| 进程与资源怎样 | `ps -ef`、`top`、`df -h .`、`du -sh .` | 先看进程列表或实时负载。后两条分别看当前目录所在分区的空间、该目录树的占用。 |
| 网络和设备怎样 | `ip addr`、`ss -lntp`、`dmesg \| tail -n 30` | 看接口地址、TCP（Transmission Control Protocol，传输控制协议）监听端口和最近的内核消息。进程信息和内核消息可能需要权限。 |
| 复制来的程序能否执行 | `file ./程序名`、`ls -l ./程序名`、`chmod +x ./程序名` | 先确认产物的类型、架构和权限。确认产物来源后，缺执行权限可以补上。 |

在 WSL 进项目根目录后，可以直接用这几条做练习。这个例子按源码文件名找候选文件，再从文件内容定位复制代码。

```bash
pwd
ls -lah
find . -type f -name 'video_capture.c'
grep -n 'memcpy' m2/video_capture.c
df -h .
du -sh m2
```

板端用的 BusyBox 会把许多命令放进同一个小程序里。工具是否安装、选项是否支持，先在目标设备上用 `命令 --help` 看一眼。例如 WSL 上的 `ps -ef` 在精简固件上可能只支持写 `ps`。端口工具如果没有 `ss`，可以看看设备有没有 `netstat`。

**追问。find 和 grep 分别什么时候用？** 我想找 `video_capture.c` 在哪个目录，用 `find`。我想看代码里哪几行调用了 `memcpy()`，用 `grep -n`。

**追问。df 和 du 为什么会报不同的数字？** `df` 看的是整个文件系统的块使用情况，`du` 从目录往下汇总还能遍历到的文件。比如大日志被删了但还被进程打开，目录里已经找不到，相关空间要等最后一个打开它的描述符关闭才释放。

### 2. Linux 某个进程 CPU 高怎么查？

**可以这样讲。** 我先连续观察几次，确认是启动时短暂冲高，还是整个录制过程都很高。看百分比前先确认是按一个逻辑 CPU 算，还是除过全机逻辑 CPU 数。然后用 `top -H -p PID` 找最忙的线程。设备支持 `perf` 时，我采样这个线程的调用栈。只有精简工具时，我读 `/proc` 线程统计，并在取帧、复制、入队和写盘几处加计数或计时。根据证据区分忙轮询、大量拷贝、软件编解码和内核开销。最后用相同输入和负载复测 CPU、处理延迟和掉帧数。

CPU（Central Processing Unit，中央处理器）的逻辑核是系统能单独安排一个线程运行的执行位置。procps 版 `top` 在 Irix 模式下，一个逻辑 CPU 跑满记为 100%，多线程进程合计可以超过 100%。例如看到 160%，相当于平均占了 1.6 个逻辑 CPU。若全机有 4 个逻辑 CPU，则约占全机理论容量的 40%。交互时用大写 `I` 切换是否除以逻辑 CPU 数。这个例子用的是进程列表里的 `%CPU` 列。[top 手册](https://man7.org/linux/man-pages/man1/top.1.html)

**第一步，找对进程和线程。** PID（Process ID，进程编号）用来找进程，TID（Thread ID，线程编号）用来找线程。GsyTrace 用小屏开始录制时，`m2/control_server.c` 启动 `m2-recorder record` 子进程。查采集和写盘优先找这个子进程。打开线程视图后，列表 PID 列显示的是每条线程的编号。按大写 `P` 按 CPU 使用率排序，多看几个刷新周期，记下持续靠前的线程。

```bash
ps -ef | grep '[m]2-recorder'
PID=1234  # 改成实际录制进程编号
top -H -p "$PID"
```

**第二步，采样热点调用栈。** 调用栈表示某个时刻程序正在执行哪个函数、上一级是从哪里调用过来的。下面用软件事件 `cpu-clock` 对指定线程采样 10 秒。 `-g` 记录调用链，`-F 99` 指定目标采样频率，`-o` 指定输出文件。在可写目录执行。当 BusyBox 的 `top` 缺少这些选项、内核未启用相应支持或 `perf` 没有权限时，可以改用下一步。调用链名字缺失时，核对是否有与板端可执行产物匹配的符号，以及调用链能否正确展开。[perf record 手册](https://man7.org/linux/man-pages/man1/perf-record.1.html)

```bash
TID=1235  # 改成实际热点线程编号
perf record -e cpu-clock -F 99 -g -t "$TID" -o cpu-thread.data -- sleep 10
perf report -i cpu-thread.data
```

**第三步，没有 perf 也能缩小范围。** 每条线程都有 `/proc/PID/task/TID/stat`。第 14、15 字段分别是 `utime` 和 `stime`，即线程在用户态和内核态累计运行的时钟滴答数。取两次差值，除以 `getconf CLK_TCK` 得到这段时间真正占了几秒 CPU，再除以观测间隔。下面的脚本先去掉可能含空格的括号内线程名，所以原来的第 14、15 字段变成脚本里的第 12、13 列。保留前面两个实际编号再运行。[任务目录手册](https://man7.org/linux/man-pages/man5/proc_pid_task.5.html) [stat 字段手册](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)

```bash
(
    set -eu
    stat_file="/proc/$PID/task/$TID/stat"
    read_ticks() {
        awk '{ sub(/^.*\) /, ""); print $12 + $13 }' "$stat_file"
    }

    hz=$(getconf CLK_TCK)
    t0=$(awk '{print $1}' /proc/uptime)
    ticks0=$(read_ticks)
    sleep 1
    t1=$(awk '{print $1}' /proc/uptime)
    ticks1=$(read_ticks)
    awk -v hz="$hz" -v dt0="$t0" -v dt1="$t1" \
        -v ticks0="$ticks0" -v ticks1="$ticks1" '
        BEGIN {
            if (hz <= 0 || dt1 <= dt0 || ticks1 < ticks0) exit 1
            printf "一核口径 CPU %.1f%%\n", 100 * (ticks1 - ticks0) / hz / (dt1 - dt0)
        }'
)
```

线程需要在采样期间持续运行。若某个阶段耗时大，用 `clock_gettime(CLOCK_MONOTONIC, ...)` 量经过时间，用 `CLOCK_THREAD_CPUTIME_ID` 量同一个线程真正用的 CPU 时间。举例说，写盘经过 200 毫秒，线程只用了 2 毫秒 CPU，下一步就应查写盘和等待路径。[clock_gettime 手册](https://man7.org/linux/man-pages/man2/clock_gettime.2.html)

**追问。看到 memcpy 很热，能直接去掉吗？** 先看它从哪一层调用、每秒拷多少字节。比如 GsyTrace 的 `m2/video_capture.c` 必须在 `RK_MPI_VENC_ReleaseStream()` 之前把写盘线程要用的数据复制出来。应用一归还，编码器就可以复用原缓冲。可以继续找重复拷贝，或先验证缓冲区生命周期，再测改动后的数据完整性。

**追问。CPU 降了怎么证明优化有效？** 我会保持同样的分辨率、目标帧率、输入、录制时长和存储条件，改前改后都记录 CPU、处理延迟、实际输出帧数和掉帧数。程序少处理了一半帧时，CPU 降下来的数字没有说服力。

### 3. C 语言怎么拷贝内存？memcpy 和 memmove 有什么区别？

**可以这样讲。** 我先确认拷贝长度和两块内存的关系。`memcpy(dst, src, n)` 按字节复制，适用于源和目的区域互不重叠。区域可能重叠时用 `memmove()`，它会保留原始数据的顺序。两个函数都在 `<string.h>`，调用者要保证源能读 `n` 字节、目的能写 `n` 字节。

下面两次拷贝都按字节数执行。第一次复制包含零字节的数据，第二次在同一个数组里向右挪四个字符。

```c
#include <stdio.h>
#include <string.h>

int main(void)
{
    const unsigned char source[] = {0x41, 0x00, 0x42};
    unsigned char target[sizeof source];
    memcpy(target, source, sizeof source);
    printf("%02X %02X %02X\n", (unsigned)target[0],
           (unsigned)target[1], (unsigned)target[2]);

    char buf[] = "ABCDE";
    memmove(buf + 1, buf, 4);
    puts(buf);
    return 0;
}
```

预期依次打印 `41 00 42` 和 `AABCD`。第二次源区域是 `buf[0..3]`，目的区域是 `buf[1..4]`，重叠部分要按移动前的内容复制。`buf[5]` 的终止符仍在原位置。

**追问。memmove 为什么能处理重叠？** 它的效果相当于先把源字节保存起来，再写入目的。实际实现可以根据地址选拷贝方向。例如这个右移场景可以从后往前复制，先保住即将被覆盖的字节。

**追问。拷贝一个 int 数组，第三个参数填什么？** 填元素个数乘上每个元素的字节数，例如 `count * sizeof src[0]`。如果 `src` 在函数参数里是指针，`sizeof src` 只会给出指针自身的大小。

### 4. 深拷贝和浅拷贝有什么区别？

**可以这样讲。** 对含指针的结构体直接赋值时，普通字段和指针值都会复制。两份结构体里的指针因此指向同一块内存，这就是这里的浅拷贝。要做深拷贝，我会为需要独立持有的数据分配空间，复制内容，再分别管理释放。

下面让 `a.name` 指向一个可修改的字符数组。修改浅拷贝的第一个字符后，原对象也会变，深拷贝仍保持原来的内容。

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct Record {
    char *name;
};

int main(void)
{
    char original[] = "hello";
    struct Record a = { .name = original };
    struct Record shallow = a;

    size_t bytes = strlen(a.name) + 1;
    struct Record deep = { .name = malloc(bytes) };
    if (deep.name == NULL) {
        return 1;
    }
    memcpy(deep.name, a.name, bytes);

    shallow.name[0] = 'H';
    printf("%s %s\n", a.name, deep.name);
    free(deep.name);
    return 0;
}
```

预期输出 `Hello hello`。这里只有 `deep.name` 由 `malloc()` 分配，所以只对它调用 `free()`。指针的所有权说的是谁负责释放指向的资源。两个浅拷贝对象都释放同一块堆内存，会引发重复释放。

**追问。结构体里写的是 `char name[32]` 呢？** 固定数组直接属于结构体，赋值时数组元素也跟着复制。两份结构体各有自己的数组，可以独立修改。

**追问。memcpy 能做深拷贝吗？** `memcpy(&b, &a, sizeof a)` 只复制结构体本身的字节，指针值还是原地址。深拷贝时可以先为指针指向的数据分配独立空间，再用 `memcpy()` 复制那块数据。C 标准库没有适用于任意结构体的通用深拷贝接口。

### 5. 字符串拷贝怎么写？标准库有哪些函数？

**可以这样讲。** C 字符串用 `'\0'` 标记结尾。我逐个复制字符，最后写入终止符。调用 `strcpy()` 前，目的空间至少要有 `strlen(src) + 1` 字节。如果已知缓冲区容量，也可以用 `snprintf()` 格式化复制，并检查是否截断。

这个示例实现了 `strcpy()` 的核心逻辑。源和目的区域应互不重叠，源必须是以 `'\0'` 结尾的有效字符串。

```c
#include <stdio.h>
#include <string.h>

char *my_strcpy(char *dst, const char *src)
{
    char *start = dst;
    while (*src != '\0') {
        *dst = *src;
        ++dst;
        ++src;
    }
    *dst = '\0';
    return start;
}

int main(void)
{
    const char *src = "cat";
    char dst[4];
    if (strlen(src) >= sizeof dst) {
        return 1;
    }
    puts(my_strcpy(dst, src));
    return 0;
}
```

预期输出 `cat`。三个可见字符加一个终止符，正好占 4 字节。`my_strcpy()` 返回目的缓冲区的起始地址。

| 标准库函数 | 怎么选 |
| --- | --- |
| `strcpy(dst, src)` | 在 `<string.h>`。一直复制到终止符，调用者先确认目的空间足够。 |
| `strncpy(dst, src, n)` | 在 `<string.h>`。写满 `n` 字节，源较短时补零，源长度达到或超过 `n` 时结果没有终止符。 |
| `snprintf(dst, cap, "%s", src)` | 在 `<stdio.h>`。处理成功且 `cap > 0` 时结果会有终止符。返回值小于零表示出错，非负且大于等于 `cap` 表示输出所需空间超过容量。 |

**追问。目的缓冲区不足时，怎么判断 snprintf 截断了？** 先检查返回值是否小于零，再用 `(size_t)ret >= sizeof dst` 判断。返回值表示完整输出原本需要写入的字符数，单位是字节，不计末尾的终止符。

**追问。memcpy 能复制字符串吗？** 已知源是有效字符串、目的空间足够、两块区域不重叠时，可以写成 `memcpy(dst, src, strlen(src) + 1)`。多出的 1 字节用来把终止符一起复制过去。

### 6. Linux 线程怎么同步？为什么 count++ 要保护？

**可以这样讲。** 我先看线程之间要协调什么。多线程要修改同一组共享数据时，我用互斥锁保护这段代码。要等队列里有数据时，我把互斥锁与条件变量配合使用。如果只更新一个独立计数，我可以用 C11 原子的 `atomic_fetch_add()`。`count++` 要读旧值、计算新值、写回结果，两条线程可能读到同一个旧值，所以整次更新都要纳入保护。

用这张顺序表理解丢失更新。实际 C 程序对普通共享变量这样并发访问会产生数据竞争，行为未定义。表中只是演示一种可能的交错。

```text
时刻     线程 A          线程 B          共享 count
 1      读到 0                              0
 2                      读到 0              0
 3      写入 1                              1
 4                      写入 1              1
```

| 需要协调什么 | 常用做法 |
| --- | --- |
| 一个线程更新一组共享字段时，让其他线程等候 | 互斥锁（mutex，mutual exclusion）。把读取、判断和更新放在同一段持锁代码里 |
| 睡眠等队列有数据，或者等队列关闭 | 条件变量（condition variable）。用互斥锁保护条件，醒来后用 `while` 重新检查 |
| 管理若干个可用名额 | 信号量（semaphore）。`sem_wait()` 取一个名额，`sem_post()` 还一个 |
| 多个线程可同时读取，写入时需要独占 | 读写锁（read-write lock）。先确认读并发能带来收益 |
| 更新独立计数或读写一个共享标志 | C11 原子操作（atomic operation），如 `atomic_fetch_add()`、`atomic_store()` |
| 等待时间很短，并且持锁期间不会阻塞 | 自旋锁。等待时持续检查锁，会消耗 CPU |
| 等一条线程退出，再读取它留下的结果 | `pthread_join()` |
| 等所有参与线程抵达同一个阶段 | 屏障。大家都到齐后才能继续下一阶段 |

两条线程各加 10,000 次。`increment()` 里先加锁，完成写回再解锁。主线程等两条线程都结束后打印结果。`check_pthread()` 负责在调用出错时打印错误并退出。

```c
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int count;
static pthread_mutex_t count_lock = PTHREAD_MUTEX_INITIALIZER;

static void check_pthread(int rc, const char *operation)
{
    if (rc != 0) {
        fprintf(stderr, "%s: %s\n", operation, strerror(rc));
        exit(EXIT_FAILURE);
    }
}

static void *increment(void *unused)
{
    (void)unused;
    for (int i = 0; i < 10000; ++i) {
        check_pthread(pthread_mutex_lock(&count_lock), "pthread_mutex_lock");
        ++count;
        check_pthread(pthread_mutex_unlock(&count_lock), "pthread_mutex_unlock");
    }
    return NULL;
}

int main(void)
{
    pthread_t a, b;
    check_pthread(pthread_create(&a, NULL, increment, NULL), "pthread_create");
    check_pthread(pthread_create(&b, NULL, increment, NULL), "pthread_create");
    check_pthread(pthread_join(a, NULL), "pthread_join");
    check_pthread(pthread_join(b, NULL), "pthread_join");
    printf("count=%d\n", count);
    check_pthread(pthread_mutex_destroy(&count_lock), "pthread_mutex_destroy");
    return 0;
}
```

预期输出 `count=20000`。GsyTrace 的 `m2/video_queue.c` 使用互斥锁保护包数、字节数和队列位置。在队列为空且仍开启时，写盘线程睡在 `pthread_cond_wait()`。关闭队列时用 `pthread_cond_broadcast()` 唤醒等待者，写盘线程会继续取完剩余的包。停止标志用原子变量。主线程通过 `pthread_join()` 等两路采集收尾，采集线程也会等各自的写盘线程退出。

**追问。只给 count 加 volatile 可以吗？** `volatile` 约束编译器处理这个变量的访问，读、加、写仍是分开的。需要保证单个计数正确时，可在引入 `<stdatomic.h>` 后声明 `atomic_int count = 0`，每次用 `atomic_fetch_add(&count, 1)` 完成一次原子更新。如果要同时维持多个字段之间的关系，可以把这组更新放进同一把锁。

**追问。条件变量为什么用 while 等？** `pthread_cond_wait()` 等待时会释放互斥锁，返回前会重新拿到锁。醒来时可能发生虚假唤醒，或者另一个消费者已经先把包取走，所以拿到锁以后要再检查队列状态。[POSIX 条件变量手册](https://www.man7.org/linux/man-pages/man3/pthread_cond_wait.3p.html)

### 7. 函数调用栈是什么？调用和返回时发生了什么？

**可以这样讲。** 函数调用栈记录谁调用了谁，还帮助程序恢复到调用之后继续执行。一个函数调用另一个函数时，编译器会按目标平台约定传递参数，并按需要保存返回地址、寄存器或局部数据。每次调用在栈上使用的那部分空间叫栈帧。最内层函数先返回，所以调用是从外往里，返回是从里往外。

日志依次显示进入 `outer()`、进入 `inner()`，以及返回之后从哪里继续执行。

```c
#include <stdio.h>

static int inner(int x)
{
    printf("inner enter, x=%d\n", x);
    return x + 1;
}

static int outer(int x)
{
    printf("outer enter, x=%d\n", x);
    int result = inner(x);
    printf("outer resumes, result=%d\n", result);
    return result * 2;
}

int main(void)
{
    puts("main calls outer");
    int result = outer(3);
    printf("main resumes, result=%d\n", result);
    return 0;
}
```

```sh
cc -std=c11 -Wall -Wextra -g -O0 demo.c -o demo && ./demo
```

预期输出如下。进入 `inner()` 时，调用链是 `main()` → `outer()` → `inner()`，`inner()` 是栈顶的当前调用。调试器停在这里时，可用 GDB（GNU Debugger，GNU 调试器）的 `bt`（backtrace，调用栈回溯）查看这条链。

```text
main calls outer
outer enter, x=3
inner enter, x=3
outer resumes, result=4
main resumes, result=8
```

在 RV1106 的 32 位 Arm 程序里，调用规则属于 ABI（Application Binary Interface，应用程序二进制接口）。按 AAPCS32（Procedure Call Standard for the Arm Architecture，32 位 Arm 架构过程调用标准），例如一个函数接收五个普通 `int` 参数，前四个经 `r0` 到 `r3` 传递，第五个经栈传递。普通 `int` 返回值走 `r0`，SP（Stack Pointer，栈指针）在 `r13`，`BL`（Branch with Link，带返回链接的跳转）将返回地址写入 LR（Link Register，链接寄存器）`r14`。函数需要保留原来的返回地址时，编译器可以把它保存到栈里。需要栈空间时，函数把 SP 往低地址移。返回前恢复保存的寄存器和 SP，腾出来的空间就可以给下一次调用复用。参数类型和对齐也会影响实际的寄存器分配。[Arm AAPCS32 官方规范](https://github.com/ARM-software/abi-aa/blob/main/aapcs32/aapcs32.rst)

**追问。每个局部变量都放在栈里吗？** 编译器会按需放到寄存器或栈上。优化还可能消去中间变量，或者把短函数展开到调用处。调试示例用 `-g -O0` 生成调试信息并降低优化程度，方便对照代码看调用顺序。

**追问。为什么函数不能返回普通局部变量的地址？** 普通局部对象随函数返回而结束生命周期。此后再通过留下的地址访问它会产生未定义行为。可以直接返回值，或由调用者提供缓冲区让函数填入。

### 8. C 结构体当参数时，传值和传指针怎么选？

**可以这样讲。** C 的参数按值传递。传 `struct Packet p` 时，函数得到一份结构体值，修改副本里的普通字段只影响副本。传 `struct Packet *p` 时，复制的是地址，函数可以通过该地址访问原结构体。只想借来读时，我用 `const struct Packet *p` 表达接口对这个结构体的只读意图。选择哪种写法，要看是否需要修改原对象、对象大小和它的生命周期。

这个例子的三次调用分别修改结构体副本的长度、原结构体的长度和共享的字节数组。

```c
#include <stdio.h>

struct Packet {
    size_t bytes;
    unsigned char *data;
};

static void shorten_copy(struct Packet p)
{
    p.bytes = 1;
    printf("inside the copy: bytes=%zu\n", p.bytes);
}

static void shorten_original(struct Packet *p)
{
    p->bytes = 1;
}

static void change_shared_data(struct Packet p)
{
    p.data[0] = 'Z';
}

int main(void)
{
    unsigned char payload[] = {'A', 'B'};
    struct Packet packet = { .bytes = sizeof payload, .data = payload };

    shorten_copy(packet);
    printf("after passing by value: bytes=%zu\n", packet.bytes);
    shorten_original(&packet);
    printf("after passing a pointer: bytes=%zu\n", packet.bytes);
    change_shared_data(packet);
    printf("shared data: first=%c\n", packet.data[0]);
    return 0;
}
```

```text
inside the copy: bytes=1
after passing by value: bytes=2
after passing a pointer: bytes=1
shared data: first=Z
```

`&packet` 取原对象的地址，`p->bytes` 等价于 `(*p).bytes`。最后一行变为 `Z`，因为结构体副本中的 `data` 仍指向同一个 `payload`。GsyTrace 的 `m2/video_queue.c` 有一个相似的赋值 `q->slots[tail] = *packet`。入队成功后立即清空调用者的包描述符，之后由写盘线程从队列取出并释放那块缓冲区。这是程序约定的所有权转移。

**追问。传指针一定更快吗？** 传值时复制的实际成本取决于结构体大小、ABI 和编译器优化，小结构体可能直接走寄存器。传指针会少复制大对象，同时增加一次间接访问，并要求对象有效。先按接口语义选择，性能敏感时再用同一组输入测量。

**追问。const struct Packet *p 能保护指针成员指向的数据吗？** 它约束的是通过 `p` 对结构体本身的访问，例如通过它写 `p->bytes` 会被编译器拒绝。如果成员仍声明成 `unsigned char *data`，通过它仍能修改缓冲区。想表达缓冲区只读，可以在只读接口里用 `const unsigned char *data`。

### 9. C++ 的基类和派生类都声明了 int a，访问哪个？

**可以这样讲。** 以普通的公开继承为例。一个派生类对象里有基类子对象，基类的 `a` 和派生类的 `a` 各自存值。通过派生类对象写 `obj.a`，名字查找先在派生类里找到 `a`，这叫名字隐藏。需要访问基类的成员时，我在派生类的成员函数里写 `Base::a`，在对象外面写 `obj.Base::a`。把同一个对象绑定到 `Base&` 后，`ref.a` 按引用的静态类型查找，访问的就是基类里的 `a`。

```cpp
#include <iostream>

struct Base {
    int a = 10;
};

struct Derived : public Base {
    int a = 20;
};

int main()
{
    Derived obj;
    Base& ref = obj;

    std::cout << obj.a << ' ' << obj.Base::a << ' ' << ref.a << '\n';
    ref.a = 30;
    std::cout << obj.a << ' ' << obj.Base::a << ' ' << ref.a << '\n';
}
```

第一行输出 `20 10 10`，第二行输出 `20 30 30`。`ref` 绑定到 `obj` 里的基类子对象，所以通过 `ref` 修改基类的 `a`，用 `obj.Base::a` 也能读到新值。

**追问。数据成员会像虚函数一样按运行时类型选择吗？** 数据成员访问遵循编译期的名字查找和访问规则。虚函数调用可以按对象的运行时类型选择实现。上面通过 `Base&` 读取的始终是基类的成员。

**追问。如果基类的 `a` 是 `private`，还能写 `obj.Base::a` 吗？** 外部这样写会触发访问错误。若需要让外部读它，可以在基类里提供公有的 `get_a()`。限定写法负责选中成员，成员的访问权限由类定义决定。

### 10. 哈希表怎么找数据，两个键落在同一处怎么办？

**可以这样讲。** 哈希表先把键交给哈希函数，再把结果换成桶的下标。比如用编号查询资料，编号是键，存下来的资料是值。可以把桶想成编号的抽屉，找到抽屉后，还要比较里面存的完整键。两个不同的键可能落入同一个桶，这叫哈希冲突。下面用 5 个桶，键 `1`、`6`、`11` 都会落在 1 号桶。这个例子用拉链法，每个桶里放一小组键值对。

```cpp
#include <array>
#include <cstddef>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

class FiveBuckets {
public:
    void put(int key, const std::string& value)
    {
        auto& entries = buckets_[bucket_index(key)];
        for (auto& entry : entries) {
            if (entry.first == key) {
                entry.second = value;
                return;
            }
        }
        entries.emplace_back(key, value);
    }

    bool lookup(int key, std::string& value) const
    {
        const auto& entries = buckets_[bucket_index(key)];
        for (const auto& entry : entries) {
            if (entry.first == key) {
                value = entry.second;
                return true;
            }
        }
        return false;
    }

private:
    static std::size_t bucket_index(int key)
    {
        return static_cast<std::size_t>((key % 5 + 5) % 5);
    }

    std::array<std::vector<std::pair<int, std::string>>, 5> buckets_;
};

int main()
{
    FiveBuckets table;
    table.put(1, "one");
    table.put(6, "six");
    for (int key : {1, 6, 11}) {
        std::string value;
        if (table.lookup(key, value)) {
            std::cout << key << " -> " << value << '\n';
        } else {
            std::cout << key << " -> missing\n";
        }
    }
}
```

输出依次为 `1 -> one`、`6 -> six` 和 `11 -> missing`。查 `11` 时，程序确实找到了 1 号桶，逐个对比 `1` 和 `6` 后才知道 `11` 没存进去。这个示例固定用 5 个桶，`(key % 5 + 5) % 5` 也能让负数键得到合法下标。

**追问。还可以怎样处理冲突？** 开放寻址法把数据放在表的槽位里。以线性探测为例，首选槽位冲突后就依次检查下一格，直到找到相同键或确定停止查找。若支持删除，常用专门标记保留探测路径，避免在中途遇到一个刚删除的位置便提前结束。

**追问。哈希表查找总是 `O(1)` 吗？** 当哈希分布合适、平均每个桶里只有少量元素时，查找平均是 `O(1)`。如果大量键集中在一个桶，拉链法最坏会查 `O(n)` 个元素。扩容时一般要用新的桶数重算每个键的位置。

### 11. 两数之和怎么用哈希表，为什么要先查再存？

**可以这样讲。** 我从左向右遍历数组，用 `std::unordered_map` 记录已经见过的值和下标。当前值是 `x`，就去表里找 `target - x`。找到了便返回两个下标，没找到就登记当前值。先查再存让匹配项一定来自之前的位置，也能处理 `[3, 3]` 配目标 `6` 的情况。

拿 `[4, 7, 2, 6]` 和目标 `9` 走一遍。

| 当前下标 | 当前数 | 去表里找什么 | 这一步的结果 |
| --- | --- | --- | --- |
| 0 | 4 | 5 | 找不到，记下 `4 → 0` |
| 1 | 7 | 2 | 找不到，记下 `7 → 1` |
| 2 | 2 | 7 | 查到 `7 → 1`，返回下标 `[1, 2]` |

```cpp
#include <climits>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <unordered_map>
#include <vector>

struct Answer {
    bool found;
    std::size_t first;
    std::size_t second;
};

Answer two_sum(const std::vector<int>& values, int target)
{
    std::unordered_map<std::int64_t, std::size_t> seen;
    for (std::size_t i = 0; i < values.size(); ++i) {
        const std::int64_t current = values[i];
        const std::int64_t needed = static_cast<std::int64_t>(target) - current;
        const auto match = seen.find(needed);
        if (match != seen.end()) {
            return {true, match->second, i};
        }
        seen.emplace(current, i);
    }
    return {false, 0, 0};
}

void print(Answer answer)
{
    if (answer.found) {
        std::cout << answer.first << ' ' << answer.second << '\n';
    } else {
        std::cout << "no pair\n";
    }
}

int main()
{
    print(two_sum({4, 7, 2, 6}, 9));
    print(two_sum({3, 3}, 6));
    print(two_sum({3}, 6));
    print(two_sum({INT_MIN, INT_MAX}, -1));
    print(two_sum({INT_MIN, 0}, INT_MAX));
}
```

五行依次输出 `1 2`、`0 1`、`no pair`、`0 1`、`no pair`。下标从 0 开始。`emplace()` 遇到同键会保留第一次登记的下标。每个位置做一次查找，必要时再做一次插入，所以平均时间是 `O(n)`，额外空间是 `O(n)`。例如最坏情况下许多键都碰撞，每次查找可能扫描此前所有元素，整个过程可到 `O(n²)`。

**追问。如果 `target - x` 超出 `int` 范围怎么办？** 先把操作数提升到 `std::int64_t` 再减。在这里的 32 位和 64 位 Linux 环境，`int` 是 32 位，两者的差能放进 64 位有符号整数。哈希表也用 64 位键。先按 `int` 做减法再把结果转成 64 位，会在转换前触发有符号溢出。

**追问。为什么查找用 `find()`？** `find()` 查不到时返回 `end()`，它不会改动哈希表。`operator[]` 遇到不存在的键会插入一个默认值。例如下标的默认值是 `0`，这会让缺失的键和合法的 0 号下标混在一起。

## 源码和实测口径

正文以 GsyTrace **`v1.0.0`（`abb9fb8`）** 的应用层源码为参照，文件路径从项目根目录开始。历史里程碑有各自的编译产物和验收记录，所以早期命令、构建开关和数字都放回对应阶段讲。图中的媒体内容和部分时间点是示意，实测值会在各篇验收段落中注明。

几个容易记错的结论也可以从目录直接回查。M5 的原帧对得上，图注语义仍需要人工核对。M6 的约 10 帧每秒来自显示缓冲区的更新记录，首播包含整段短片下载时间。M7 验证的是应用版本切换和服务重启，整板断电重启没有记录在这次验收里。

[从 M0 开始，在 RV1106 上跑出第一行输出 →](#note/notes%2Fgsytrace-m0.md)
