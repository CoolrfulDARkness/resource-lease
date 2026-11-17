# 资源租约:给并行 agent 一把跨进程的锁

**一句话:** 一台机器上并行跑多个 agent 时,把"独占资源"变成可申请、可持有、可超时、可被编排者看见的一等对象。资源包括浏览器 profile、CDP 端口、屏幕输入焦点、共享目录、git 仓库、API 配额。

参考实现有三种形态:一个 stdio MCP server、一个 PowerShell CLI、一个 DSH 插件。三者读写同一套锁文件格式,所以不同工具、不同框架的 agent 能互相排斥。

---

## 你什么时候需要它

需要,当**同时满足**这几条:

- 多个 agent 并行跑在**同一台机器**上;
- 它们抢的是**本机物理资源**,而不是各自的 API 调用;
- 资源**没法随手复制一份** —— 最典型的是需要登录态的 headed 浏览器:登录态在 profile 里,你没法给每个 agent 起一个干净的副本。

典型现场:一个固定 CDP 端口的已登录浏览器、一个写死的 dev server 端口、一个需要前台窗口和输入焦点的操作、一份共享的构建产物目录。

**不需要它,如果:**

| 你的情况 | 为什么用不上 |
|---|---|
| 纯 API 型 agent(搜索、检索、推理) | 没有本机共享资源,每个 agent 自带 HTTP client,不存在单例 |
| 用云浏览器 / 托管浏览器服务 | 平台已经用会话隔离解决了,你拿到的是一个独立会话 id |
| 每个 agent 一个容器 / 一台 VM | 隔离已经发生在更下面一层 |
| 单个 agent,或者严格串行 | 没有并发就没有争用 |

这套东西针对的是一块具体的空地:**本机 + 需要登录态的 headed 浏览器 + 固定端口 + 屏幕焦点**。不在这块地上的问题,别用它。

---

## 30 秒上手

### 第 0 步:拿到代码

```bash
git clone <repo-url>
cd <repo>/publish
```

下文所有相对路径都以仓库里的 `publish/` 目录为基准(`./cli/lease.ps1` 指的是 `publish/cli/lease.ps1`)。片段里的 `<repo>` 指仓库根,`<lock-root>` 指锁根目录。

### 方式一:MCP server(推荐,不绑框架)

任何支持 MCP 的客户端都能接。stdio 传输,零依赖,无参数也能直接跑起来。需要 Node.js 18+。

本地路径写法:

```jsonc
{
  "mcpServers": {
    "resource-lease": {
      "command": "node",
      "args": [
        "<repo>/publish/mcp/resource-lease-mcp.mjs",
        "--lock-root", "<lock-root>"
      ]
    }
  }
}
```

发布到 npm 之后可以简化成:

```jsonc
{ "mcpServers": { "resource-lease": { "command": "npx", "args": ["-y", "resource-lease-mcp"] } } }
```

接上之后有三个工具:

| 工具 | 用途 | 最小调用 |
|---|---|---|
| `resource_acquire` | 申请租约。抢不到就是一个明确的错误 | `{"key":"browser:profile:main","reason":"导出报表截图"}` |
| `resource_status` | 看谁占着什么、还剩多久 | `{}` |
| `resource_release` | 释放。`id` / `key` / `all` 三者给一个 | `{"id":"lz_7f3a1b2c3d4e"}` |

`resource_acquire` 的全部参数:`key`(必填)、`reason`(必填)、`mode`、`slots`(pool 用)、`ttlMs`、`waitMs`。

- `mode` 取值 `exclusive` / `shared` / `pool`。**`shared` 目前行为等同 `exclusive`**,不是独立的"多读者"语义 —— 别用它来做并发读,它会按独占排队。
- 时长参数(`ttlMs`、`waitMs`,以及 CLI 的 `-Ttl`/`-Wait`)两侧同一套规则:`number` = 毫秒;字符串带单位(`"30s"`、`"2m"`)按单位算;**字符串裸数字 = 秒**(`"5"` 是 5 秒);解析不出来直接硬报错(CLI 退出码 3)。TTL 下限 1000ms。

### 方式二:CLI(零依赖,不装任何东西)

同一套锁文件格式的 PowerShell 参考实现,随仓库分发(`cli/lease.ps1`,Windows PowerShell 5.1+)。

```powershell
# 在 publish/ 目录执行(片段里的 ./cli/lease.ps1 相对 publish/)
$LEASE = "./cli/lease.ps1"
$ME    = "<你的 agent 名>"

& $LEASE acquire browser:profile:main -Ttl 5m -Owner $ME -Reason "导出报表截图"
& $LEASE status
& $LEASE run browser:profile:main -Cmd "node render.mjs"   # 自动申请 + 自动释放
& $LEASE release --all -Owner $ME
```

`run` 也是**抢不到就立刻失败**(默认 `-Wait 0`),要排队得显式给 `-Wait 120s`;它的默认 TTL 是 `DSH_RESOURCE_TTL`,缺省 600s(见[配置](#配置))。

退出码分两栏,因为 `run` 会把子进程的退出码原样透传出去:

| 来源 | 码 | 含义 |
|---|---|---|
| 协议自身 | `0` | 拿到租约 / 操作成功 |
| 协议自身 | `2` | 资源被占、等待超时、或 `release` 给的租约 id 不存在 |
| 协议自身 | `3` | 参数错误(含空 owner、无法解析的时长) |
| `run` 透传 | 任意 | 子进程自己的退出码。子进程返回 2 **不代表**"资源被占" |

所以用 `run` 时要区分"没拿到锁"和"命令失败",看 stderr:前者有 `Resource busy` 行且**没有** `Acquired lease` 行;后者一定有 `Acquired lease` 行。要严格区分,就用 `acquire` + `finally`(见 [docs/PROTOCOL.md](docs/PROTOCOL.md) §5)。

### 配置

CLI 与 MCP 必须指向**同一个锁目录**,否则互相看不见对方的锁。

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_RESOURCE_LOCK_ROOT` | Windows `%LOCALAPPDATA%\dsh-resource-lease\locks`;其它平台 `$XDG_RUNTIME_DIR/...` 或 `os.tmpdir()/...` | 锁根目录。命令行 `--lock-root` 优先 |
| `DSH_RESOURCE_TTL`(`acquire`) | `30s` | `acquire` 的默认 TTL |
| `DSH_RESOURCE_TTL`(`run`) | `600s` | `run` 读的是同一个变量,但缺省值不同(见下) |
| `DSH_AGENT_NAME` | `pid:<进程号>` | 租约持有者名。**建议每个 agent 设成自己的名字**。留空会让 `release --all` 互删租约,所以实现拒绝空 owner(退出码 3) |

`run` 的两个默认值与 `acquire` **不同**,写在这里避免踩坑:

| `run` 的参数 | 默认 | 说明 |
|---|---|---|
| `-Wait` | `0` | 立即失败。**需要排队就显式给 `-Wait 120s`** —— 与「失败即止」铁律保持一致 |
| `-Ttl` | `$DSH_RESOURCE_TTL`,缺省 `600s` | 命令可能跑得久,给了一整段宽限;别忘了它是可以被接管的上限,不是独占承诺 |

> `DSH_` 前缀是参考实现的历史命名,与宿主无关 —— 改名会破坏 CLI 与 MCP 的互通,所以保留。

MCP server 跨平台。PowerShell CLI 需要 Windows PowerShell 5.1+。跨工具互通的实测是在 Windows 上做的。

---

## 核心概念

### 资源按冲突形态分三类

| 类型 | 例子 | 冲突时的表现 |
|---|---|---|
| **A 独占单例** | user-data-dir、固定 CDP 端口、单例应用、**屏幕/输入焦点**、串口 | 硬失败,或**静默劫持**(连上了,操作的是别人的东西) |
| **B 容量** | CPU/内存/GPU、浏览器实例数、API 速率、并发连接 | 不失败,退化成慢 → 超时 → OOM → 限流 |
| **C 共享可变状态** | 同一份工作区文件、git index、数据库、构建缓存 | **静默污染**:成功返回但结果错 |

优先级排序也是这个顺序的变体:**可见性 > 排队 > 隔离 > 池化。**
隔离消除冲突,可见性消除"不知道",两者不能互相替代。

### 两类互斥 + 一个容量维度

- `exclusive`(slots=1)—— A 类和 C 类。
- `pool(slots: N)` —— B 类。**这个不能省。** N 个 agent 各起一个无头浏览器,谁也不"占锁",但会把内存和工具超时打爆。没有 pool,这个病根本表达不出来。
- `shared` —— 多读者。**参考实现里目前行为等同 `exclusive`**,还没遇到真实需要,不猜着实现(它是第三种取值,但还不是第三种语义)。

### TTL:租约永远不会永久有效

一切租约带 TTL,过期可被接管。agent 崩溃、进程被杀、插件卸载,都必须能自动回收。

**一个永不释放的锁比没有锁更糟** —— 它把偶发冲突变成了永久阻塞。

接管用 `rename` 当 CAS:读锁文件 → 发现已过期 → 原子重命名抢走 → 谁 rename 成功谁获得接管权。

**"已过期"只认锁文件里的 `expiresAt`,不认"读不出来"。** 一个存在但解析不出内容的锁文件,通常正是"刚创建、元数据还没写完"的活着的持有者;把它当过期会抢走一把全新的租约,于是一把锁有两个持有者(这个我们实测复现过,现在两侧都有回归测试)。规则是:能解析且 `expiresAt` 已过 → 可接管;解析不出但文件已老于 2 秒 → 按崩溃残留接管;解析不出且很新 → 视为持有。接管之后还会回读归档副本,若它是有效未过期的租约就放回去。

**接管之后,旧持有者不能再删锁。** 释放前要读锁文件、确认里面的 `id`/`owner` 与自己的记录一致,不一致就只记日志不删 —— 否则"过期 → 被接管 → 旧持有者走 `finally` 释放"会把新持有者的有效锁删掉,第三个 agent 立刻进来,而新持有者仍以为独占。这个校验 CLI 与 MCP 两侧都有,语义一致。

### 失败即止:禁止静默重试

抢不到资源,必须明确失败并把原因带回编排者。默认行为是**立即失败**,不是等。(`acquire` 与 `run` 的默认 `-Wait` 都是 0;要排队必须显式给。)

理由很实在:静默重试把**控制冲突**转化成**时间浪费** —— agent 等 60 秒超时再试,编排者还以为它在干活。这是本方案要消灭的头号问题。

### 可见性优先于隔离(插件独有)

**MCP 与 CLI 没有这个能力:它们只在被调用时返回文本,不会主动往模型的上下文里注入任何东西。这是插件的差异点。**

占用状态直接注入模型的上下文,每一轮刷新:

```
Resource leases in effect right now
  Held by you: browser:profile:main (reason: 导出报表截图, 120s left)
  Held by other: port:<cdp-port> (reason: 调试, 8s left)
```

无租约时**不产生任何文本** —— 否则每个普通 agent 的 prompt 都被污染,白花 token。

同一个注入通道还接了一件事:`promptRules`。操作者可以把**想无条件强调的短规则**填在 profile 配置里,插件每一轮逐字注入:

```yaml
config:
  promptRules:
    - 'Replaying a non-idempotent action is forbidden; re-doing an idempotent observation is required.'
```

为什么放配置而不是放文档:写进 `node_modules/` 的 markdown 只要没人读就等于零,而且**插件升级时会被覆盖掉、静默失效**;配置在 profile 里,升级不会碰它。这条区别有实测来源——见 [docs/COMPUTER-USE-PLAYBOOK.md](docs/COMPUTER-USE-PLAYBOOK.md) 的错误 4。

数组为空时不注入任何东西。

真正造成损失的往往不是"两个 agent 撞上了",而是"编排者不知道发生过撞车,继续基于错的前提调度"。

---

## 为什么框架内的锁不够用

这是本仓库唯一想认真主张的一条。它不是"我们的锁实现得更好",而是**作用域问题**,再好的实现也修不掉。

```
框架内锁的可见域  =  这个框架自己的 agent 集合
资源争用的发生域  =  一台机器、一个 OS 用户、一个 profile 目录、一个端口
```

**这两个域不重合。** 当争用者来自不同工具时(编辑器插件 + 独立的 agent runner + 一个 CLI agent),每一方的框架内锁都会判定"没有人持有",于是**双方都成功**,然后其中一方把共享实例关掉。

于是失败以最难查的形式出现:**不报权限错,不报锁错,报一个离根因很远的连接错误。**

这不是假想。这台机器上跑着两个不同的 agent 产品,它们需要的是**同一个已登录浏览器**;事故 A 里那条通道确实因为共享实例被关而断掉,但**是谁关的没有证据**(日志只证明机制,不证明凶手)。另一个事故是同一产品内部的成员配额撞墙。所以诚实的说法是:

> **机制成立**(框架内锁看不见别的框架的 agent),**实例只证实了一半**(一个产品的共享浏览器真的断过,跨产品的直接证据没有)。

如果你要的是"跨框架争用确实发生过"的硬证据,目前这份文档给不了 —— 它给的是机制推理 + 一个产品的现场。这两样加起来足以说明"值得做",但不足以说明"已经发生过"。读者可以按这个边界自己判断要不要采用。

类比:两个进程各自维护一个内存 mutex,对第三个进程不可见。这正是为什么互斥要由内核提供(`flock`、名字互斥体),而不是让每个库自带一把锁。

**结论:如果资源是在机器级别争用的,仲裁就必须发生在机器级别。** 框架级锁在结构上做不到这件事 —— 它看不到另一个框架的 agent。

配套的推论(条件式):**如果**某个编排层的配额是按"agent 数量"计的、满了直接拒绝,那它就不是资源仲裁 —— 它按数量计,不按资源计,被拒的工作单元直接消失。这类撞墙有现场记录(事故 B),但只有一个产品内部的一次,不能推广成对所有编排层的判断。容量问题当配置问题解(把上限调大)只是把撞墙时间往后推。

---

## 已知相近工作:锁不是新东西

锁、租约、TTL、信号量、Wait-For 图死锁检测,都是几十年前就定型的成熟件。**这个仓库没有发明其中任何一个。**

已有的相近工作,开工前就该知道:

- **[microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)** 的 `--isolated` 和独立 `--user-data-dir`:官方文档明确写了"并发 client 共享同一个 workspace 会冲突",并给了隔离参数。
- **[m13v/browser-lock](https://github.com/m13v/browser-lock)**:在 `PreToolUse` hook 里抢文件锁,30 秒过期可接管,`mkdir` 原子互斥防崩溃残留,超时 `exit 2` 直接阻断调用。**机制上就是我们要的答案的大半。**
- 存在做**多 agent 资源锁 + Wait-For 图死锁检测**的 agent skill 仓库:[`Alpha-Park/genpark-multi-agent-resource-deadlock-wait-for-graph-resolver-skill`](https://github.com/Alpha-Park/genpark-multi-agent-resource-deadlock-wait-for-graph-resolver-skill)(GenPark 系的 agent skill,不是 MCP server)。用等待图判环是标准做法,数据库系统里已经解了几十年。
- 学术上,[arXiv:2608.18092](https://arxiv.org/abs/2608.18092)(position paper)已经把这件事命名了:多 agent 的失败**本质上是并发控制问题**。[arXiv:2604.17111](https://arxiv.org/abs/2604.17111)(HiveMind)量化了无协调时的失败率,但它的场景是**限流 API 端点**(connection reset / 502),与本方案的**持锁争用**不是一回事;**把它当本机资源仲裁的支撑属于外推,不是论文结论**。而且该论文摘要明写 "transparent retry - not admission control - is the single most critical primitive",方向与本协议"禁止重试"相反 —— 引用它只为说明"缺协调会出事",不构成对本方案取向的支持。[arXiv:2611.05269](https://arxiv.org/abs/2611.05269)(ToolSched)主张在 MCP 接口里嵌入资源模型。

完整对照表在 [docs/PRIOR-ART.md](docs/PRIOR-ART.md)。摘要:

| 层 | 代表 | 覆盖 |
|---|---|---|
| 隔离 | playwright-mcp `--isolated` / 独立 `--user-data-dir` / 每会话独立 daemon | A 类,部分 |
| 池化 | 云浏览器会话服务、browserless 的可配并发上限 + 排队 | A + B 类 |
| 租约 | `m13v/browser-lock` 的 `PreToolUse` 文件锁(30s 过期可接管) | A 类 |
| 黑板 | git 原生任务板 + claim | 让"谁在用"可读 |
| 观测 | OpenTelemetry / trace 类工具 | 只做事后,不做事前仲裁 |

**本方案相对这些的差异,有五条:**

1. `screen:focus`(屏幕与输入焦点)当成资源键。headless 场景用不到它;在我检索到的方案里,没有谁把它当资源键(检索范围与方式见 PRIOR-ART)。
2. 资源键是**跨工具的公共词汇**,不是某个工具的私有参数。不同框架的 agent 走同一套命名,因此能互相排斥。
3. `pool` 与 `exclusive` 同级 —— 处理"谁也不占锁但把机器拖垮"的容量问题。
4. 可见性优先:占用注入编排者上下文,冲突在开工前就可见(仅插件形态,见上)。
5. 实现是一个协议 + 参考实现,不是一个框架。协议本身与语言无关,任何宿主都能接。

**明确不声称的:** 不声称首个;不声称解决多 agent 资源争用;没有做死锁检测(两个 agent 互等会双双超时失败 —— 结果是失败而不是卡死,但这是降级,不是解法);上游明确拒收过这类需求 —— [playwright-mcp#1466](https://github.com/microsoft/playwright-mcp/issues/1466),维护者 pavelfeldman 判为 out of scope,原话是 "I'll close this as out of scope. Please use `--isolated` + http mode or playwright cli for scale",所以这套东西只能做在宿主层或旁路层。

---

## 边界与局限

### 证据强度

**目前只有一台机器、两个产品的现场证据,没有基准测试,没有上游采纳。**

| 项 | 状态 |
|---|---|
| 现场证据 | 2 个事故,同一台机器,来自 2 个不同产品 |
| 原始报错 | ✅ 事故 A 的异常栈逐字保留(仅脱敏端口/路径);事故 B 的 agent 报告为脱敏后的转述 |
| 根因(是谁关的) | ❌ 未证实,不做推断 |
| 跨机器复现 | ❌ 没有 |
| 修复前后基准 | ❌ 没有 |
| 上游采纳 / 第三方 PR | ❌ 无 |
| 功能测试 | ✅ 93 项断言:CAS 互斥、TTL 接管、崩溃残留自愈(真实 `.lock` 残骸)、接管后旧 id 释放不误删新锁、`run` 中途被接管不误删、键大小写归一、半写锁文件与目录残骸不可抢、退出码 |
| 跨框架互操作 | ✅ 实测:一个实现持有的租约,另一个实现看得见、抢不到 |

**这套东西能证明问题真实存在;它还没有证明自己的有效性。**

### 能力边界(v1 明确不做)

- **单机 + 多进程**。不做跨机器 / 分布式租约。
- **不做优先级抢占**。先到先得,等不到就失败。
- **不做自动资源推断**。资源由调用方显式声明 —— 写错键名等于没有互斥,而且不报错。
- **不做死锁检测**。互相等待会双双超时失败。
- **`shared` 未真正实现**,当前等同 `exclusive`。
- **不检测持锁进程是否还活着**,只认 TTL。TTL 给太长会让崩溃残留多占一会儿。

### 一个实现陷阱,必须写下来

**锁必须是文件,用 `O_CREAT|O_EXCL`(`FileMode::CreateNew` / `fs.openSync('wx')`)一次系统调用判定成败。**

不要用目录当锁。目录锁的成败取决于"创建时有没有抛异常":PowerShell 5.1 里普通的 `New-Item -ItemType Directory` 对已存在目录**是会报错的**,但大家真正会写的那两种 —— `-Force`、`[System.IO.Directory]::CreateDirectory` —— **对已存在目录不抛**,于是每个 racer 都"成功",互斥**静默失效**。文件 + `FileMode::CreateNew` 是单次系统调用判定,没有这个歧义。第一版就是在这个歧义上栽的跟头,由并发测试(3 个进程抢 2 个名额,结果 3 个全进)抓出来。

---

## 文档

| 文件 | 给谁看 | 内容 |
|---|---|---|
| [docs/RESOURCE-MODEL-v2.md](docs/RESOURCE-MODEL-v2.md) | **实现者**(CLI / 插件 / 后端) | v2 契约:资源键语法、facet 展开、冲突谓词、全序、多资源原子获取、存活判定、后端抽象、**保证边界**、测试矩阵 |
| [docs/RESOURCE-CLASSES.md](docs/RESOURCE-CLASSES.md) | **agent** / 要决定"该声明什么"的人 | 按场景查:跑浏览器、起 dev server、构建装依赖、改 git 仓库、发版部署、调限流 API 各自该申请哪些键 |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | **agent** / 往 prompt 里贴规则的人 | 什么时候必须申请、资源键规范、三模式、三步走、三条铁律、撞车回报格式 |
| [docs/DESIGN.md](docs/DESIGN.md) | 想理解为什么这么设计的人 | 设计规格:三条原则、三类资源、facet 冲突模型、多键原子性、存活判定、后端抽象 |
| [docs/CASE-STUDIES.md](docs/CASE-STUDIES.md) | 想判断问题真假的人 | 两个事故的脱敏复盘:资源形态、原始报错、后果链、"手工聊天租约为什么必然失效" |
| [docs/PRIOR-ART.md](docs/PRIOR-ART.md) | 想知道是不是重复发明的人 | 已有方案分四层对照 + 本方案相对差异 + 明确不声称的部分 |
| [mcp/](mcp/) | 用任意 MCP 客户端、不绑框架的人 | stdio MCP server,零依赖单文件,跨平台 |
| [cli/](cli/) | 不想装任何东西、只要有 Windows 就能用的人 | PowerShell 5.1+ 单文件 CLI,与 MCP/插件共用同一套锁文件 |
| [plugin/](plugin/) | 用 DSH、想要占用状态进模型上下文的人 | DSH Host 插件:把占用注入上下文,并提供同名工具;与 CLI 共用锁文件 |
| [STAGING.md](STAGING.md) | 维护者(发布/打标签的人) | 打包前必须排除 `review/` 的规则与闸门;本文件只定义规则,不执行发布 |

## 许可

MIT(`mcp/package.json` 已声明;仓库根目录有 [LICENSE](LICENSE))。
