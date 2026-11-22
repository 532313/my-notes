<!-- notebook: {"version":1,"title":"GsyTrace M4 · 口述复盘与原片溯源","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->
# GsyTrace M4 · 口述复盘与原片溯源

[![M4 架构图。M3 清单和原件进入 RK3576 的语音识别与复盘库，再进入网页校正和离线报告](assets/gsytrace/m4.png)](assets/gsytrace/m4.png)

[返回应用层导读](#note/notes%2Fgsytrace-overview.md) · [上一章 M3](#note/notes%2Fgsytrace-m3.md) · [下一章 M5](#note/notes%2Fgsytrace-m5.md)

录完一次实验后，你想找回当时说的话，还想点一下就听到原声、找到同一时段的画面。M4 把这些动作接起来。RV1106 按 M2 的方式录制，M3 让 RK3576 拿到清单和原件。RK3576 在本地识别口述，写进复盘库。最后，用浏览器回听、校正、导出。试着沿图走一遍，一段声音经过了哪些程序，校正后的文字又存在哪里？

## 先认清原件、清单和复盘库

- **WAV**（Waveform Audio File Format，波形音频文件格式）是存放声音的容器。项目中的 WAV 里装着 16 kHz、单声道、16 位的小端 **PCM**（Pulse-Code Modulation，脉冲编码调制）。直观上，每秒记 16,000 个声音幅度，每个样本占 2 字节。
- **ASR**（Automatic Speech Recognition，自动语音识别）把语音变成文字。SenseVoice 做这一步。本项目通过 sherpa-onnx 在 RK3576 的 **CPU**（Central Processing Unit，中央处理器）上离线执行。
- **VAD**（Voice Activity Detection，语音活动检测）负责找出哪里有人声。Silero VAD 先划出区间，SenseVoice 再读这些区间。在 16 kHz 下，512 个样本相当于 32 ms。
- **SID**（Session ID，会话标识）把一次开始到停止之间的记录串起来。同一块板还有多次开机，因此来源记录同时保留 `boot_id`。**SHA-256**（Secure Hash Algorithm 256-bit，256 位安全哈希算法）是文件字节的摘要。文件名相同，仍要校验大小和摘要。

可以把 M3 库理解成原件登记簿，把 M4 库理解成读过原件之后写下来的笔记。程序用实际分片时间找关联。举个例子，一段音频占 `[18, 28)` 秒，视频切在第 22 秒，复盘页就会列出两份相关视频。两个区间只在端点接触时，交集为空。

```text
有交集 = 音频开始 < 视频结束，并且视频开始 < 音频结束
相对时间 = 源分片的单调时钟时间 − 这轮录制的开始时间
```

## 实施顺序和主要接口

### 1. 在 m4/asr.py 读 WAV、检测人声、转写

`SenseVoice.transcribe_regions()` 先检查格式和长度，随后用 `numpy.frombuffer(..., dtype="<i2")` 把二进制读成小端有符号 16 位整数。把样本除以 32768 后得到模型使用的浮点数。核心调用顺序如下，省略了输入验证和切片边界。

```python
vad.reset()
for window in windows:
    vad.accept_waveform(window)
vad.flush()

while not vad.empty():
    region = vad.front
    start = max(0, region.start)
    end = min(len(samples), region.start + len(region.samples))
    vad.pop()
    if start < end:
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, samples[start:end])
        recognizer.decode_stream(stream)
        print(stream.result.text)
```

实际代码会在末尾补齐窗口、再补一个窗口，并把推理区间裁回真实 WAV 的样本范围。`transcribe_regions()` 能给出检测区间起止样本，`transcribe()` 把有文本的区间拼起来。复盘页保存和显示的来源范围来自 WAV 分片本身。口述跨分片时，需要逐个回听确认。逐字定位还要另做时间对齐。

### 2. 在 m4/sources.py 验原件，在 m4/prepare.py 写复盘库

| 从哪里读 | 主要函数 | 接口做的事 |
|---|---|---|
| M3 的 SQLite 库和原件缓存 | `manifest()`、`verified_sources()` | 核对会话完结、分片顺序、文件大小、SHA-256 和媒体格式 |
| 一个音频区间 | `overlapping_videos()` | 用原始微秒判断相交，转换成可展示时间放在后面 |
| M3 的原件任务 | `prepare.py fetch` | 用 `original_receiver.py` 的 `request` / `status` 等待 `ready` |
| 音频和视频原件 | `prepare.py ingest`、`split_roles()` | 保留机器原文，把有明确口述线索的内容分到操作和观察 |

`ingest()` 先算来源指纹，将来源、草稿与画面关系在一次 SQLite 事务中写入。这里的事务相当于一个完整提交，几张相关表一起成功才算这一轮写完。相同会话和指纹再次导入显示 `ALREADY_IMPORTED`，此前人工校正保留。如果相同会话换了缓存路径、标题、模式或来源，程序会提示不一致。

### 3. 在 m4/review.py 让浏览器回听和校正

`ReviewHandler.do_GET()` 提供复盘页、`/audio/<seq>` 和 `/video/<seq>`。`do_POST()` 处理 `/save/<seq>`，`seq` 是分片序号。每次成功保存，`revision` 加一。用两个浏览器标签同时打开同一条笔记时，后提交的旧页面会收到 **HTTP**（Hypertext Transfer Protocol，超文本传输协议）409，意思是当前版本已变。

```sql
UPDATE notes
SET corrected_text = ?, operation = ?, observation = ?, revision = revision + 1
WHERE session_id = ? AND seq = ? AND revision = ?;
```

导出时把 WAV 通过 Base64 编码嵌入 **HTML**（HyperText Markup Language，超文本标记语言）。把一份 HTML 拿走就能回听原声。视频在报告中保留文件名、时间和摘要，通过记录回查原 MP4。

## 用 WSL 和 MobaXterm 跑通一轮

WSL（Windows Subsystem for Linux，适用于 Linux 的 Windows 子系统）中进入源码目录。先检查 Python 语法，打包四个文件。通过 MobaXterm 的 **SFTP**（SSH File Transfer Protocol，SSH 文件传输协议）上传到 RK3576。这里的 SSH 是 Secure Shell，安全远程登录。

```bash
python3 -m py_compile m4/asr.py m4/sources.py m4/prepare.py m4/review.py
tar -czf m4-src.tar.gz -C . m4
```

在 RK3576 的 GsyTrace 练习目录解包，保留该目录下用于 M3 的代码目录。先确保 M3 Hub 和 RV1106 的原件发送端正常。下面按提示输入本机的模型环境 Python、模型配置、清单库、缓存和会话。模型环境需能导入 `numpy` 与 `sherpa_onnx`。路径请用绝对路径。设置复盘目录后，跟着执行命令。

```bash
tar -xzf m4-src.tar.gz
read -r -p 'SenseVoice 模型环境中的 Python 路径 > ' ASR_PY
read -r -p '模型配置 JSON 的绝对路径 > ' ASR_CONFIG
read -r -p 'M3 使用的 Python 路径 > ' M3_PY
read -r -p 'M3 清单数据库的绝对路径 > ' HUB_DB
read -r -p 'M3 缓存目录的绝对路径 > ' CACHE
read -r -p '录制结束后得到的会话标识 > ' SID
REVIEW_DB="$PWD/review.sqlite3"
"$ASR_PY" m4/prepare.py fetch --m3 "$HUB_DB" --cache "$CACHE" --sid "$SID" \
  --receiver "$PWD/m3/original_receiver.py" --m3-python "$M3_PY"
"$ASR_PY" m4/prepare.py ingest --m3 "$HUB_DB" --cache "$CACHE" --sid "$SID" \
  --db "$REVIEW_DB" --label '第一次实验' --mode normal --config "$ASR_CONFIG"
"$ASR_PY" m4/review.py serve --db "$REVIEW_DB" --session "$SID" --port 8766
```

如果所在目录只打包了 `m4/`，把 `--receiver` 改为已部署的 `m3/original_receiver.py` 的绝对路径。这时要看到每条原件有 `READY`，识别有 `ASR` 日志，入库有 `IMPORTED`。浏览器通过 MobaXterm 的本地端口转发访问 `http://127.0.0.1:8766/`。转发的远端主机也填 `127.0.0.1`，远端端口为 `8766`，SSH 服务器填自己的 RK3576 地址。校正后刷新，文本和版本号都应该保留。

## 验收三轮口述并回听离线报告

正式验收分别做两次 `normal` 和一次 `spoken_only`，每轮使用自己的 SID。第三轮只口述操作，观察栏保留空白。三轮完成后，校正网页可先用 Ctrl+C 停止，再执行以下命令。三行输入依次对应两次普通记录和一次仅操作记录。

```bash
read -r -p '第一次 SID > ' S1
read -r -p '第二次 SID > ' S2
read -r -p '第三次 SID > ' S3
"$ASR_PY" m4/prepare.py verify --db "$REVIEW_DB" "$S1" "$S2" "$S3"
REPORT="$PWD/m4-report-$(date +%Y%m%d-%H%M%S).html"
"$ASR_PY" m4/review.py export --db "$REVIEW_DB" \
  --session "$S1" --session "$S2" --session "$S3" --out "$REPORT"
sha256sum "$REPORT"
```

把报告用 SFTP 下载，在断开校正隧道后打开回听。此前三轮实测分别有 9、9、4 个音频分片。重复导入仍保留人工修订，离线报告中的 WAV 经摘要核对，第三轮观察显示「未记录」。

## 开发中遇到的问题

| 表现 | 怎么确认和处理 |
|---|---|
| 整轮转写为空 | 先直接播放 WAV，再跑一段已知口述作控制。检查 RV1106 选中的麦克风声道、音量和人声长度。静音尾片可以为空。实测曾遇到现场原声识别为空，后来用三轮清楚口述单独验收。 |
| WAV 或 MP4 在下一序号处突然缺失 | 查 M3 库里的原件状态。已有样例曾只缓存第一片，M4 在 audio-000001.wav 处拒绝导入。运行 `fetch` 并等待完整 `READY` 后重试。 |
| 保存遇到 409 | 保留自己正在编辑的文字，刷新页面读出新版本，对照新内容后重新保存。 |
| 导出后点不到原视频 | 在线校正页可以播放缓存 MP4。离线报告可回听 WAV，利用原件编号、时间和摘要定位视频。 |

## 常见面试问法

### 1. VAD 和 ASR 分别做什么？

**口语答法**　VAD 相当于在录音上圈出有人说话的地方，ASR 才把圈里的声音写成文字。项目先让 Silero 按窗口找人声，再把每段交给 SenseVoice。

**追问**　为什么末尾要补窗和 `flush()`？

**答法**　识别器要看一段上下文才能确认边界。文件结束后补齐输入，再显式交出最后还在缓冲中的人声区间。切片边界最后收回到原始样本长度。

### 2. 一句话怎么关联到当时的画面？

**口语答法**　用会话和开机标识认出同一条录制，再比较原始音频分片和视频分片的时间区间。有交集的原视频都保留，之后能按时间和摘要回查。

**追问**　仅凭这个页面能否给一个字标出精确帧？

**答法**　页面存的是音频分片范围，区间内有多个帧。逐字对齐需要额外的时间标注能力和独立验证。

### 3. 重跑识别会怎样处理人工校正？

**口语答法**　同一个来源指纹已入库时，程序直接报告已经导入。机器原文和人工改写分开存。网页用版本号判断这次保存读的是哪一版内容。

**追问**　两个标签同时保存会发生什么？

**答法**　先提交成功的记录把版本号加一。后一个请求带旧版本号，条件更新影响零行，网页收到 409，就该刷新后核对。
