<!-- notebook: {"version":1,"title":"GsyTrace M1 · 分开跑通摄像头和麦克风","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->
# GsyTrace M1 · 分开跑通摄像头和麦克风

[![M1 架构图。摄像头经 ISP、VI 和 VENC 输出 H.264，麦克风经 ALSA 选路后输出 PCM WAV。](assets/gsytrace/m1.png)](assets/gsytrace/m1.png)

[回到项目总览](#note/notes%2Fgsytrace-overview.md) · [上一篇 M0](#note/notes%2Fgsytrace-m0.md) · [下一篇 M2](#note/notes%2Fgsytrace-m2.md)

## 先把图上的两条线分开看

第一条线把 **SC3336** 摄像头拍到的画面交给 **ISP（Image Signal Processor，图像信号处理器）**。由 **RKAIQ（Rockchip Auto Image Quality，瑞芯微自动图像质量控制相关接口）**准备 ISP，之后 **VI（Video Input，视频输入）**提供图像帧，**VENC（Video Encoder，视频编码器）**将帧压缩成 H.264。瑞芯微在这里使用 **MPI（Media Processing Interface，媒体处理接口）**作为应用可调用的函数集合。驱动层的 **V4L2（Video for Linux 2，Linux 视频框架第二版）**仍负责底层设备，GsyTrace 采集应用调用 Rockchip MPI，MPP（Media Process Platform，媒体处理平台）等媒体库负责衔接下层。

第二条线使用 **ALSA（Advanced Linux Sound Architecture，高级 Linux 声音架构）**读取声卡。麦克风数据经 **PCM（Pulse-Code Modulation，脉冲编码调制）**变成一串等时间间隔的样本。本项目以双通道交错格式读设备，从每个采样时刻选一个通道写入 WAV。

**编码、像素格式和容器各管一件事。** H.264 也叫 **AVC（Advanced Video Coding，高级视频编码）**，负责压缩图像。 `RK_FMT_YUV420SP` 描述编码前的图像布局，属于 YUV420 半平面格式。Y 表示亮度，U 与 V 是色度分量。可用 NV12 的亮度平面与交错色度平面来理解这种布局。**WAV（Waveform Audio File Format，波形音频文件格式）**是音频容器，这里的 WAV 装的是 PCM。MP4 在 M2 作为视频容器登场。

## 第一步 · 编写摄像头探针 m1/video.c

先用 SDK 参考程序核对头文件和调用顺序。这里取设备号、处理管线号和通道号都为 0，所以隔一段时间回来看代码时，要靠参数类型区分 `Dev → Pipe → Chn`。它们代表视频设备、处理管线和可配置的输出通道。

| 步骤 | 主要 API（Application Programming Interface，应用程序编程接口） | 为什么这样做 |
|---|---|---|
| 确认传感器，准备 ISP | `rk_aiq_uapi2_sysctl_enumStaticMetasByPhyId()`、`rk_aiq_uapi2_sysctl_init()`、`prepare()`、`start()` | 用设备识别出的传感器名称与板上的 IQ（Image Quality，图像质量）配置启动图像处理 |
| 初始化媒体系统并开放 VI | `RK_MPI_SYS_Init()`、`RK_MPI_VI_SetDevBindPipe()`、`RK_MPI_VI_SetChnAttr()`、`RK_MPI_VI_EnableChn()` | 指定设备、管线、画面尺寸、像素格式与缓冲 |
| 创建硬件编码通道 | `RK_MPI_VENC_CreateChn()`、`RK_MPI_VENC_StartRecvFrame()`、`RK_MPI_SYS_Bind()` | 让硬件从 VI 接收图像帧并编码 |
| 取出一个包、写入文件、还回去 | `RK_MPI_VENC_GetStream()`、`RK_MPI_MB_Handle2VirAddr()`、`fwrite()`、`RK_MPI_VENC_ReleaseStream()` | 从编码模块借来的缓冲只能用到归还时刻 |
| 收尾 | `RK_MPI_SYS_UnBind()`、`RK_MPI_VENC_StopRecvFrame()`、`RK_MPI_VENC_DestroyChn()`、`RK_MPI_SYS_Exit()`、RKAIQ 的停止和释放 | 把已经成功申请的资源反向收回，错误路径也执行对应清理 |

`m1/video.c` 的设置是 1920×1080、25 fps（frames per second，每秒帧数），每次取一个编码包，共取 125 包。设置的 GOP（Group of Pictures，图像组）大小为 25，目标是一秒一个图像组，帮助后续理解关键帧间隔。

下面是读包与归还的顺序示意。实际实现会核对包数、句柄、长度和缓冲大小，出错时按资源状态收尾。

```c
VENC_PACK_S pack = {0};
VENC_STREAM_S stream = {.pstPack = &pack, .u32PackCount = 1};

CHECK(RK_MPI_VENC_GetStream(0, &stream, 2000));
const void *payload = RK_MPI_MB_Handle2VirAddr(pack.pMbBlk);
/* 校验 payload 和 pack.u32Len，成功时用 fwrite 写文件。 */
CHECK(RK_MPI_VENC_ReleaseStream(0, &stream));
```

程序先写 `camera.h264.part`，正常写完再改为 `camera.h264`。保存了多少字节只是第一项检查，还要让解码器从头读到尾再看画面。

## 第二步 · 编写声音探针 m1/audio.c

`hw:0,0` 是 ALSA 的设备写法，意思是声卡 0、设备 0。先用 `arecord -l`（小写字母 l）确认板子设备，再给 ALSA 配置 16,000 Hz、双通道读取、交错存放、`S16_LE`。这里 **Hz（hertz，赫兹）**表示每秒采样次数，`S16_LE` 表示 **Signed 16-bit Little Endian**，即有符号 16 位小端样本。

| API | 应用里负责什么 |
|---|---|
| `snd_pcm_open()` | 打开 PCM 采集流 |
| `snd_pcm_set_params()` | 设置格式、交错方式、通道数、采样率等 |
| `snd_pcm_start()` | 显式启动硬件采集 |
| `snd_pcm_readi()` | 读取交错数据，返回读到的采样帧数 |
| `fwrite()`、`rename()` | 写 WAV 头及所选通道样本，完整关闭后改成最终文件名 |
| `snd_pcm_close()` | 释放设备 |

**采样帧和视频帧同名，单位各有含义。** 一帧双通道 PCM 是同一个采样时刻的两个样本。交错存储依次是 L0、R0、L1、R1。取第 `i` 帧的第 `mic` 路，用 `stereo[i * 2 + mic]`。

```c
snd_pcm_sframes_t got = snd_pcm_readi(pcm, stereo, want);
/* 建立错误分支后，仅在 got > 0 时进入这个循环。 */
for (snd_pcm_sframes_t i = 0; i < got; ++i)
    mono[i] = stereo[i * 2 + mic];
```

程序固定录 5 秒，输出 `mic.wav`。这个 WAV 头是 44 字节。音频数据为 5 × 16,000 × 1 × 2，共 160,000 字节，整个文件预期 160,044 字节。拿分别录出的两个通道听一次，可确定所用板卡上哪一路的信号更清晰。

## 第三步 · 编译、上板、独立解码

沿用 M0 的 `SDK`、`TC`，在 WSL 项目根目录执行。正式仓库的根 `CMakeLists.txt` 已将媒体样例头文件、Rockchip 媒体库和 Buildroot 的 ALSA 库接入。

```sh
cmake -S . -B build/m1-rv1106 \
  -DCMAKE_TOOLCHAIN_FILE="$PWD/cmake/rv1106-toolchain.cmake" \
  -DCMAKE_C_COMPILER="$TC-gcc" -DGSY_SDK_ROOT="$SDK"
cmake --build build/m1-rv1106 --target m1-video m1-audio
file build/m1-rv1106/m1-video build/m1-rv1106/m1-audio
wslpath -w "$PWD/build/m1-rv1106"
```

通过 MobaXterm 把两个 ELF 传到 RV1106 的新目录。下方命令在板上执行。目录要可写，媒体库要能加载，摄像头与声卡应空闲。先分别执行，记录退出码，再测试两个探针短时间同时运行。

```sh
chmod +x m1-video m1-audio
./m1-video
echo "video exit=$?"
./m1-audio 0
echo "audio exit=$?"
wc -c camera.h264 mic.wav
```

若需要试听通道 1，先把通道 0 的结果改名保存，避免下一次生成同名 `mic.wav`。将结果传回 WSL，用 FFmpeg 系列工具检查属性、逐帧计数并从头解码。

```sh
ffprobe -v error -select_streams v:0 -count_frames \
  -show_entries stream=codec_name,width,height,nb_read_frames camera.h264
ffmpeg -v error -xerror -i camera.h264 -f null -
ffprobe -v error -select_streams a:0 \
  -show_entries stream=codec_name,sample_rate,channels,duration mic.wav
ffplay -nodisp -autoexit mic.wav
```

当时的五秒实板复测在同一启动期间让两个探针并行运行，退出码都为 0。解码验证了 125 帧 1920×1080 H.264 和 5 秒、16 kHz、单声道的 PCM WAV。早期提交是 `a893f2d`。解码通过以后顺手查看画面是否有实际运动、试听录音是否清楚，避免出现文件格式正确但采集内容无效的情况。

## 开发中碰到的坑

1. **日志写出 `Detected OV00cc41 sensor`，型号看起来像另一家。** 检查 SDK 驱动里的日志格式，`OV` 是固定前缀，`0x00cc41` 对应这块板上 SC3336 的芯片标识。证据链应走到绑定、可解码和真实画面，逐项判断。
2. **首包能写，后续包被 `u32Offset == 0` 拦下。** 实测次包出现非零 offset。对照 SDK 参考样例后，去掉这一前置条件，保留 `pMbBlk`、`u32Len`、缓冲大小检查并确保每个成功获取的包都归还，再用整段解码证明适配有效。单凭 offset 的数值不足以断定它相对哪个基址。
3. **`arecord` 能录，自写的 `snd_pcm_readi()` 返回 `-EIO`。** 先用相同采样参数缩小范围。该板上在读取前显式调用 `snd_pcm_start()` 后恢复，5 秒声音和字节数都通过。 `EIO` 即 Input/Output error，表示输入输出错误，故障定位还要结合设备状态。
4. **一次并行测试异常后手动复位，原日志不见了。** 当时临时日志在易失目录。之后先把关键输出复制到 WSL 或安全地写入 SD，再复位。重新跑通可作为后续验收，旧故障成因仍记录为未知。

## 常见面试问法

### 你在应用层如何从摄像头拿到 H.264？

**可以这样答。** 我先启动 RKAIQ/ISP，配置 VI 产出编码器需要的 YUV420 半平面画面，再用 MPI 把 VI 通道绑定 VENC。应用从 VENC 取压缩包，检查并写入文件，最后归还缓冲。我用 FFmpeg 完整解码核对。

**追问。V4L2 在哪里？** 传感器和媒体设备通过内核 V4L2 框架接入。这里的应用入口是 Rockchip MPI，VI 的缓冲属性可选择 V4L2 对应的 DMA-BUF（Direct Memory Access Buffer，直接内存访问缓冲）类型。

### 为什么每次取包后都要 `ReleaseStream`？

**可以这样答。** VENC 把来自缓冲池的包借给我。应用写完即归还，编码器才能继续复用内存。漏还会耗尽缓冲池，过早归还可能使后面的读操作读到已复用的内容。

**追问。写卡另开线程怎么做？** 我在归还前拷贝必要的内容和时间戳，把副本交给应用自己的有界队列。这就是 M2 的改动。

### 16 kHz 是什么，为什么双通道读完只存一路？

**可以这样答。** 16 kHz 表示每个通道一秒有 16,000 个采样。我按硬件支持的双通道格式读，每个采样时刻选同一条物理输入，保存为单通道 16 位 PCM，便于后面的录制和语音识别。

**追问。5 秒 WAV 怎么算大小？** 80,000 个单通道样本，每个 2 字节，加上本代码写的 44 字节头，就是 160,044 字节。

[回到项目总览](#note/notes%2Fgsytrace-overview.md) · [继续 M2](#note/notes%2Fgsytrace-m2.md)
