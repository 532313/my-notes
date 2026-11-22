<!-- notebook: {"version":1,"title":"GsyTrace M0 · 从 WSL 交叉编译到板上 Hello","notebook":"GsyTrace 应用层","created":"2026-11-22T12:00:00Z","updated":"2026-11-22T12:00:00Z","favorite":false,"trashed":false,"source":null} -->
# GsyTrace M0 · 从 WSL 交叉编译到板上 Hello

[![M0 架构图。Windows 的 WSL 负责编译，MobaXterm 传输程序，RV1106 负责执行。](assets/gsytrace/m0.png)](assets/gsytrace/m0.png)

[项目总览](#note/notes%2Fgsytrace-overview.md) · [下一篇 M1 视频与音频采集](#note/notes%2Fgsytrace-m1.md)

## 先让一条最短的链路跑通

M0 只做一件事。电脑编出一个小程序，拷到 RV1106，板子打印一行 `hello-rv`。后面即使摄像头、声卡和小屏都遇到问题，也能先用这行字确认工具链和部署路线。

图中的 **WSL（Windows Subsystem for Linux，适用于 Linux 的 Windows 子系统）**是写代码和编译的地方。MobaXterm 提供 **SSH（Secure Shell，安全外壳协议）**终端和 **SFTP（SSH File Transfer Protocol，SSH 文件传输协议）**。SFTP 负责传文件，SSH 终端里输入的命令由板子执行。先看清提示符和当前目录，再粘命令。

这里整理的是 GsyTrace 应用层的实现。板子已有能运行的 Linux 和配套设备驱动，应用从固件与 **SDK（Software Development Kit，软件开发工具包）**提供的接口开始。早期构建先记录固件、SDK、工具链和媒体库的一组基线摘要，M7 仍以类似方式记录产物来源。

## 第一步 · 写最小程序

在项目根目录创建 `main.c`。头文件 `stdio.h` 给出了 C 标准输入输出函数的声明。 `main()` 是程序入口，`puts()` 写到标准输出并自动换行。 `return 0` 用退出码告诉调用者本次成功。

```c
#include <stdio.h>

int main(void)
{
    puts("hello-rv");
    return 0;
}
```

在同一目录建立 `CMakeLists.txt`。CMake 读取这份配置，生成构建规则，再调用真实编译器。这里把 `main.c` 变成名叫 `hello-rv` 的可执行文件。

```cmake
cmake_minimum_required(VERSION 3.16)
project(GsyTrace LANGUAGES C)
add_executable(hello-rv main.c)
```

在 `cmake/rv1106-toolchain.cmake` 写入目标系统和处理器。具体 GCC 路径在配置命令中传入，便于另一台电脑迁移 SDK 路径。

```cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR arm)
```

## 第二步 · 在 WSL 编译并核对格式

在 WSL 进入项目根目录，把 `/path/to/luckfox-pico` 改成你的 SDK 目录。下面的工具前缀适用于本项目使用的 RV1106 SDK。其中 **GCC（GNU Compiler Collection，GNU 编译器套件）**把 C 源码编成目标板能够执行的机器指令。

```sh
cd ~/GsyTrace
SDK=/path/to/luckfox-pico
TC="$SDK/tools/linux/toolchain/arm-rockchip830-linux-uclibcgnueabihf/bin/arm-rockchip830-linux-uclibcgnueabihf"
"$TC-gcc" --version

cmake -S . -B build/m0-rv1106 \
  -DCMAKE_TOOLCHAIN_FILE="$PWD/cmake/rv1106-toolchain.cmake" \
  -DCMAKE_C_COMPILER="$TC-gcc"
cmake --build build/m0-rv1106 --target hello-rv

file build/m0-rv1106/hello-rv
readelf -h build/m0-rv1106/hello-rv
readelf -l build/m0-rv1106/hello-rv | grep interpreter
sha256sum build/m0-rv1106/hello-rv
wslpath -w "$PWD/build/m0-rv1106"
```

| 要看什么 | 正常时看到什么 | 能确认什么 |
|---|---|---|
| `cmake --build` | `Built target hello-rv` | 构建规则和工具链能产出文件 |
| `file` / `readelf -h` | 32 位、小端、ARM、EABI5 | 产物指令集和二进制约定与目标板相符 |
| `readelf -l` | `/lib/ld-uClibc.so.0` | 动态 ELF 在启动时要求这个加载器 |
| `sha256sum` | 一串 64 个十六进制字符 | 能对照上传前后的文件字节 |
| `wslpath -w` | 可在 Windows 文件选择框打开的路径 | MobaXterm 能找到本次产物 |

**ELF（Executable and Linkable Format，可执行与可链接格式）**描述程序的机器类型、段和动态加载信息。 **ABI（Application Binary Interface，应用二进制接口）**是编译出来的程序与系统之间的约定，涵盖调用方式、数据布局等。 **EABI（Embedded Application Binary Interface，嵌入式应用二进制接口）**用于描述这类嵌入式二进制约定。 `uClibc` 是面向嵌入式 Linux 的 C 库，这套固件提供对应的动态加载器。

## 第三步 · 用 MobaXterm 上板验收

登录 RV1106 的 SSH 标签，在板上新建本次试验目录。把 WSL 输出目录里的 `hello-rv` 上传到同一个目录，执行下方剩余命令。实际操作时先上传，再跑 `sha256sum`。

```sh
mkdir -p /tmp/gsytrace-m0
cd /tmp/gsytrace-m0
# 现在从 MobaXterm 左侧 SFTP 面板上传 hello-rv
sha256sum hello-rv
chmod +x hello-rv
./hello-rv
echo "$?"
```

验收时对比两端 SHA-256（Secure Hash Algorithm 256-bit，256 位安全哈希算法）的字符串。最后两行预期依次为 `hello-rv` 和 `0`。项目中这条链路已在 RV1106 跑通，早期提交可用 `git show c8703b8:main.c` 回看。 `/tmp` 适合临时试验，后续录制结果需要存到 SD 卡。

## 开发中碰到的坑

- **编译出来的机器类型不对。** CMake 第一次配置时会把编译器写到构建目录的 `CMakeCache.txt`。改过工具链后，可用一个全新的 `-B` 目录重新配置，再用 `file` 验一次。这样还可以留下前后的输出供比较。
- **文件明明在，执行却报 `not found`。** 先看 `ls -l`、执行权限和所在目录，再用 `readelf -l` 查程序要求的 ELF 解释器。动态加载器缺失时，内核可能返回 `ENOENT`（No such file or directory，文件或目录不存在）。文件格式错误常见另一条 `Exec format error`。一条报错有多个可能原因，按检查顺序排除。
- **板上库和 SDK 头文件对不上。** 真正采集以前先把固件版本、工具链和库的版本记进基线。日后换了 SDK，先重跑 Hello，再跑一条媒体链路，最后才部署整个应用。这样容易分清是哪一次变化导致失败。

## 常见面试问法

### 你为什么先写 Hello？

**可以这样答。** 项目第一步要把编译、传输、运行连成闭环。我在 WSL 用 Rockchip 工具链交叉编译，用 `file` 和 `readelf` 核对产物，经 MobaXterm 上传，最后让板子实际输出 `hello-rv` 并返回 0。后面加入视频驱动接口时，这一步能帮助我缩小排查范围。

**追问。怎么证明终端里跑的是上传的那个文件？** 上传前后比较 SHA-256，再从目标目录用 `./hello-rv` 执行，并记录命令和输出。目录、摘要和运行结果一起留证。

### 什么是交叉编译？

**可以这样答。** 编译器运行在我的电脑上，产物的指令和 ABI 以板子为目标。CMake 的工具链文件告诉构建系统目标是 ARM Linux，指定的 GCC 负责生成这个目标的二进制。

**追问。看到 ARM 就能判断兼容吗？** 我还会核对位数、字节序、动态加载器和所需共享库。相同指令集也可能配不同 ABI 或 C 运行库。

### CMake、编译器和链接器分别干什么？

**可以这样答。** CMake 根据目标和源文件生成构建规则。编译器把源码变成目标文件，链接过程把符号和依赖组织成可执行文件。动态链接的程序启动时由系统里的加载器找所需共享库。

**追问。为什么重新输入工具链路径还可能没生效？** 旧构建目录保存了首次配置的 CMake 缓存。我会用新的构建目录配置，再核对实际工具路径和 ELF。

[回到项目总览](#note/notes%2Fgsytrace-overview.md) · [继续 M1](#note/notes%2Fgsytrace-m1.md)
