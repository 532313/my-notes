<!-- notebook: {"version":1,"title":"GsyTrace M7 · 双板发布与实测回滚","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->
# GsyTrace M7 · 双板发布与实测回滚

[![M7 发布架构图。WSL 干净检出生成两种应用包，双板经安装校验和 current 链接切换版本，业务数据在版本目录外保留](assets/gsytrace/m7.png)](assets/gsytrace/m7.png)

[返回应用层导读](#note/notes%2Fgsytrace-overview.md) · [上一章 M6](#note/notes%2Fgsytrace-m6.md)

开发目录里的程序能跑，是第一步。M7 要做到的是让别人拿到同一提交和同一套外部工具链，也能构建出相同应用包。部署时要能确认板上正在跑哪个版本，出问题时还能回到已经验过的旧版。图里从左向右看，前半段在 WSL 做，后半段分别在 RV1106 和 RK3576 做。

## 先理解三个容易混淆的动作

| 动作 | 本项目怎么做 | 可以用什么核对 |
|---|---|---|
| 构建 | 用指定 Git 提交、交叉编译器和依赖生成两个归档 | Git 提交、`build-inputs.log`、`elf.log`、归档 SHA-256 |
| 安装 | 解包到临时目录，按文件验证摘要后放入 `releases/<version>/` | 文件权限、`ROLE`、`RELEASE`、`FILES.sha256` |
| 激活或回滚 | 停旧进程，切换 `current` 链接，启动目标版本并体检 | `readlink`、实际进程路径、`m2-ctl --version`、systemd 状态及握手 |

**RC**（Release Candidate，候选发布版）是正式版前先部署验证的版本。第一次发正式版时，先验收 RC1，再把它留作回滚点。**ELF**（Executable and Linkable Format，可执行与可链接格式）是 Linux 应用二进制格式。**ABI**（Application Binary Interface，应用二进制接口）约定了可执行文件怎样与处理器、加载器和库对接。**SHA-256**（Secure Hash Algorithm 256-bit，256 位安全哈希算法）为相同文件内容算出相同摘要，可以用来确认传输及归档一致。

这次交付的是两套应用。RV1106 使用的是现有固件的 Rockchip 媒体库、ALSA 和 uClibc。RK3576 的 systemd 服务管理 M3 同步与 M6 回放。M4 转写和 M5 图注的源码随 RK 包保存，推理按需调用已经配置的模型与运行时。整个流程在应用层发布。

## 实施顺序、文件和接口

### 1. 用 m7/build 在 WSL 从干净检出打包

`m7/VERSION` 决定归档名和板上版本目录。`m7/build` 使用 `git status --porcelain` 检查是否干净，`git rev-parse HEAD` 记录提交，再调用 `cmake -S ... -B ...` 与 `cmake --build` 两次。RV 包编六个录制与同步目标，再编 M6 播放器一共七个 ELF。RK 包保存 Python 源码和已验摘要的离线 WebSocket 库。根 `CMakeLists.txt` 传入 `GSY_RELEASE_ID`，`m2/m2_ctl.c` 的 `--version` 会打印版本加提交号。

重建结果可能受到目录名、打包时间和文件顺序影响。脚本用 `-ffile-prefix-map` 归一化路径，`SOURCE_DATE_EPOCH` 取 Git 提交时间，再用 `tar --sort=name --mtime=...` 固定归档内容顺序及时间，`gzip -n` 固定外层压缩元信息。工具链、媒体库、本地 LVGL 和 Asio 的输入也记录进构建日志。重建对比针对同一锁定环境。

### 2. 用 m7/install-release 验证包并落盘

板端脚本用 `uname -m` 判断架构，核对归档角色及文件名，然后对照 WSL 记录的摘要。`gunzip -c` 解开压缩层，`tar xf -` 展开内容。内层 `sha256sum -c FILES.sha256` 过了才用 `mv -T` 放进正式版本目录。已有同名版本时，脚本会比较清单及现存文件。两个板始终保留独立的归档名和角色。

```text
/opt/gsytrace/
├─ current -> /opt/gsytrace/releases/1.0.0
└─ releases/
   ├─ 1.0.0-rc1/
   └─ 1.0.0/
```

RV 的录制数据继续在 SD 卡会话目录。RK 的 SQLite 清单与原件缓存继续在 `/var/lib/gsytrace`。把应用程序和状态各自放在明确位置，切换应用版本时同一份业务记录还能读到。

### 3. 用 m7/use-release 切换，把两块板拉起来

脚本先用 `flock -x` 抢占一个独占锁，避免两次切换交叉执行。再校验目标完整性，在安全状态下停止旧实例。创建一个临时符号链接后用 `mv -fT` 替换 `current`。这一步对目录项的替换是原子的，切换之后再启动并检查新版本。启动失败时尝试切回此前的版本。

- **RV1106 上的 `m7/rv-app`**。子命令 `start`、`stop`、`status`、`play`、`screen` 控制录制服务、M3 同步、原片发送和小屏。发送停止信号前，用进程标识和 `/proc/<pid>/exe` 确认进程身份。切换前录制必须为 `IDLE`。如果还在录制，先结束、等文件收尾，再执行切换。
- **RK3576 上的 `m7/gsytrace@.service` 与 `m7/hub-start`**。模板中 `%i` 分别传入 `sync` 和 `playback`。systemd 管理进程、日志、异常重启和状态目录。发布脚本调用 `systemctl daemon-reload`、`systemctl start`、`systemctl is-active`，再用 `hub-check.py` 确认 M3 能真实回应 `hello_ack`、M6 HTTP 路由能访问。回滚验收再做真正的 `/clip` 请求。

## 照着做一次可验证的发布

### 第一步　WSL 中单独检出并构建

进入 WSL 的 GsyTrace Git 仓库，准备好 M0 的 SDK、已验证的 LVGL 源码和 M3 的 Asio 头文件目录。遇到输入提示时填写绝对路径。教程中用独立临时目录保存这次输出，保留原工作区。

```bash
REPO="$PWD"
WORK="$(mktemp -d)"
read -r -p 'RV1106 SDK 绝对路径 > ' GSY_SDK_ROOT
read -r -p 'LVGL 源码绝对路径 > ' GSY_LVGL_ROOT
read -r -p '含 asio.hpp 的目录绝对路径 > ' GSY_ASIO_INCLUDE
export GSY_SDK_ROOT GSY_LVGL_ROOT GSY_ASIO_INCLUDE

git clone --no-local "$REPO" "$WORK/source-a"
git clone --no-local "$REPO" "$WORK/source-b"
git -C "$WORK/source-a" checkout --detach v1.0.0
git -C "$WORK/source-b" checkout --detach v1.0.0
git -C "$WORK/source-a" status --porcelain --untracked-files=all
git -C "$WORK/source-a" rev-parse HEAD
```

执行构建时，要先进入对应检出，脚本用当前目录找 Git 根。下面用两个同提交的干净检出构建。把输出目录作为参数传入。

```bash
(cd "$WORK/source-a" && ./m7/build "$WORK/package-a")
(cd "$WORK/source-b" && ./m7/build "$WORK/package-b")
diff -u "$WORK/package-a/SHA256SUMS" "$WORK/package-b/SHA256SUMS"
(cd "$WORK/package-a" && sha256sum -c SHA256SUMS)
```

相同摘要时 `diff` 没有输出，`sha256sum -c` 逐个显示 `OK`。两份正式包应含 `gsytrace-rv1106-1.0.0.tar.gz` 和 `gsytrace-rk3576-1.0.0.tar.gz`。候选包用同样的流程，检出 `v1.0.0-rc1` 后另选输出目录。每次打包都读提交里的版本号。

### 第二步　MobaXterm SFTP 上传，先验后装

RV 只上传名字带 `rv1106` 的两版包，RK 上传带 `rk3576` 的两版包。两板各上传一份源码中的 `m7/install-release`。把对应版本的摘要记录从 WSL 一起带上。进入板端收到文件的目录，用有安装权限的用户执行。已有部署时，确认已配好的板端服务地址和短片会话配置。首次配置时可在 RK 的 `/etc/gsytrace/hub.conf` 填 `HOST`、`PLAY_SESSION`、`PLAY_START_MS` 和 `PLAY_SECONDS`，在 RV 的 `/etc/gsytrace/edge.conf` 填 `HOST`。赋值使用简单的 `NAME=value` 格式，`HOST` 填自己 RK 的实际局域网 IPv4。默认同步和回放端口分别为 `18865` 和 `18878`。

```bash
printf '本板角色 rv1106 或 rk3576 > '
read -r ROLE
printf '从 WSL 记录复制本板 RC1 包 SHA-256 > '
read -r RC_SHA
printf '从 WSL 记录复制本板正式包 SHA-256 > '
read -r FINAL_SHA
sh install-release 1.0.0-rc1 "$RC_SHA" "gsytrace-$ROLE-1.0.0-rc1.tar.gz"
sh install-release 1.0.0 "$FINAL_SHA" "gsytrace-$ROLE-1.0.0.tar.gz"
```

预期两次都打印 `INSTALLED`。确保没有现场录制时，先在 RK、再在 RV 激活 RC1。`use-release` 指向它所在的那个版本。每次激活后等两板跑在同一版，再做数据对比。

```bash
/opt/gsytrace/releases/1.0.0-rc1/use-release
```

RV 在自己的终端查看状态。RK 在自己的终端查看两个服务是否活着。

```bash
# RV1106
/opt/gsytrace/current/rv-app status
/opt/gsytrace/current/bin/m2-ctl --version

# RK3576
systemctl is-active gsytrace@sync.service gsytrace@playback.service
journalctl -u gsytrace@sync -u gsytrace@playback -n 30 --no-pager
```

### 第三步　实板验收升级、回滚和恢复

每组按 RK 后 RV 的顺序跑同一条命令，两个板都切完再采样。先记录 RC1 基线，再切正式版，接着回到 RC1，最后恢复正式版。四个阶段保存成不同日志。

```bash
# 两块板分别执行这一组，验完后再执行下一组
/opt/gsytrace/releases/1.0.0/use-release

# 同一顺序回到 RC1
/opt/gsytrace/releases/1.0.0-rc1/use-release

# 验完 RC1 后再恢复正式版
/opt/gsytrace/releases/1.0.0/use-release
```

每组要核对三类证据。

1. **版本真的运行起来了**。RV 看 `rv-app status` 中进程对应的 ELF 路径和 `m2-ctl --version`。RK 看 `systemctl status` 与服务日志里的启动路径，会出现该次的版本目录。
2. **之前的数据还能读到**。项目验收脚本 `m7/qa/edge-check` 和 `m7/qa/hub-check-data.py` 分别检查 SD 源文件和 SQLite 的一致性，再向 RK 请求真实回放。原脚本按固定验收会话编写，换成自己的录制时在脚本副本里配置会话标识、选中的分片、时间窗口和对应短片预期，四个阶段保持同样的输入。
3. **两个板的应用都能继续工作**。RV 源清单、MP4 和 WAV 的摘要不变，RK 能逐个查回来并得到相同短片摘要。恢复正式版后，用 `rv-app play` 打开回放，再用 `rv-app screen` 回录制页。RK 确认两个服务可按规定开机拉起。

```bash
# RK3576
systemctl enable gsytrace@sync.service gsytrace@playback.service
systemctl is-enabled gsytrace@sync.service gsytrace@playback.service
systemctl is-active gsytrace@sync.service gsytrace@playback.service
```

RV1106 的应用在开机后可手动执行 `/opt/gsytrace/current/rv-app start`。正式验收测了应用与服务实际停止和启动，保留了 RK 的开机服务启用记录。整板断电重启留作另一项测试。

## 正式版验收结果与排查

两份正式包从同一提交的两份独立检出重建，逐字节一致。首次发布先建立 RC1 基线，再走完「RC1 → 正式版 → RC1 → 正式版」。四个阶段核对的是同一场录制，18 条分片记录、SD 原片与短片包摘要一致。恢复后实际播放了同一段 8 秒原声短片，显示 80/80 帧，约 9.998 fps，提交 128,000 个音频采样，跳转后显示 27/27 帧。

| 问题 | 怎么定位 |
|---|---|
| RV 上 `tar -z` 报不支持 | BusyBox 的 tar 选项由固件构建配置决定。实际改成 `gunzip -c "$pkg" \| tar xf - -C "$tmp"`，随后再验内层摘要。 |
| 两次包摘要不一致 | 先比 Git 提交和 `build-inputs.log`，再拆包定位是 ELF、运行文件还是压缩元数据变化。 |
| 链接指到新目录，服务仍不能用 | 额外看进程路径、日志和 M3 握手，确认它真的启动后还能处理请求。 |
| 切换一开始就被拒绝 | 看 `m2-ctl status`。等当前录制完整收尾到 `IDLE`，再提交切换。 |

正式版发布包的两条归档 SHA-256 见下表，用于逐字节核对这次的归档。

| 发布包 | SHA-256 |
|---|---|
| `gsytrace-rv1106-1.0.0.tar.gz` | `b6fb92e1320462bca2ea65e66aed68009813d55ae6f5dffd033391d1337fff32` |
| `gsytrace-rk3576-1.0.0.tar.gz` | `44ef63b3fa01325909b5663a77433ce06217f68b4296d7a9dbc583c8cbe52585` |

现场复盘时应保存的文件有源提交及标签、两种归档的 `SHA256SUMS`、两个构建环境输入记录、两个板的四阶段原始验收日志。Git bundle 可以离线克隆代码历史。正式版是 `v1.0.0`，提交 `abb9fb8ea76dbaa76be410aa772513611ba34f5a`。回滚点 `v1.0.0-rc1` 对应 `760b416b8ab3a5e1ef98544984257ce3b0679d16`。

## 常见面试问法

### 1. 为什么要版本目录加 current 链接？

**口语答法**　旧版文件和新版文件都在，安装先完整验一遍，再切入口。失败时仍有旧版可启动。录制和数据库放在版本目录外，所以两版访问同一份数据。

**追问**　原子切链接是否意味着整个升级瞬间完成？

**答法**　原子的是链接替换。停旧进程、起新进程、等待真实握手各有用时。这次有短暂服务切换窗口。

### 2. 你怎么证明回滚真的成功了？

**口语答法**　先查实际进程来自 RC1，随后查同一会话的清单，再发一个真实回放请求。四次阶段的摘要都比对过。

**追问**　如何区分程序错误和数据没保住？

**答法**　先用进程路径、单位状态和健康检查确认代码启动，再用 SQLite 的记录和原件摘要确认状态。两条证据能把故障范围缩小。

### 3. 可复现构建在这里指什么？

**口语答法**　固定提交和这套工具链后，从两个独立目录重建，最后得到字节完全一致的两个板端归档。

**追问**　相同 Git 提交还能有哪些变量？

**答法**　编译器、库、SDK 工作区、绝对路径、归档时间、时区与文件顺序都可能影响产物。先比构建输入，再看具体包内容逐步定位。
