<!-- notebook: {"version":1,"title":"L11 无线网络安全","notebook":"5710","created":"2026-11-24T07:08:38.279Z","updated":"2026-11-24T07:08:38.279Z","favorite":false,"trashed":false,"source":null} -->

无线信道是共享的，附近的设备可能接收到同一份信号。链路加密控制谁能读懂它。蜂窝网络还要关注负责建立连接的信令资源是否够用。

## Wi-Fi 网络怎样找到接入点（讲义第 1–8 页）

**无线局域网（Wireless LAN, WLAN）** 通常指基于 **IEEE 802.11** 的 Wi-Fi。课件比较了 802.11a/b/g/n 的频段、速率与多天线设计。它们有一个共同思路，发送前先听信道，利用 **载波侦听多路访问与冲突避免（Carrier Sense Multiple Access with Collision Avoidance, CSMA/CA）** 协调发包。

在 **基础设施模式（Infrastructure Mode）** 中，终端经 **接入点（Access Point, AP）** 进入网络，一个 **基本服务集（Basic Service Set, BSS）** 包括 AP 和关联的终端。**自组织模式（Ad Hoc Mode）** 允许终端直接通信。频道可能重叠，相邻 AP 用同一或重叠频道会互相干扰。

AP 定期发 **信标帧（Beacon Frame）** 公布 **服务集标识符（Service Set Identifier, SSID）** 等信息。终端扫描频道、发现候选 AP，执行 **关联（Association）** 与配置所需的认证，然后通常用 **DHCP** 获取 IP 配置。发现了一个 SSID 只代表附近有设备宣告这个名字，身份仍要核验。

## 无线帧、漫游与防火墙（讲义第 9–16 页）

有线以太网通常关心源和目的 MAC。无线帧还要表达当前无线一跳的发送方、接收方，以及最终的链路来源或目的。例如，在讲义的终端发向路由器的图中，无线一跳是终端 → AP，而 AP 转到有线侧后用路由器的 MAC 作二层目的。地址字段的含义由传输方向等帧控制位决定，无线桥接等场景可出现第四个地址。

**漫游（Roaming）** 是在同一覆盖网络切换 AP。留在同一子网时 IP 可以不变，交换机则从新入口重新学习终端 MAC 所在端口。无线网卡进入 **监控模式（Monitor Mode）** 时可以观察原始 802.11 帧，例如管理帧。**混杂模式（Promiscuous Mode）** 通常仍受网卡关联和驱动路径限制。

AP 在防火墙哪一侧，会改变无线用户可访问哪些内部服务。防火墙无法改变无线电信号传播。**链路加密（Link-Layer Encryption）** 保护终端与 AP 这一跳。应用使用的 HTTPS 或跨网络的 VPN 要按自己的端点和保护范围判断。

## 从 WEP 到 WPA2（讲义第 17–28 页）

| 技术 | 讲义中的机制和局限 |
| --- | --- |
| **有线等效保密（Wired Equivalent Privacy, WEP）** | 用共享密钥和 24 位 **初始化向量（Initialization Vector, IV）** 输入 RC4，生成每帧密钥流。IV 空间小，重用会重复密钥流。公开的 CRC-32 能检测偶然差错，无法提供带密钥的认证。RC4 密钥调度也存在已知弱点。 |
| **Wi-Fi 保护访问（Wi-Fi Protected Access, WPA）** | 早期过渡方案使用 **临时密钥完整性协议（Temporal Key Integrity Protocol, TKIP）**。它兼容旧硬件的 RC4，改进逐帧密钥处理、序号和 **消息完整性码（Message Integrity Code, MIC）**。 |
| **WPA2** | 课件重点是基于 AES 的 **CCMP（Counter Mode with CBC-MAC Protocol）**，同时保护数据的保密性和完整性。家庭常用 **预共享密钥（Pre-Shared Key, PSK）** 模式，企业模式可给用户单独认证。 |

企业模式中，**IEEE 802.1X** 控制网络接入，**可扩展认证协议（Extensible Authentication Protocol, EAP）** 承载认证。终端与 AP 之间可通过 **EAP over LAN（EAPOL）** 交换消息，再由 AP 和 **RADIUS** 认证服务交互。PSK 是否容易猜取决于口令质量。

MAC 地址不是身份凭证。共享空口也可能因设备长期占用媒介而影响可用性。课件用 **RTS/CTS（Request to Send / Clear to Send）** 解释信道协调的目的与被滥用时的风险。

## 蜂窝网络的短信经过哪些部件（讲义第 29–34 页）

**短信服务（Short Message Service, SMS）** 可由终端或 **外部短信实体（External Short Message Entity, ESME）** 发起。讲义用传统蜂窝网络举例，采用基本 7 位字符编码时，单段短信可容纳 160 个字符。其他编码或分段格式的容量不同。

1. **短信中心（Short Message Service Center, SMSC）** 接收、暂存并决定路由。
2. **归属位置寄存器（Home Location Register, HLR）** 存长期订阅信息。**访问位置寄存器（Visitor Location Register, VLR）** 存当前服务区的用户信息。
3. **移动交换中心（Mobile Switching Center, MSC）** 处理连接与路由，再由 **基站（Base Station, BS）** 通过空口交付给移动终端。

## 为什么小短信会消耗较多信令（讲义第 35–37 页）

在讲义的传统 GSM 示例中，语音等用户流量和 **控制信道（Control Channel, CCH）** 使用不同资源。移动终端从 **寻呼信道（Paging Channel, PCH）** 得知有业务，在 **随机接入信道（Random Access Channel, RACH）** 应答。系统可分配 **独立专用控制信道（Standalone Dedicated Control Channel, SDCCH）** 完成认证、加密准备、身份更新及交付。

所以瓶颈可能在空口的信令会话，也可能在 SMSC 的缓冲队列。短信内容很短，交付仍有多步状态和处理成本。这个历史案例用于理解 **信令拥塞（Signaling Congestion）**，不同代际蜂窝网络的协议流程会变化。

## 自查

1. WEP 的 IV 重用与 CRC-32 分别影响哪一项安全目标？与 L01、L04 对照。
2. 从手机发 HTTPS 请求到网站，找出 Wi-Fi 加密和 TLS 各自结束在哪。
3. 为什么只看短信字节数会低估传统蜂窝空口的负载？

*对照 IEMS5710A 讲义 Topic 11，`lec11_wireless.pdf`，共 37 页。*

---

[上一讲 · L10](#note/notes%2F5710-l10-web.md)　·　[讲义目录](#note/notes%2F5710-index.md)
