<!-- notebook: {"version":1,"title":"GsyTrace M3 · 双板同步与原片断点续传","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->
# GsyTrace M3 · 双板同步与原片断点续传

[![M3 双板架构图。RV1106 先录制到 SD，再经两个 WebSocket 路由同步清单和按需传送原片，RK3576 分别存入 SQLite 和文件缓存。](assets/gsytrace/m3.png)](assets/gsytrace/m3.png)

[项目总览](#note/notes%2Fgsytrace-overview.md) · [上一篇 M2](#note/notes%2Fgsytrace-m2.md) · [下一篇 M4](#note/notes%2Fgsytrace-m4.md)

## 双板上，各自做哪件事

RV1106 是采集端，资料先写在 SD 上。RK3576 是 **Hub（汇聚节点）**，它先把清单登记进 SQLite，知道每个会话有哪些声音和画面。需要做转写、图注或回放时，Hub 再索取指定片段。断网期间，RV1106 仍可在本地采集和完成会话。应用分开处理录制 I/O（Input/Output，输入/输出）和网络上传。

**WebSocket** 提供一条可以双向发送消息的连接。这里从 **HTTP（Hypertext Transfer Protocol，超文本传输协议）**升级为 WebSocket 后，应用再交换自己的 `hello` 和 `hello_ack`。两个路由分别叫 `/sync` 与 `/originals`。 `/sync` 同步索引， `/originals` 运送真正的 MP4 或 WAV 字节。 **ACK（Acknowledgement，确认回执）**由应用给出，每种 ACK 的含义都要结合对应操作看。源码使用包名 `websockets` 的 Python 库及 C++ 的 Asio 与 WebSocket++。

## 第一段 · 从 SD 读出一份可提交的清单

在 `m3/catalog.cpp` 找入口 `load_catalog()`。先读 M2 的 `session.json`，确认会话路径、版本、状态及时间字段正确。之后逐行读 `segments.jsonl`，检查文件名符合轨道和编号、分片条目没有重复、完成会话有实际片段。 `m3-catalog` 是检查清单的小工具。 **UUID（Universally Unique Identifier，通用唯一标识符）**在这里标记会话，路径的最后一级就是这个会话标识，提交时配上设备编号。

`m3/edge_sync.cpp` 中的 `make_upload()` 将清单组织成包含 `v`、`type`、`session`、`segments` 的消息。网络复用入口在 `m3/edge_peer.cpp` 的 `run_edge()`。它先发 `hello` 并验证回执中的设备号，再发 `manifest.put`，等 `manifest.ack` 确认设备、会话和分片数量。 `m3-hello` 只跑握手，适合遇到连接问题时先测一层。

握手消息长这样。末尾的 `device_id` 是示例，真实操作时两板应使用同一个设备编号。

```json
{"v":1,"type":"hello","device_id":"edge-demo"}
```

`m3-sync --watch` 定期寻找已经 `complete` 的新会话。发送失败按 1、2、4、8、15 秒退避，后面最多等 15 秒。进程用内存集合记住本次已经确认的会话。Watch 重启会重扫 SD，有机会重复提交，下一段的 Hub 幂等规则负责保证落库结果一致。

## 第二段 · SQLite 提交成功以后再回执

在 `m3/hub.py` 看 `handle()` 如何区分两个 WebSocket 路由， `validate_manifest()` 怎样验证消息。随后 `receive_manifest()` 把数据库事务交给 `m3/store.py` 的 `store_manifest()`，调用完成以后发送应用回执。

**SQLite** 是嵌入式数据库，数据保存在本地数据库文件里。 **SQL（Structured Query Language，结构化查询语言）**负责查找和写入记录。数据库中，会话唯一键是 `(device_id, session_id)`，片段唯一键加上 `track, seq`。因此视频 0 和音频 0 各有一行。

| 关键动作 | 对初学者意味着什么 |
|---|---|
| `sqlite3.connect()`、`PRAGMA foreign_keys = ON` | 打开库并让数据库检查分片归属 |
| `BEGIN IMMEDIATE` | 开启写事务，写入过程有明确的竞争边界 |
| `execute()`、`executemany()` | 插入会话和整批片段，或者读取已有内容做一致性比较 |
| `commit()` 后 `ws.send()` | 清单提交成功才回复 `manifest.ack` |
| 异常时 `rollback()` | 撤销未成功提交的事务 |

第一次成功写入，回执 `result=stored`。同一设备、同一会话再次提交相同内容，回执 `already_present`，记录数量保持不变。同一个键下出现不同字段或摘要，Hub 拒绝并记录 `MANIFEST_CONFLICT`。这种“同样的请求再做一次，数据库仍是同一份结果”的性质叫**幂等（idempotence）**。

假设 Hub 已经提交，但断网令 ACK 没到采集端。采集端按计划重发，Hub 查到原记录并对照每个字段，返回 `already_present`。这里传输的分片摘要成为后续原片校验依据。清单 ACK 说明索引进库，查看媒体实际状态要继续检查原片任务。

## 第三段 · 需要哪一片，就请求哪一片

[![M3 原片状态图。Hub 给出已落盘 offset，发送端按 offset 继续分块，收齐并核验 SHA-256 后用原子改名发布正式文件。](assets/gsytrace/m3-originals.png)](assets/gsytrace/m3-originals.png)

`m3/original_receiver.py` 的请求命令把一项分片放入 `original_jobs`。Hub 按设备取待完成任务，交给 `OriginalReceiver.transfer()`。 `m3/original_sender.cpp` 读本地 SD 上的对应片段，从指定字节位置读取并发送。

```text
原片请求 → 确认起始位置 → 推送带字节偏移的二进制块
        → 追加 .part + fsync → chunk_ack → 下一个块
        → 收到结束消息 → 验证总字节数与 SHA-256
        → os.replace 改为正式文件名 → 文件夹 fsync → 任务 ready → original.ack
```

每条二进制消息以前 **8 字节大端偏移量**开头，表示后面数据在原文件里的起始字节号，后面最多跟 65,536 字节，即 **64 KiB（kibibytes，每 KiB 为 1,024 字节）**。大端（big endian）表示多字节数字先发最高有效字节。 `original.chunk_ack` 回传下一次期待的偏移。Hub 只接收当前准确的偏移和合理的长度，写入 `.part` 并通过 `os.fsync()` 请求同步以后才回每块确认。

传输断开后，保留 `.part`。下一次 Hub 以实际的 `.part` 长度决定从哪继续。全文件收齐后比较清单中的字节数与 **SHA-256（Secure Hash Algorithm 256-bit，256 位安全哈希算法）**，通过后才以 `os.replace()` 发布正式文件。完整缓存也会重新比大小和摘要，正确时输出 `CACHE_HIT`。 `asyncio.wait_for()` 给收包设定时限，避免一直等不到回复。每台设备的原片路由同时只服务一条活跃连接，减少两次请求同时往一个暂存文件写的机会。

## 第四段 · WSL 构建，MobaXterm 上板验证

在 WSL 设好 M0 的 `SDK`、`TC`。 `ASIO` 指到包含 `asio.hpp` 的目录，项目用 Standalone Asio 1.28.0。RV 侧代码配置在 `m3/m3.cmake`。把 C++ 编译器也显式传给 CMake，四个程序才使用同一套目标板工具链。

```sh
cd ~/GsyTrace
ASIO=/path/to/asio/include
cmake -S . -B build/m3-rv1106 \
  -DCMAKE_TOOLCHAIN_FILE="$PWD/cmake/rv1106-toolchain.cmake" \
  -DCMAKE_C_COMPILER="$TC-gcc" -DCMAKE_CXX_COMPILER="$TC-g++" \
  -DGSY_SDK_ROOT="$SDK" -DGSY_ASIO_INCLUDE="$ASIO" -DGSY_BUILD_M3=ON
cmake --build build/m3-rv1106 --target m3-hello m3-catalog m3-sync m3-originals
wslpath -w "$PWD/build/m3-rv1106"
```

用 MobaXterm 将四个 ELF（Executable and Linkable Format，可执行与可链接格式）传到 RV1106 的练习目录，将 `m3/` 的 Python 文件及 `requirements.txt` 传到 RK3576。练习建议使用独立的目录、数据库与端口。示例 `192.0.2.10` 属于文档地址，请在两端改用 RK3576 实际实验网卡地址。下面展示独立 M3 运行方式，M7 正式包的离线依赖和服务单元另见发布笔记。

**RK3576 的第一个 SSH 标签。** 这里假设已经为试验目录准备 Python 虚拟环境 `.venv`，并按 `m3/requirements.txt` 安装固定的 `websockets==13.1`。用 `import websockets` 检查库和当前 Python 能否搭配。

```sh
HUB=192.0.2.10
PORT=18765
.venv/bin/python -c 'import websockets; print(websockets.__version__)'
.venv/bin/python -u m3/hub.py --host "$HUB" --port "$PORT" \
  --db ./m3.sqlite3 --cache ./cache
```

**RV1106 标签。** 在四个程序所在目录执行。 `SID` 用 M2 已完成会话目录里的标识替换。为测试重发，用同一个会话执行两次单次提交，预期分别出现 `stored` 和 `already_present`。固定的 `m3-hello` 与目录检查能帮助分清握手、清单文件和数据库三种问题。

```sh
HUB=192.0.2.10
PORT=18765
DEVICE=edge-demo
ROOT=/mnt/sdcard/gsytrace-m2
SID=替换成已完成会话的UUID
chmod +x m3-hello m3-catalog m3-sync m3-originals
./m3-hello "ws://$HUB:$PORT/sync" "$DEVICE"
./m3-catalog "$ROOT/$SID"
./m3-sync "ws://$HUB:$PORT/sync" "$DEVICE" "$ROOT/$SID"
./m3-sync "ws://$HUB:$PORT/sync" "$DEVICE" "$ROOT/$SID"
```

要测自动补交，把上面的单次提交换成 `--watch`，让它在单独的 SSH 标签持续运行。开始一段新录制，在录制期间有计划地让 Hub 暂时不可用，或让采集端断开实验 Wi-Fi。保留 USB（Universal Serial Bus，通用串行总线）管理连接，待录制结束后确认 SD 上的会话已正常收尾。恢复网络后看同一会话是否自动收到 `MANIFEST_ACK`。

```sh
./m3-sync --watch "ws://$HUB:$PORT/sync" "$DEVICE" "$ROOT"
```

另一个 RV 标签启动原片发送端。它可以在采集和目录同步之外独立运行。

```sh
./m3-originals "ws://$HUB:$PORT/originals" "$DEVICE" "$ROOT"
```

**RK3576 的第二个 SSH 标签。** 进入 Hub 同一个试验目录，设置刚才用过的 `DEVICE` 和 `SID`。先查清单，再请求第 0 段视频，再查任务。第一次 `status` 可能仍是 `pending`。看到 Hub 的 `ORIGINAL_READY` 以后重查，应该变成 `ready`。

```sh
.venv/bin/python m3/check_db.py --db ./m3.sqlite3 "$DEVICE" "$SID"
.venv/bin/python m3/original_receiver.py --db ./m3.sqlite3 --cache ./cache \
  request "$DEVICE" "$SID" video 0
.venv/bin/python m3/original_receiver.py --db ./m3.sqlite3 --cache ./cache \
  status "$DEVICE" "$SID" video 0
sha256sum "./cache/$DEVICE/$SID/video-000000.mp4"
ffmpeg -v error -xerror -i "./cache/$DEVICE/$SID/video-000000.mp4" -f null -
```

测试第 0 段声音时，改用参数 `audio 0` 和文件 `audio-000000.wav`。最后重启本次试验的 Hub，复用数据库和缓存，重查记录、任务以及缓存文件的字节数和摘要。不要重启其他环境的服务。

## 开发中碰到的坑与实测过关线

- **断录制网络和断原片连接要分别验证。** 前一项在录制中断开采集端 Wi-Fi，要求 SD 完成，并在恢复后自动提交。后一项在新建的隔离 Hub 上用 `--drop-once-after 131072` 做一次故障注入，要求部分文件留存，随后从 131,072 字节继续。这个参数用于验收，正式 Hub 正常启动时不带它。
- **能连接也能握手，Hub 却没收到会话。** 先用 `m3-catalog` 看是否 `complete`。如果日志有 `MANIFEST_RETRY`，看两板连接与退避。如果出现 `MANIFEST_CONFLICT`，对比同一键的两份清单，先留证再修正原数据。人工改字段上报可能让前后的数据对不上。
- **文件存在，但状态没到 ready。** 查看缓存目录里的 `.part`、轮询任务并核对预期长度。文件名发布与 SQLite 状态是两步，中间掉电后，可用现有完整文件重新校验并确认。
- **同样上传了两次，如何证明没有重复？** 对同一个会话打印有序的分片清单，看行数、时间、字节数和摘要。重启 Hub 后再查一次。比单看“成功”日志更容易发现差异。

M3.3 的隔离试验中，Hub 不可用时，RV 仍录完整一段约 40 秒的素材，视频包为 1,200/1,200、音频样本为 638,080/638,080。Hub 恢复后，同一 Watch 进程补上 1 个会话和 8 个片段，重复提交行数不变。M3.5 的双板试验另外实测 Wi-Fi 断开与恢复后自动补交，拿到 1 个会话和 7 个片段。原片的故障注入从 0 字节传到 131,072 字节后断开，再从该偏移恢复，最后验证 4,517,830 字节的 MP4 和 320,044 字节的 WAV 可解码、摘要相符。重复提交、Hub 进程重启后，SQLite 清单与已验收缓存仍保持一致。源码里程碑是 `d35c267`。

## 常见面试问法

### 为什么要先把清单写进 SQLite 再发送 ACK？

**可以这样答。** 采集端收到回执以后会记为已提交，所以 Hub 必须先把会话和所有分片放进同一事务并返回成功，再给回执。事务遇到异常会回滚，采集端之后可以重试。

**追问。数据库提交了，ACK 在网络上丢了怎么办？** 采集端仍会重发。Hub 按设备和会话查已有记录，相同内容返回 `already_present`，数据只有一份。相同键内容变了就拒绝，以免旧证据被悄悄覆盖。

### 为什么要传字节偏移？已经用 WebSocket 了还不够吗？

**可以这样答。** WebSocket 负责在当前连接里传消息。连接断开以后，新连接还得知道之前哪些字节已经在 Hub 上存好。我们按 `.part` 长度报告偏移，每块还带自己的偏移，在写入并同步后回确认。结束时验证全长与 SHA-256，保证拼回正确的原文件。

**追问。要如何证明真的续传了？** 观察首次 `ORIGINAL_REQUEST offset=0`、故障时暂存长度、重新请求是否为 131072，以及最后的 `ORIGINAL_READY`。再用清单摘要和解码器确认数据。

### 为什么清单和原片走两条路由？

**可以这样答。** 清单小，先同步能迅速建立检索索引。原片大，Hub 根据复盘、图注或回放需要选择片段。RV 即使断网也能录完。两个入口可以各自观察失败和进度。

**追问。SHA-256 校验能认证设备吗？** 它验证收到的内容与清单摘要是否一致。设备认证需要能验证发送方身份的机制。这里的 1.0 连接用于受控实验局域网，握手设备号用于关联设备记录。

[回到项目总览](#note/notes%2Fgsytrace-overview.md) · [继续 M4](#note/notes%2Fgsytrace-m4.md)
