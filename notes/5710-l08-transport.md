<!-- notebook: {"version":1,"title":"L08 TCP、TLS 与 VPN","notebook":"5710","created":"2026-11-24T07:08:38.282Z","updated":"2026-11-24T07:08:38.282Z","favorite":false,"trashed":false,"source":null} -->

TCP 负责把字节有序送到另一端。TLS 在这个通道上认证对端并保护数据。VPN 再把原本要走其他路的网络包送进一个受保护的通道。

## TCP 的连接状态和安全边界（讲义第 1–16 页）

**传输控制协议（Transmission Control Protocol, TCP）** 用源 IP、源端口、目的 IP、目的端口这四项识别连接。**序列号（Sequence Number, SEQ）** 表示一段数据的起始字节位置，**确认号（Acknowledgment Number, ACK）** 表示下一步期待哪个字节。

- **三次握手（Three-Way Handshake）** 用 SYN、SYN-ACK、ACK 建立连接，让两端确认初始序列号。正常结束时每个方向分别用 FIN 和 ACK 收尾。
- **连接重置（Connection Reset, RST）** 可提前中断连接。未经认证的传输控制信息若被错误接受，即使上层应用数据已加密，连接仍可能中断。讲义以较低层的 IPsec 防护作为对照。
- **端口（Port）** 把数据送给对应进程。**端口扫描（Port Scanning）** 在防守方可用于盘点暴露的服务。横向查许多主机的同一端口，纵向看单台主机的多个端口。讲义用 Nmap 示意，复习时关注结果能说明什么，以及网络过滤怎样影响观察。

## TLS 握手怎样建立安全连接（讲义第 17–36 页）

**传输层安全协议（Transport Layer Security, TLS）** 接在应用和可靠传输之间。HTTPS 就是将 HTTP 数据放进 TLS。**握手层（Handshake Layer）** 协商参数、认证、建立密钥。**记录层（Record Layer）** 负责分块和保护之后的消息。

讲义主要使用 **TLS 1.2** 的 RSA 密钥交换与 CBC 型记录保护示例。下面用五步描述该示例。其他套件与版本的消息可能不同。

1. **ClientHello** 发送可接受版本、随机数和 **密码套件（Cipher Suites）**，也可带已有会话标识。**ServerHello** 指明选定的套件，给出自己的随机数。
2. 服务器提供 **Certificate** 消息。客户端验证证书链与所请求的主机名。这个简化示例用 **ServerHelloDone** 表示服务器这一轮参数发送结束。
3. **ClientKeyExchange** 在此示例中传输用服务器公钥加密的 **预主密钥（Pre-Master Secret）**。双方用预主密钥和 Hello 随机数派生 **主密钥（Master Secret）**，再导出各方向使用的加密与认证密钥。使用临时 DH 的套件以协商出的共享值进入密钥派生。
4. **ChangeCipherSpec** 通知对端该方向启用已协商的保护。
5. **Finished** 由协商出的秘密和此前 **握手记录（Handshake Transcript）** 共同决定。双方核对它，在握手一致时才进入应用数据传输。

## TLS 记录、连接状态与会话恢复（讲义第 37–49 页）

一条 **记录（Record）** 有内容类型、版本、长度和相应数据。应用内容可拆成多条记录，课件图中单段明文上限为 16 KiB。讲义的旧式 CBC 套件示例先对片段及序号等数据算 MAC，再处理加密所需的填充。采用 **AEAD** 的套件由算法统一提供加密和认证。记录的序号参与认证，可使乱序、重复或改动被识别。关闭时用 **告警消息（Alert）** 传递关闭或错误状态。

**会话（Session）** 保留协商信息和可恢复的状态。**连接（Connection）** 有本次通信的随机数、双向读写密钥和各方向的序号。讲义的 **会话恢复（Session Resumption）** 示例用会话标识查已有主密钥，结合新的随机数生成本次连接用密钥，可省掉部分握手。

## VPN 怎样转发一整个包（讲义第 50–64 页）

**虚拟专用网络（Virtual Private Network, VPN）** 先建立可信的隧道对端，再把选定的网络流量送进隧道。IPsec 隧道在 IP 层包装原始包。讲义的 **TLS VPN** 示例由用户态程序把 IP 包放进受保护的应用载荷。

- **TUN 虚拟网卡（TUN Interface）** 处理三层 IP 包。**TAP 虚拟网卡（TAP Interface）** 处理二层以太网帧。普通应用 socket 多数读到的是应用数据，虚拟网卡让 VPN 程序取到完整的包或帧。
- 出站时，路由把选定的包送到 TUN，用户态 VPN 程序读出并写入隧道。入站时，对端程序从隧道解出原包，写回自己的 TUN，交给内核转发。
- 程序可以等待虚拟网卡与隧道 socket 任一端有数据，再决定往哪个方向转发。只有走相应路由的包才进入该隧道。

## 自查

1. 说出 TCP ACK 值的含义，再说明 TLS Finished 要验证什么。
2. TLS 1.2 的例子里，恢复会话时复用什么，又重新生成什么？
3. 对照 L07，画出同一内层 IP 包用 IPsec 隧道或 TLS VPN 时，分别由哪一层处理。

*对照 IEMS5710A 讲义 Topic 8，`lec8_transport.pdf`，共 64 页。*

---

[上一讲 · L07](#note/notes%2F5710-l07-network.md)　·　[讲义目录](#note/notes%2F5710-index.md)　·　[下一讲 · L09](#note/notes%2F5710-l09-dns.md)
