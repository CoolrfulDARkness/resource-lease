# 资源租约协议(v1)

给 agent 读的规矩,不是论文。派活时把 §5 那一段贴进 prompt 即可。

协议本身与语言、框架无关。参考实现是一个 CLI(PowerShell)和一个 MCP server,二者读写同一套锁文件,所以用 CLI 的 agent 和用 MCP 的 agent 互相排斥。

---

## 1. 这份文件想消灭的现象

多个 agent 同时抢同一个独占资源时,结果通常是三种:

| 形态 | 表现 | 危害 |
|---|---|---|
| 硬失败 | 第二个报错退出 | 能看见,但报错位置离根因很远 |
| 静默劫持 | 连上了,操作的是别人的东西 | **最坏**:返回 `is_error=false`,上层基于错数据继续调度 |
| 容量耗尽 | 不失败,退化成慢 → 超时 → OOM → 限流 | 看起来像"偶发不稳定",查不出来 |

三种形态对应三种资源类型,见 §4。协议要做的事只有一件:**把"谁占着什么"变成可查询、可失败、可超时的权威状态。**

---

## 2. 什么时候必须申请租约

| 场景 | 资源键 | 模式 |
|---|---|---|
| 起浏览器 / 无头浏览器自动化 / 截图渲染 | `browser:chromium` | `pool`(本机建议 2) |
| 用某个固定 user-data-dir(里面装着登录态) | `browser:profile:<名字>` | `exclusive` |
| 占固定端口(CDP 调试口、dev server) | `port:<cdp-port>` | `exclusive` |
| 需要屏幕 / 输入焦点(headed 操作、发键盘、点窗口) | `screen:focus` | `exclusive` |
| 写共享目录或共享文件 | `dir:<工作区相对路径>` | `exclusive` |
| 改 git 仓库(index、切分支、rebase) | `repo:root` | `exclusive` |
| 打有速率限制的供应方 API | `api:<provider>:rpm` | `pool`(slots ≈ 配额) |

**不需要申请**:只读文件、自己独占的临时目录、纯计算、不受限的纯网络请求。

判断标准:**有没有第二个 agent 也能同时碰它?** 能,就要申请。

---

## 3. 资源键命名规范

```
<类别>:<具体>
```

强制性规则(违反等于没有互斥):

1. **类别必须来自 §2 的表**。拼错的键(`browser:chrome` 与 `browser:chromium`)是两个不同的键,双方都会"成功",互斥静默失效。
2. **小写**,路径用工作区相对路径,不用绝对路径。**参考实现会把键规范成小写**(`Get-KeyBase` / `sanitizeKey` 都做 sanitize + lowercase),所以在大小写敏感的文件系统上 `Browser:Chromium` 与 `browser:chromium` 仍然是同一把锁。这条靠实现兜底,不靠调用方自觉 —— 但别依赖它:规范化只覆盖大小写与非法字符,拼写不同(`chrome` vs `chromium`)它救不了。
3. **越具体越好**。两把无关的锁比一把大锁好 —— 一把 `browser` 大锁会把所有无关工作串行化,团队很快就会绕过它。
4. 键要能被人读懂。`dir:src/parser` 好过 `dir:a3f2`。

同一个物理资源,必须始终用同一个键。键名变更等于协议变更,要同时改所有调用方。

---

## 4. 两类互斥 + 一个容量维度

三类冲突形态要用三种**取值**表达:两个互斥模式(`exclusive` / `shared`)+ 一个容量模式(`pool`)。少一种就有表达不了的场景。

| 类型 | 例子 | 模式 | 冲突形态 |
|---|---|---|---|
| **A 独占单例** | user-data-dir、固定 CDP 端口、单例应用、**屏幕/输入焦点**、串口 | `exclusive`(slots=1) | 硬失败,或静默劫持 |
| **B 容量** | CPU/内存/GPU、浏览器实例数、API 速率、并发连接 | `pool(slots: N)` | 不失败,退化成慢 → 超时 → OOM |
| **C 共享可变状态** | 同一份工作区文件、git index、数据库、构建缓存 | `exclusive` + 路径前缀键 | 静默污染:成功返回但结果错 |

`shared`(多读者)是第三种取值,**但还没有独立语义**:参考实现里它与 `exclusive` 行为完全相同(同样只允许一个持有者),因为还没遇到真实需要的场景,不猜着实现。要表达 C 类资源,用 `exclusive` + 路径前缀键。

**B 类最容易被漏掉。** N 个 agent 各起一次无头浏览器,谁也不"占锁",但会把内存/CPU 打满、把工具超时撑爆。没有 `pool`,这个病根本表达不出来。

**C 类最难查。** 两个 agent 写同一个文件,两边的工具调用都返回成功,错误要等到下游才暴露。

> 参考实现的当前状态:`exclusive` 与 `pool` 已实现并测过;`shared`(多读者)目前行为等同 `exclusive` —— 还没遇到真实需要,不猜着实现。这是已知局限,不是特性。

---

## 5. 三步走(照做就行)

```powershell
# 以下片段都假定当前目录是仓库根目录(./cli/lease.ps1 是相对仓库根的路径)
$LEASE   = "./cli/lease.ps1"
$ME      = "<你的 agent 名>"          # 由派活方注入更好

# 1) 申请。抢不到就退出码 2,别硬闯。
& $LEASE acquire browser:profile:main -Ttl 5m -Wait 120s -Owner $ME -Reason "导出报表截图"
if ($LASTEXITCODE -ne 0) { Write-Output "BLOCKED: browser:profile:main 被占用,已上报"; exit 2 }

# 2) 干活
try {
    node render.mjs
} finally {
    # 3) 释放。异常路径也必须释放。
    & $LEASE release --all -Owner $ME
}
```

**更省事的写法** —— `run` 自动申请 + 自动释放,连 `finally` 都不用写:

```powershell
& $LEASE run browser:profile:main -Cmd "node render.mjs"
```

`run` 的默认值与铁律一一致:**`-Wait 0`,抢不到立刻失败,不排队**。需要排队必须显式给 `-Wait 120s`。它的 `-Ttl` 默认是 `DSH_RESOURCE_TTL`,缺省 `600s`(命令可能跑很久,但记住这是可被接管的上限)。

**MCP 形态**(客户端已接入本仓库的 MCP server 时,一次申请一个键)。下面是真实的 JSON-RPC 报文,`tools/call` 的 `params` 里是工具名与参数:

```jsonc
// 申请
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"resource_acquire",
           "arguments":{"key":"browser:profile:main","reason":"导出报表截图",
                        "mode":"exclusive","ttlMs":"5m","waitMs":120000}}}
// → result.structuredContent 里有租约 id 与 expiresAt;
//   拿不到就是 result.isError=true,不要自己重试

// 看盘
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"resource_status","arguments":{}}}

// 释放(给 id、给 key、或 all 三者之一)
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"resource_release","arguments":{"id":"lz_7f3a1b2c3d4e"}}}
```

`ttlMs` / `waitMs` 接受数字毫秒,也接受 `"5m"` / `"30s"` 这种字符串(schema 里是 `oneOf: [number, string]`)。

MCP server 与 CLI 指向同一个锁目录时互相排斥。两者必须是同一套锁文件格式,否则"用 MCP 的 agent"和"用 CLI 的 agent"看不见对方,仲裁等于没有。

---

## 6. 三条铁律

### 铁律一:抢不到就如实上报,禁止自己重试硬闯

静默重试把**控制冲突**转化成**时间浪费** —— 你等 60 秒超时再试,编排者还以为你在干活。这是本协议要消灭的头号问题。

正确做法:`exit 2` + 一句给编排者的话(见 §7)。

反例(真实发生过):共享的调试端口被关掉后,agent 自动重试 2 次,两次都撞在同一处,最后把"通道中断"报成"紧急事项"。重试没有带来任何新信息。

### 铁律二:释放写在 `finally` 里

正常结束、异常、Ctrl-C 都要释放。做不到就用 `run` 子命令。

一个永不释放的锁比没有锁更糟:它把偶发冲突变成了永久阻塞。

### 铁律三:资源键必须与 §2 表格一致

写错键名等于没有互斥,而且不会报错 —— 这是最容易**静默失效**的一环,比抢不到锁危险得多。

---

## 7. 撞车时怎么回报(编排者能直接读懂)

```
BLOCKED on browser:profile:main
持有者: <agent-name> (reason=导出报表截图, 剩余 42s)
我的任务: <task-id / 一句话>
建议: 等它释放,或把本任务改成串行执行
```

一句话里必须有五项:**被占的资源键 + 持有者 + 剩余时间 + 我的任务 + 建议动作**。

一条 `browser:chromium held by <agent> (截图,剩余 12s)` 胜过长篇日志。这就是编排者重新调度所需的全部信息。

---

## 8. 给编排者的职责

1. **派活前先看盘**(在仓库根目录执行;`./cli/lease.ps1` 是相对仓库根的路径):
   ```powershell
   & ./cli/lease.ps1 status
   ```
2. **在任务里声明资源**,让冲突在派活前暴露,而不是开工后才炸:
   ```
   resources: [browser:profile:main]
   ```
3. **同名资源不并发**。要么串行派,要么把独占权指定给一个专职 agent,其它 agent 提需求 —— 但注意:靠提示词约定"指定给某个 agent"本身不具约束力,必须配上 §6 的硬失败才有用。
4. **看到 `BLOCKED` 就重新调度**,不要让子 agent 自己等。

---

## 9. 常见误解

| 误解 | 事实 |
|---|---|
| "我 headless 跑,不用管" | headless 只是没有焦点问题;profile 锁、端口、内存/CPU 照样冲突。 |
| "我每次用临时 profile,所以不冲突" | 不撞锁,但撞**容量**。N 个浏览器进程同时起会打爆内存和工具超时。这正是 `pool` 要解决的。 |
| "抢不到等一下就好了" | 只有调用方显式选 `-Wait` 才等。`acquire` 与 `run` 默认**立即失败**,把决策权留给编排者。 |
| "锁只要拿一次,以后都不用管" | 租约带 TTL。跑超过 TTL 的长任务,要么给足 `-Ttl`,要么中途续期。 |
| "在群里说一声我要用浏览器就行" | 声明不可强制。没有任何东西阻止第二个 agent 直接连上去。见 [CASE-STUDIES.md](CASE-STUDIES.md)。 |
| "再试一次说不定就好了" | 违反铁律一。资源冲突不会因为重试而消失,只会变贵。 |

---

## 10. 退出码

**协议自身的码(机器可读接口):**

| 码 | 含义 | 该怎么做 |
|---|---|---|
| 0 | 拿到租约 / 操作成功 | 继续 |
| 2 | 资源被占、等待超时、`release` 的租约 id 不存在(或已被接管) | **上报,不要重试** |
| 3 | 参数错误(含空 owner、无法解析的时长) | 修命令 |

**`run` 是例外:它透传子进程的退出码,所以取值是任意的。**

| 来源 | 码 | 含义 |
|---|---|---|
| `run` 透传 | 任意(0/1/2/7/…) | 子进程自己的退出码。**子进程返回 2 不代表"资源被占"** |

要区分"没拿到锁"和"命令失败",看 stderr:前者有 `Resource busy` 行且**没有** `Acquired lease` 行;后者一定先打印 `Acquired lease`。需要严格的机器可读契约,就别用 `run`,用 `acquire` + `finally`(§5 三步走)。

退出码是这套协议的机器可读接口。**任何"看起来成功但实际没拿到锁"的实现都是错的** —— 那正是静默劫持的起因。同理,任何"实际没拿到锁却删掉了别人的锁"的实现也是错的:释放前必须核对锁文件里的 `id`/`owner` 与自己的一致(见 README「TTL」一节)。
