<!-- notebook: {"version":1,"title":"GsyTrace M5 · RK3576 图注与逐帧溯源","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->
# GsyTrace M5 · RK3576 图注与逐帧溯源

[![M5 架构图。确认后的 M4 笔记定位原片和具体帧，RKNN 与 RKLLM 运行图注推理，再做独立回查和人工核对](assets/gsytrace/m5.png)](assets/gsytrace/m5.png)

[返回应用层导读](#note/notes%2Fgsytrace-overview.md) · [上一章 M4](#note/notes%2Fgsytrace-m4.md) · [下一章 M6](#note/notes%2Fgsytrace-m6.md)

在一段十秒钟的原片里，工程上要先回答「哪一帧应该出现在这个时刻」，随后才把那一帧交给模型。M5 的产物是一张帧图、它的原片来源，以及一条模型图注。这一章有两道验收，一道查来源能不能复现，另一道用眼睛看模型描述对不对。

## 从音频区间挑到一张画面

- **PTS**（Presentation Time Stamp，呈现时间戳）表示一帧预计呈现在什么时刻。容器记录的 PTS 常以整数 tick 表示。时间基 `time_base` 表示每一个 tick 是几秒。
- **NPU**（Neural Processing Unit，神经网络处理器）适合做模型中的矩阵运算。M5 复用板上已有 worker，这里指接收图像和提示词、返回文本的独立进程。GsyTrace 负责选帧、验证、调用和归档。
- **RKNN**（Rockchip Neural Network，瑞芯微神经网络模型与工具体系）在这里运行视觉编码模型。**RKLLM**（Rockchip Large Language Model，瑞芯微大语言模型运行环境）在这里生成文字。**VLM**（Vision-Language Model，视觉语言模型）把图像信息与文本提示结合起来。
- **PNG**（Portable Network Graphics，便携式网络图形）保存取出的一帧。**JSON**（JavaScript Object Notation，JavaScript 对象表示法）用文本保存结构化字段。这里的请求格式是一行一个 JSON 对象，称为 JSON Lines。

想象视频里当前保留一张画面，直到它的下一张到来。假设视频分片从录制的 20 秒开始，时间基是 `1/90000`，某帧的 PTS 是 4500。这帧从分片开始后 50 ms 显示，也就是整次录制的 20.050 s。目标时刻为 20.060 s，且下一帧还未到，选的就是这一帧。M5 的查找规则是取小于等于目标时间的最后一个 PTS。

```text
容器内的秒 = PTS × time_base
整轮时间 = 分片距会话开始的时间 + 容器内的秒
```

## 实施顺序和主要接口

### 1. 在 m5/frames.py 找正确的原片和画面

`locate()` 先从 M4 的 `review.sqlite3` 取已人工保存的音频笔记。对每个目标时刻检查它还落在这段音频的范围内，并在 M3 的 `hub.sqlite3` 找覆盖它的唯一视频分片。校验开机标识、录制开始时间、视频序号和 SHA-256。第三次还检查是仅口述操作，观察栏保持为空。

`select_frame()` 调 `ffprobe` 读视频的 `time_base` 与逐帧 `best_effort_timestamp`，用 Python 的 `Fraction` 保留分数计算，避免边界被浮点舍入移动。关键几行如下。目标时刻换算成分片内的微秒后，再除以每个 tick 的微秒数。

```python
unit_us = Fraction(stream["time_base"]) * 1_000_000
index = bisect_right(ticks, Fraction(target_us - segment_start_us) / unit_us) - 1
```

`decode_png()` 调 `ffmpeg` 的 `select` 滤镜提取 PNG。初次提图按解码序号 `n`，复核按 `pts`，随后对照 PNG 摘要。并排保留的 `source.json` 记录原片文件与摘要、源时间、帧序号、PTS、时间基和 PNG 摘要，便于把图注带回具体的一帧。

### 2. 在 m5/caption.py 检查板子，再调用已有 worker

`checked_runtime()` 读 `rk3576.lock.json`，检查板型、NPU 驱动、视觉模型、语言模型、worker 和两份运行库的 SHA-256。用 `ldd` 看动态链接实际上挑中哪份库。系统装过多份同名库时，文件存在与进程加载它是两项不同的检查。

`infer()` 通过 `subprocess.run()` 启动 worker，把一行 JSON 送给标准输入。worker 跑视觉编码和文本生成，Python 解析标准输出，要求只找到一条非空 `text`。执行有超时限制，完整 stdout 与 stderr 留在 `worker.log`。下面展示应用传的字段，图像路径用示例。

```json
{"image": "/path/to/frame.png", "prompt": "只描述这张静止图像中可见的外形。"}
```

`save_result()` 先写临时文件，再替换成 `caption.json`。结果保留模型输出、提示词、图像摘要、运行时锁摘要和来源记录。给同一张图换问法时，能查出究竟变了什么。

### 3. 先做控制图，再做三轮真实片段

控制图只有白底与红色方块。第一轮中文提示曾把红白关系答反。对照输入和日志后，明确用英文询问中央形状、中央颜色和背景颜色，通过了这个控制样例。真实图继续用静态画面提示，限制模型只描述可见细节。实际三帧的来源都通过重新提图验证。第一帧主要姿态相符，第二帧把握拳说成拿红色物体，第三帧给出了单帧无法支持的手指方向。原图和模型原文都留证，语义问题交给人来确认。

三轮逐帧回查中，目标时间与选中帧开始的差分别为 26.669、32.475 和 19.539 ms。这反映了离散视频帧的显示区间，换取样点时就会变化。

## 用 WSL 和 MobaXterm 跑通

WSL 端保留 M4 的 `sources.py`，M5 会直接导入它。以下在源码根目录执行，打包后用 MobaXterm SFTP 上传到 RK3576。解包到自己的练习目录，执行入口前确认仍有 `m4/` 和 `m5/` 两个同级目录。

```bash
python3 -m py_compile m5/caption.py m5/frames.py
tar -czf m5-src.tar.gz m4/sources.py m5
```

在 RK3576 上，用有权限读取板端 NPU 驱动信息和已配置模型的终端。先检查锁文件。原项目使用已验收 worker 与权重，锁文件里的路径需指向自己的板上资产。

```bash
tar -xzf m5-src.tar.gz
python3 m5/caption.py check
OUT="$(mktemp -d)"
python3 m5/caption.py control --out "$OUT"
```

通过时会打印几条 `OK` 摘要行，控制图的 `caption.json` 则包含 `"control_match": true`。用图像和文字互相对照一次。模型在实际介质上的输出可能随模型、运行库和提示变化。

## 验收一张控制图与三轮原片

随后准备 M4 验收目录，里面有 `review.sqlite3`、`hub.sqlite3` 和 `cache/`。在本地练习源码的 `m5/trials.json` 填入三轮会话、各自的 `audio_seq` 和从录制开始算起的 `target_us`。三个会话须不同，目标要落在已确认的音频笔记覆盖范围内。先用 `m4/sources.py check` 核对时间。下面的命令在 RK3576 运行。

```bash
read -r -p 'M4 验收目录的绝对路径 > ' M4_DATA
python3 m5/frames.py extract --m4 "$M4_DATA" --out "$OUT"
python3 m5/caption.py trials --out "$OUT"
python3 m5/frames.py verify --m4 "$M4_DATA" --out "$OUT"
```

预期有三行 `extract OK` 和三行 `verify OK`。每次用新的输出目录，以保留上一次控制图和三轮结果。最后人工逐条看 `frame.png` 与 `caption.json`。

## 开发中遇到的问题

| 现象 | 排查顺序 |
|---|---|
| 目标准确到某一秒，提图却偏了一截 | 看用的是会话相对时间还是 MP4 分片内的 PTS。用 `ffprobe` 查时间基，检查会话与分片的起点和目标的音频范围。 |
| 板上有同名运行库，worker 初始化仍失败 | 先用锁文件核对模型与驱动，再看 `ldd` 展示的实际加载路径和 `worker.log`。 |
| 控制图通过，真人画面说错物体或方向 | 回查帧摘要与 PTS 先确认输入。保存机器原文，人工标出可见事实。改提示词可以再做对照，验收时仍要区分链路通过和语义质量。 |

## 常见面试问法

### 1. 你怎么保证图注对应原视频的这一个时刻？

**口语答法**　先用 M4 的会话和音频范围找到 M3 中同一次录制，再选这个时间正在显示的那帧。图注旁留原片和输入图的摘要。

**追问**　为什么不用帧号除以帧率？

**答法**　帧可能间隔不完全一样，而且 MP4 分片的时钟从自己的起点算。以 PTS 和时间基换算实际显示时间，初次按帧序号取图，回查按 PTS 重新取图。

### 2. RKNN、RKLLM 和本项目的 Python 分别负责什么？

**口语答法**　视觉模型负责看图，语言模型负责生成一句话。板上的 worker 调运行库做推理，GsyTrace 的 Python 把正确的图送进去并记录证据。

**追问**　为什么要锁 worker 和运行库的摘要？

**答法**　权重相同，加载了另一个运行库仍可能不兼容或改变行为。记录一整组已验收的文件，配合 `ldd` 能确认实际用的是那套依赖。

### 3. 控制图正确可以说明图注可靠吗？

**口语答法**　它说明那一张已知答案的图成功经过模型链路。真实录像要回到输入帧人工判断。我会介绍三帧的验证方法，也会说清第二帧和第三帧中的语义问题。

**追问**　怎么证明「手往右移动」？

**答法**　要看同一会话中前后时刻的多帧，先约定相机坐标的左右，再对照轨迹。单帧能观察手的位置与外形。
