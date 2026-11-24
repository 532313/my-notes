<!-- notebook: {"version":1,"title":"L07 链路层与网络层安全","notebook":"5710","created":"2026-11-24T07:08:38.283Z","updated":"2026-11-24T07:08:38.283Z","favorite":false,"trashed":false,"source":null} -->

发一个包要同时处理本地链路、跨网路由和接收进程。每一层能验证的东西不同。这一讲把地址解析、IPsec、防火墙和入侵检测放到同一条路径上。

## 先分清 MAC、IP 和端口（讲义第 1–9 页）

**分层（Layering）** 让不同协议各管一部分。**链路层（Link Layer）** 把帧交给相邻节点，**网络层（Network Layer）** 通过 IP 在多段网络间转发，**传输层（Transport Layer）** 通过端口把数据交给进程。TCP 提供有序、可靠的字节流，UDP 保留报文边界但本身不保证交付与顺序。

看路由表时，用目标地址和 **网络掩码（Netmask）** 找匹配项，优先选最长前缀，再按同一前缀的路由策略取舍。若没有具体匹配，则使用 **默认路由（Default Route）**。链路头面向当前一跳，IP 头面向跨网络通信的端点。

## 嗅探、ARP 与会话（讲义第 10–24 页）

**嗅探（Sniffing）** 是观察网络上的帧。集线器（Hub）会向多个口重复信号，交换机（Switch）根据学到的 MAC 地址与端口对应关系选择转发。网卡的 **混杂模式（Promiscuous Mode）** 只能让软件接收已经到达端口的更多帧。它不会自动复制交换机上所有端口的流量。讲义用 **跳板入侵（Island Hopping）** 说明一个被攻陷的邻接网络可能成为另一个系统的风险来源。

IPv4 的 **地址解析协议（Address Resolution Protocol, ARP）** 从下一跳 IP 查本地链路的 MAC 地址，结果存进 **ARP 缓存（ARP Cache）**。**ARP 欺骗（ARP Spoofing）** 让设备相信错误的映射，可能改变流量路径。**会话劫持（Session Hijacking）** 指第三方冒用已经建立的会话状态。保护链路映射以及使用经认证的 HTTPS、SSH 等协议，针对的是不同层的风险。

## IPsec 从 IP 层提供保护（讲义第 25–40 页）

普通 IP 的地址和载荷不自动带认证。**互联网协议安全（Internet Protocol Security, IPsec）** 可以为选定流量提供认证、完整性、防重放和保密性，具体服务取决于所选配置。

| 概念 | 讲义中的作用 |
| --- | --- |
| **认证头（Authentication Header, AH）** | 认证载荷与部分不会在途中随意变化的 IP 头字段，可检查重放。内容保持可见。 |
| **封装安全载荷（Encapsulating Security Payload, ESP）** | 保护封装的载荷，可加密并配置认证与防重放。外层路由所需的头部一般仍能看见。 |
| **传输模式（Transport Mode）** | 保留原 IP 头，重点保护紧随其后的内容。 |
| **隧道模式（Tunnel Mode）** | 把原 IP 包放进新包里面。外层头用于找到隧道对端，内层头留给解封装后的转发。 |

**安全关联（Security Association, SA）** 记录一个方向使用的协议、密钥、算法和防重放状态。两个方向各需一个 SA，入站可用 **安全参数索引（Security Parameters Index, SPI）** 等字段关联状态。**IKE（Internet Key Exchange）** 负责协商。**安全策略数据库（Security Policy Database, SPD）** 决定一类流量应保护、放行还是丢弃。**安全关联数据库（Security Association Database, SAD）** 存放执行保护时用的具体状态。出站看策略，入站查关联并验证。

## 边界防火墙与 UDP 穿越（讲义第 41–49 页）

**防火墙（Firewall）** 在网络的边界集中执行访问策略。**包过滤（Packet Filtering）** 按地址、端口、协议等规则放行或拒绝。**有状态检查（Stateful Inspection）** 还会核对包是否属于允许的连接。Linux 课件用不同 **链（Chains）** 展示送给本机、由本机发出、经本机转发的包会经过不同的处理点。

**网络地址转换（Network Address Translation, NAT）** 可能为出站 UDP 短暂保存公网地址与端口的映射。**UDP 打洞（UDP Hole Punching）** 和 **NAT 会话穿越工具（Session Traversal Utilities for NAT, STUN）** 利用映射信息支持通信建立，是否成功取决于两端 NAT 和防火墙策略。防火墙还要能按一致规则处理分片、异常头和来自内部的流量。

## 网络入侵检测怎样看包（讲义第 50–57 页）

**网络入侵检测系统（Network Intrusion Detection System, NIDS）** 分析流量副本并告警。**基于特征（Signature-Based）** 的方法找已知模式。**基于异常（Anomaly-Based）** 的方法把观测与正常基线对比，可能误报。讲义的 **Snort** 按解码、预处理、检测、记录或告警处理数据。部署时可用交换机的 **端口镜像（Port Mirroring / SPAN）** 或网络分流器，使探针看到需要分析的流量。还要考虑镜像拥塞丢包和加密后可见信息减少。

## 自查

1. 去往另一子网时，ARP 找最终远端的 MAC，还是找本地下一跳的 MAC？为什么？
2. 在一张隧道模式图中标出内层与外层 IP 头，再指出何处查 SA。
3. 包过滤和入侵检测收到同一流量时，分别会作什么决定？

*对照 IEMS5710A 讲义 Topic 7，`lec7_network.pdf`，共 57 页。*

---

[上一讲 · L06](#note/notes%2F5710-l06-cert.md)　·　[讲义目录](#note/notes%2F5710-index.md)　·　[下一讲 · L08](#note/notes%2F5710-l08-transport.md)
