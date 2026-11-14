# 已有工作对照

**锁不是我们发明的。** 文件锁、租约、TTL、信号量、Wait-For 图都是成熟件,几十年前就定型了。这份文档的目的不是主张新颖,而是说清**哪一个具体缺口没人补**。

## 已有方案,按机制分四层

| 层 | 机制 | 代表 | 做法 | 覆盖 |
|---|---|---|---|---|
| 隔离 | 同 Browser 不同 Context | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) 的 `--isolated` | profile 放内存,每 client 一个 context(**但共享同一个 browser 进程**) | A 类,部分 |
| 隔离 | 独立 `--user-data-dir` + 独立端口 | 同上,社区 workaround | 每个 worker 一个 profile、一个端口 | A 类 |
| 隔离 | 每会话独立 daemon | [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | "Each `--session` gets its own daemon and browser",闲置自毁 | A + B 类 |
| 池化 | 云端会话化浏览器 | [browserbase](https://github.com/browserbase/mcp-server-browserbase)、[steel-browser](https://github.com/steel-dev/steel-browser) | `/sessions` 拿会话 id,本地不抢 profile、不抢端口 | A + B 类 |
| 池化 | 显式并发上限 + 排队 | [browserless](https://github.com/browserless/browserless) | "**Parallelism and queueing** — Handle multiple sessions with configurable concurrency limits" | B 类 |
| **租约** | 工具调用边界的文件锁 | [m13v/browser-lock](https://github.com/m13v/browser-lock) | `PreToolUse` hook 抢锁;锁存 `session_id`+时间戳;**30s 过期可接管**;`mkdir` 原子互斥防崩溃残留;最多等 120s;超时 `exit 2` **直接阻断调用** | A 类;**在「单机 + 无服务端 + 直接在工具调用边界阻断」这一格里,是我检索到的唯一一个** |
| 租约 | 按平台分片 | 同上作者 | 每个平台各自的 profile 与锁,避免无关工作互相阻塞 | A 类 |
| 黑板 | git 原生任务板 + claim | [farol-team/gnap](https://github.com/farol-team/gnap) | `git pull → 认领 → 干活 → commit`,"Git history is the audit log" | 让"谁在用"可读 |
| 观测 | OTel trace | langfuse / phoenix / agentops | 事后观测,不做事前仲裁 | 无 |

> **"唯一"的限定范围与检索方式**(免得被读成全生态断言):上表第 13 行的 browserless 有显式并发上限 + 排队,第 12 行的云端会话服务用 `/sessions` 发会话 id —— 它们**也是仲裁**,只是形态不同(服务端、或进程内)。browser-lock 的"唯一"只成立在这一格里:**单机 + 无服务端 + 直接在工具调用边界阻断**,而且是"我检索到的",不是"存在的全部"。
> 检索方式与日期:2026-11-15,通过 GitHub 代码/仓库搜索与 awesome-mcp-servers 等目录逐个打开 README 核对,关键词含 `file lock`、`PreToolUse`、`lease`、`TTL`、`resource lock`、`deadlock`、`MCP lock`;另查 Playwright / chrome-devtools-mcp 的 issue 与文档。检索是人工的、非穷尽的。

另有一类:某些 agent skill 集合里存在**多 agent 资源锁 + Wait-For 图死锁检测**的实现 —— [`Alpha-Park/genpark-multi-agent-resource-deadlock-wait-for-graph-resolver-skill`](https://github.com/Alpha-Park/genpark-multi-agent-resource-deadlock-wait-for-graph-resolver-skill)(GenPark 的 agent skill,不是 MCP server)。思路与本方案最接近 —— 用 Wait-For 图判环是标准做法,**锁的等待关系成环就是死锁**,这在数据库系统里已经解了几十年。本方案 v1 没有做死锁检测(见下)。

## 学术侧

| 论文 | 相关结论 |
|---|---|
| [arXiv:2608.18092](https://arxiv.org/abs/2608.18092) *Position: MAS Should Prioritize Concurrency Control* | "many MAS failures are fundamentally **concurrency control problems**";主张用 conflict detection、isolation guarantees、structured access to shared resources 来治 |
| [arXiv:2604.17111](https://arxiv.org/abs/2604.17111) *HiveMind* | 11 个并行 agent 死掉 3 个 = 27% 失败率,**尽管总容量足够**;无协调时 72%~100%,加调度后 0~18%。失败不是因为容量不够,是因为没有协调。**注意:论文场景是限流 API 端点(connection reset / 502),不是本机浏览器或端口 —— 把它当本机资源仲裁的支撑属于外推,不是论文结论。** |
| [arXiv:2611.05269](https://arxiv.org/abs/2611.05269) *ToolSched* | 共享主机上的本地 agent 常因 resource contention 出 OOM;做法是在 MCP 接口里**嵌入资源模型**,让 agent 请求命令时同时申报资源需求 |

## 本方案相对差异(不主张首创,只列差异)

1. **键盘与屏幕焦点被当成资源键。** `screen:focus` —— headless 场景不存在这个问题,所以现有生态没有动力做。这是 headed 场景的长尾。
2. **资源键是跨工具的公共词汇,不是某个工具的私有参数。** 端口、profile、目录、焦点、API 配额走同一套 `<类别>:<具体>` 命名,所以不同工具、不同框架的 agent 能互相排斥。
3. **`pool` 与 `exclusive` 同级。** 多数方案只处理"锁",不处理"容量"。而"各起一个无头浏览器、谁也不占锁但把机器拖垮"是纯容量问题,用锁表达不出来。
4. **可见性优先于隔离。** 占用状态注入到编排者的上下文里,冲突在开工前就可见。多数方案只做事前阻断或事后观测,不做"让人看见"。
5. **实现是一个协议 + 参考实现,不是一个框架。** 协议本身与语言无关,任何宿主都能接。

## 明确不声称的

- 不声称"首个"。上面第 6 行那个 30 秒过期的文件锁,机制上就是我们要的答案的大半。
- 不声称"解决多 agent 资源争用"。**我们只做单机、多进程、显式声明**。跨机器、优先级抢占、自动资源推断都不做。
- **没有做死锁检测。** 两个 agent 各持一把锁、又互相等对方那把,本方案会双双等到超时失败 —— 结果是失败而不是卡死,但这是降级方案,不是解法。Wait-For 图那一套是已知的正确做法,留给 v2。
- 上游明确拒收过这类需求:[microsoft/playwright-mcp#1466](https://github.com/microsoft/playwright-mcp/issues/1466),维护者 pavelfeldman 的原话是 "I'll close this as out of scope. Please use `--isolated` + http mode or playwright cli for scale"。**这套东西只能做在宿主层或旁路层。**
