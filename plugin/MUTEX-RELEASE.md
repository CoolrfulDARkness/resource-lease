# v0.2.0 — 共享获取互斥（acquire mutex）

本版本给 DSH 插件层加上了**共享获取互斥**：任何 `resource_acquire` 在扫描+建锁的临界区前后都会经过一把跨进程的 `_global.lock` 互斥文件，消灭"两个 agent 抢冲突但拼写不同的资源时双双通过"的窗口。

## 解决什么问题

v0.1 的 scan→create 不是原子的。两个 agent 分别申请 `path:D:/out` 与 `path:D:/out/sub`（祖先冲突但文件名不同）：双方都过预扫描、都建锁成功——**双赢 = 双重持有 = 互斥失效**。构造式复现：30 轮里 23 轮双赢（77%）。加上互斥后：0/30，每轮恰好一个成功（CLI 与插件共享同一互斥文件，跨工具同样封闭）。

## 三条接管规则（与 CLI `_global.lock` 协议逐字节兼容）

1. **TTL 过期**（15000ms）→ 偷；
2. **同 host + pid 已死** → 偷；
3. **不可读 + 文件年龄 > 2s**（残留）→ 偷。
`takeoverMutex` 是 rename CAS：改名 aside 后**回读归档副本**，发现是活持有者就放回——防误偷。

## 有界升级等待（v0.2.0 新增）

互斥忙时，无 deadline 的 acquire 不再固定 1.2s 后降级为**无保护运行**，而是按 2s 步长有界升级（上限被调用方自身预算钳制，典型 ~8s），只有持有者真卡死时才降级。fail-fast 与显式 `waitMsCap` 调用方行为不变。实测：32 路多 facet 剂量下降级率 15/64 → **0/64**，wall 0.21×（排队消除重试风暴反而更快）。

## 崩溃安全

- 持有者死后互斥文件由三条接管规则回收（TTL 15s 兜底）；
- `MUTEX_LOST` / `COMMIT_UNVERIFIED` / `COMMIT_UNVERIFIED` 复核链：被剥夺者**绝不提交**，已建文件全部回滚；
- Windows 瞬态干扰（杀毒/索引器挂非共享句柄 → EPERM/EBUSY）自动短退避重试（1/2/4/8ms ×4）。

## 可观测性

设 `DSH_MUTEX_TRACE=<目录>` 即得每进程 JSONL 事件流：`steal-decision`（哪条规则想偷）、`takeover-outcome`（won / put-back-live / put-back-failed）、`take-refuted`（缓存判死被 fresh 读推翻）、`hold-tenure`（临界区时长分布）、`mutex-escalate` / `mutex-degrade`（升级与降级归因）。默认关闭，热路径零开销。

## 测试与验证

- 插件套件 **113/113** + mutex 专项 **38/38**；CLI 210 断言全绿（锁文件格式 version:2 三方契约零变更）。
- 跨工具互通：CLI ↔ 插件并发竞速 **890 轮 0 双赢 0 双输**（含 1ms 落点差精扫区）。
- 构造式对抗验证：偷活锁 0/210、错误舞蹈发射 15/15 → **0/15**、跨工具"判死"58/58 被 fresh 确认拦回。

## 兼容性

锁文件格式、CLI 协议、`pidGated:false` 豁免、orderKey 全序、失败逆序回滚、fail-closed 语义**全部不变**。旧版插件（无互斥）与新版并发时，窗口仍在（双方都取互斥才能封闭）——建议整批升级。
