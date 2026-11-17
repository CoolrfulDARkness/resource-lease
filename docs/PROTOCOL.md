# 资源租约协议(v2)

> 给 agent 读的规矩 + 给实现读的线路格式。不是论文。
> 派活时把 §2、§4、§12 贴进 prompt 即可;改代码时按 §5–§10 逐条对。
> 设计理由在 [DESIGN.md](DESIGN.md),「我要做 X 声明什么」在 [RESOURCE-CLASSES.md](RESOURCE-CLASSES.md),硬契约在 [RESOURCE-MODEL-v2.md](RESOURCE-MODEL-v2.md)。

**v1 → v2 变了什么(读之前先知道):** 冲突判定从「字符串相等」变成「facet 集合上的谓词」(§6),一次可以原子拿多个资源(§3),owner 多了 `procStart` 用于识别 PID 复用(§7.4),退出码多了 `4`(§9)。**§11 的保证边界必须整段读,不许只读「能保证的」那半。**

---

## 1. 为什么有这份东西

多个子 agent 会同时抢**独占资源**:浏览器实例、调试端口、屏幕输入焦点、单例目录、共享 git 仓库。抢的结果通常是三种:硬失败(报错)、静默劫持(连上了但操作的是别人的)、或容量耗尽(超时/OOM)。

DSH 只有**按 agent 数**的名额限制(`maxActiveSubagents`),没有**按资源**的仲裁。所以资源冲突要靠协议来管。

---

## 2. 什么时候必须申请租约

| 场景 | 资源键 | 模式 |
|---|---|---|
| 起浏览器 / Playwright / `chromium.launch()` / 截图渲染,用固定 user-data-dir | `browser:profile:<名字>` | `exclusive` |
| 只想限制「本机同时开几个 Chromium」 | `browser:instance` | `pool`(建议 slots=2) |
| 连一个已在跑的调试端口 | `browser:cdp:<端口>` | `exclusive` |
| 占固定端口(9222、3000…) | `port:<n>` 或 `port:<lo>-<hi>` | `exclusive` |
| 需要屏幕/输入焦点(headed 操作、SendKeys、点窗口) | `screen:focus` | `exclusive` |
| 只操作某一个窗口 | `window:hwnd:<十进制>` | `exclusive` |
| 装依赖 / 构建 / 跑测试 | `path:<仓库根>` + `proc:<作业名>` | `exclusive` |
| 写共享目录/文件、改 git 仓库(index、切分支、rebase) | `path:<公共祖先目录>` | `exclusive` |
| 发 npm 包 / push / 部署 | `named:publish:<包名>`、`named:deploy:<环境>` | `exclusive` |
| 打供应商限流 API | `api:<provider>:rpm`(`:tpm` / `:concurrent`) | `pool` |

> **v1 的 `dir:` 和 `repo:root` 在 v2 里不是合法类了**,一律改用 `path:`(v2 的 class 只有 `path` / `port` / `proc` / `browser` / `screen` / `window` / `api` / `named`)。老键不会和任何人互斥。

**不需要**申请:只读文件、`git status` / `log`、`_scratch/<agent>/` 下自己独占的临时目录、纯计算、普通网络请求(除非命中限流那条)。

---

## 3. 三步走(照做就行)

```powershell
$LEASE = "./cli/lease.ps1"

# 1) 申请。多个键一次给全,别分几次拿。抢不到就退出码 2,别硬闯。
& $LEASE acquire path:D:/out port:9222 --ttl 300s --reason "构建产物 + 本地预览"
if ($LASTEXITCODE -ne 0) { Write-Output "BLOCKED: 资源被占用,已上报"; exit 2 }

# 2) 干活
try {
    node build.mjs
} finally {
    # 3) 释放。异常路径也必须释放。
    & $LEASE release --all --owner $env:DSH_AGENT_NAME
}
```

**更省事的写法** —— `run` 把租约绑到进程生命周期:进程在租约在,进程退租约走,连 `finally` 都不用写:

```powershell
& $LEASE run --keys "path:D:/out,port:9222" -- node build.mjs
```

> 参数拼写照契约用双横线(`--ttl` / `--reason` / `--owner`);v1 的单横线写法(`-Ttl` / `-Reason` / `-Owner`)是同一个参数的老拼法。**最终以 `lease.ps1 help` 打印的为准** —— 升级后如果只认一种,这份文档要跟着改。

用插件时是对应的三个工具:

```
resource_acquire  { resources: [{ key: "path:D:/out" }, { key: "port:9222" }], ttlMs, reason }
resource_release  { id } | { all: true }
resource_status   { key? , owner? }
```

**`reason` 必填。** 它不是日志,是给主控和别的 agent 判断「该等还是该改道」的唯一输入。

---

## 4. 三条铁律(自 v1 保留,v2 补两条)

1. **抢不到就如实上报,禁止自己重试硬闯。**
   静默重试会把「控制冲突」变成「时间浪费」—— 你等 60 秒超时再试,主控还以为你在干活。这是本协议要消灭的头号问题。正确做法:`exit 2` + 一句给主控的话(§12)。
2. **释放写在 `finally` 里。** 正常结束、异常、Ctrl-C 都要释放。做不到就用 `run`。
3. **资源键必须照规范写。** 写错(`browser:chrome`、`dir:xxx`)等于没有互斥 —— 而且**不会报错**,这是最坏的一种错:你有保护的感觉,没有保护的事实。

v2 补的两条:

4. **一次操作要用的键,一次 acquire。** 分几次拿必然出现「拿到一半」的中间态,而拿到一半的锁等于没有锁。
5. **TTL 按最坏情况给,不按平均值给。** 跑到一半过期 → 被接管 → 两个持有者同时写。这是本协议里唯一能造成**数据损坏**的用法。

---

## 5. 资源键:语法与规范形(canonical)

```
key      := class ":" subject (":" qualifier)*
class    := "path" | "port" | "proc" | "browser" | "screen" | "window" | "api" | "named"
subject  := 非空字符串,不含 ":"(冒号是分隔符)
```

| class | subject 规范规则 |
|---|---|
| `path` | 转绝对路径 → 反斜杠转正斜杠、盘符小写、整串小写 → 解析 `.` / `..` → 去尾部 `/`(根除外)。**不解析符号链接** |
| `port` | 十进制整数,无前导零;区间写 `lo-hi` 且 `lo<=hi` |
| `proc` | 作业名小写;`proc:pid:<n>` 表示具体 PID |
| `browser` | `browser:instance` / `browser:profile:<name>` / `browser:cdp:<port>` |
| `screen` | `screen:focus`(固定)、`screen:pointer` |
| `window` | `window:hwnd:<十进制>` |
| `api` | `api:<provider>:<metric>`,metric ∈ `rpm` / `tpm` / `concurrent` |
| `named` | 原样小写,仅用于兜底 |

**规范形是唯一判等依据。** 写入锁文件前规范化,读出来比较前也规范化。

`sanitize` 只负责把规范形变成**文件名安全**的串(映射非法字符、限长、加短哈希),**不参与语义判等**。拿 `sanitize` 当判等用,会让 `browser:chromium` 和 `browser_chromium` 落进同一个文件名 —— 它们是两个不同资源。

---

## 6. facet 展开:不同写法 = 同一资源

一个 key 会展开成一组 facet,冲突在 **facet 集合**上判定,不在原始 key 上。

```
expandFacets("browser:profile:work")
  → ["browser:profile:work", "path:<该 profile 的绝对路径>"]
```

| 写法 A | 写法 B | 冲突? | 靠哪条 facet |
|---|---|---|---|
| `browser:profile:work` | `path:C:/Users/x/AppData/.../User Data` | ✅ | profile 路径 facet |
| `path:D:/out` | `path:D:/out/sub` | ✅ | 祖先-后代 |
| `path:D:/out` | `path:D:/out2` | ❌ | **按分段比较,不冲突** |
| `port:9222` | `port:9220-9230` | ✅ | 区间重叠 |
| `browser:cdp:9222` | `port:9222` | ✅ | cdp 端口 facet |
| `window:hwnd:197772` | `browser:instance` | ⚠️ | 契约未定,见 §6.2 注 ① |
| `screen:focus` | `window:hwnd:197772` | ❌ | **故意不冲突**,见 §6.2 |

### 6.1 冲突谓词

同一 class 且 subject 冲突,且**不是**「双方都是 `shared`」:

- 双方都 `shared` → **不冲突**(读意图)
- 一方 `exclusive`,另一方 `shared` 或 `exclusive` → **冲突**
- `pool` 按名额算,不按谓词算(见 §6.3)

`subject` 冲突的判定按 class:

| class | 判定 |
|---|---|
| `path` | 相等,或一方是另一方的**路径祖先(分段比较)** |
| `port` | 单值相等,或区间相交 |
| `proc` | 相等 |
| `browser` | 相等;**且** `browser:instance` 与任意 `browser:profile:*` / `browser:cdp:*` 冲突(实例是容器) |
| `screen` / `window` / `api` / `named` | 相等 |

### 6.2 跨 class 的蕴含(集中一张表,不许散落)

- `browser:instance` ⟹ 与所有 `browser:*` 冲突(一个实例容器)
- `browser:cdp:<p>` ⟹ 与 `port:<p>` 冲突
- `browser:profile:<n>` ⟹ 与 `path:<profileDir>` 冲突
- `screen:focus` ⟹ 与 `window:*` **不冲突**。焦点是输入流,窗口是目标对象;两个 agent 可以各持不同窗口但都需要焦点,所以只串行化焦点。**让它们冲突会造成过度串行化。**

> **后果是必须知道的:** 持 `window:hwnd:X` 不保证你的键盘进了 X;持 `screen:focus` 不保证你操作的是对的窗口。要往某窗口送输入 → **两个都拿**。

> **注 ①:`window:hwnd:<n>` 与 `browser:instance` 的判定,契约还没给定论。** 契约 §3.1 的表里给它标了 ⚠️,但 §3.3 的蕴含表没有对应条目(蕴含表只写了 instance ⟹ 所有 `browser:*`、cdp ⟹ port、profile ⟹ path、focus ↛ window)。在契约补清之前按保守方式用:操作某个浏览器窗口时,把 `browser:instance`(或 `browser:profile:*`)、`window:hwnd:<n>`、`screen:focus` **一起声明**。宁可多占一个 facet,不要赌「反正是不同 class」。

### 6.3 全序(多键获取的排序依据)

```
orderKey(facet) := canonicalClass || ":" || canonicalSubject
按 Unicode 码位升序比较
```

这个序**与谁先申请无关、与进程无关、与机器无关**。全部参与者用同一个序,环形等待就不可能形成。跨机场景下如果有人用了不同的序,两台机器会以相反顺序获取 → 跨机死锁。

> `pool` 的名额是**磁盘上的 slot 文件数**,由 `slots` 决定。**所有 agent 对同一个 key 必须用同一个 `slots` 值**,否则一部分人按 2 个名额抢、一部分按 5 个抢,配额必然被打破。

---

## 7. 锁文件格式与存储布局

**这是兼容性契约。改这里等于改 CLI / 插件 / broker 三方。**

### 7.1 路径

| 场景 | 路径 |
|---|---|
| `exclusive` / `shared` | `<lockRoot>/<sanitized-facet>.lock` |
| `pool` | `<lockRoot>/<sanitized-facet>.slot-<N>.lock`(N 从 0 开始) |
| 租约聚合索引 | `<lockRoot>/_leases/<leaseId>.json` |
| 接管后的归档 | `<lockRoot>/<name>.lock.stale.<epochMs>.<pid>`(保留 1 小时) |

`sanitize` = 把非 `[A-Za-z0-9._-]` 的字符替换成 `_`,**并转小写**;超长串按契约要求截断 + 加短哈希。

`lockRoot` 解析顺序(CLI 与插件必须一致):显式配置 → `DSH_RESOURCE_LOCK_ROOT` → `%LOCALAPPDATA%\dsh-resource-lease\locks`。

> **一个 key 可能对应多个锁文件**,因为一个 key 会展开成多条 facet。v1 的「一个 key 一个文件」在 v2 只是一元 facet 的特例。

### 7.2 锁文件内容

```json
{
  "id": "lz_9f2c1a4b7e83",
  "facets": ["browser:profile:work", "path:c:/users/me/appdata/local/.../user data"],
  "mode": "exclusive",
  "slots": 1,
  "slot": 0,
  "owner": {
    "agent": "atk-3",
    "session": "01J8ZK...",
    "pid": 12345,
    "host": "WORKSTATION",
    "procStart": 1763200000000
  },
  "reason": "跑榜单截图",
  "createdAt": 1763200000000,
  "expiresAt": 1763200060000,
  "lockPath": "C:\\Users\\me\\AppData\\Local\\dsh-resource-lease\\locks\\browser_profile_work.lock"
}
```

- **文件存在 = 锁被持有。** 没有「未持有但文件在」的正常状态(例外:`.stale` 归档与 `_leases` 索引,它们不参与判定)。
- `owner` 五个字段全部必填。`procStart` 缺失视为「无法判定存活」→ 只能等 TTL。
- 单 facet 锁也写 `facets` 数组(长度 1)。**不要用 v1 的 `key` 字段表达多键**。

### 7.3 原子性

锁 = **一个文件**,用 `open(O_CREAT | O_EXCL)` 创建(`fs.openSync(path,'wx')` / `FileMode::CreateNew`):一次系统调用里完成「查存在 + 创建」,没有 TOCTOU 窗口。

**绝不要用 `mkdir` / `CreateDirectory` 当锁。** 目录锁的成败取决于「创建时是否抛异常」—— `-Force`、`[System.IO.Directory]::CreateDirectory`、`mkdir -p` 这类写法对已存在目录**不抛**,并发时所有竞争者都会「成功」,互斥静默失效。第一版就踩过(3 个进程抢 2 个名额,3 个全进)。

**接管过期锁靠 rename 当 CAS**:`rename(lock, lock + '.stale.' + now + '.' + pid)` —— 两个进程同时接管同一把过期锁,只有 rename 成功的继续,另一个因源文件已消失而失败。失败即「别人抢先」,**不重试同一把**。

### 7.4 存活判定(优先于 TTL)

| 条件 | 处理 |
|---|---|
| 同 host,pid 不存在 | **立即回收**,不等 TTL |
| 同 host,pid 存在但 `procStart` 不符 | **立即回收**(PID 被复用) |
| 跨 host | **只能靠 TTL** |
| `procStart` 缺失 | 视为不可判定 → 只能靠 TTL |

回收前必须走两条安全规则(少一条就会一把锁两个持有者):

- **读不到内容的锁文件不等于过期。** 那多半是「刚创建、元数据还没写」的活着的持有者。只有文件同时**老于 2s** 才按崩溃残留处理。
- **接管后回读归档副本**:若它是有效未过期的租约,说明抢的是活锁,放回去并视为失败。

---

## 8. 聚合索引 `_leases/`

```
<lockRoot>/_leases/<leaseId>.json
```

内容至少含 `id` 与 `facets`(本租约占用的 facet 列表),用于**按 leaseId 释放一个多键租约**:

```
release(leaseId) → 读索引 → 逐个 removeIfOwned → 删索引
```

三条硬约束:

1. **索引只是索引,facet 文件才是判等依据。** 索引丢了 / 坏了 / 被删了,互斥仍然正确 —— **索引损坏不能导致死锁**(测试里有专门一条:删掉索引,互斥仍成立)。
2. **索引可以被重建**:扫一遍 `<lockRoot>`,按 `id` 把 facet 归组即可。
3. **释放必须校验所有权**(`removeIfOwned`)。否则「过期 → 被接管 → 旧持有者释放」会删掉新持有者的有效锁,第三个 agent 立刻进来,而新持有者仍以为独占。

---

## 9. 错误码与退出码

### 9.1 CLI 退出码

| 码 | 含义 | 该怎么做 |
|---|---|---|
| 0 | 成功 | 继续 |
| 2 | 冲突(资源被占)/ 等待超时 / 找不到该租约 id | **上报,不要重试** |
| 3 | 参数错误(含空 owner、非法 key) | 修命令 |
| 4 | 后端 / IO 错误(锁根不可写、broker 不可达) | **上报**;这不是「被占」,别换键硬闯 |

`run` 是例外:**它透传子进程的退出码**,取值任意,子进程返回 2 不代表「资源被占」。区分办法看 stderr:有 `Resource busy` 且无 `Acquired lease` = 没拿到锁;有 `Acquired lease` = 锁拿到了、命令本身失败。

### 9.2 冲突载荷(必须含这五项)

```json
{
  "ok": false,
  "conflicts": [
    {
      "facet": "path:d:/out",
      "heldBy": { "agent": "atk-3", "session": "...", "pid": 1234, "host": "PC-01" },
      "reason": "跑榜单截图",
      "expiresInMs": 12000,
      "mode": "exclusive"
    }
  ],
  "released": ["port:9222"]
}
```

- **冲突 facet**(不是你写的 key) —— 因为挡住你的可能是展开出来的 facet
- **持有者**(agent / session / pid / host)
- **reason**
- **剩余 TTL**
- **已回滚的键**(部分失败时,让调用方知道现在手上还剩什么 —— 正确答案是「什么都不剩」)

少任何一项,主控就得去翻日志,可见性就破了。

### 9.3 插件工具的错误形态

`resource_acquire` 冲突时抛错,错误文本必须让模型能自己决策,形如:

```
Resource busy: path:d:/out - held by atk-3 (exclusive, 41s left, reason: 跑榜单截图).
Wait for the holder to release it (or let its TTL expire), then acquire again.
```

`4` 类后端错误必须是**独立的错误类型**,不能伪装成 `2`(冲突)。把「broker 不可达」报成「资源被占」会让调用方一直等一个永远不会来的释放。

---

## 10. CLI ↔ 插件互通约定

**这是本设计存在的主要理由之一:两套仲裁互相看不见,等于没有仲裁。** v1 已实测双向互通,v2 要求保持。

### 10.1 必须一致的东西

| 项 | 约定 |
|---|---|
| 锁根目录 | 同一解析顺序(§7.1)。默认值就互通 |
| 锁文件名 | 同一 `sanitize(canonical facet)` 规则 |
| 锁文件内容 | 同一 JSON 字段(§7.2)。**新增字段只能加,不能改名或改语义** |
| 判定依据 | facet 文件;索引只用于按 leaseId 释放 |
| 接管规则 | 同一 CAS(rename)+ 同一两条安全规则 |
| 存活判定 | 同一 `procStart` 规则 |
| 全序 | 同一 `orderKey`(跨机也一致) |

### 10.2 已经实测的互通方向

| 方向 | 结果 |
|---|---|
| 插件取锁 → CLI `status` | ✅ 能列出 |
| 插件取锁 → CLI `acquire` 同键 | ✅ 退出 2,报出持有者与剩余时间 |
| 插件取锁 → CLI `release <id>` | ✅ 能释放(靠 `_leases` 索引) |
| CLI 取锁 → 插件 `resource_status` | ✅ 能看见 |
| CLI 取锁 → 插件 acquire | ✅ 不会接管未过期的锁 |

### 10.3 三个必须知道的不对称

1. **owner 命名空间不同。** 插件把 owner 自动填成调用方 agent 的 **session id**;CLI 用 `--owner`(缺省 `pid:<PID>`)。所以**插件的工具守卫不认 CLI 取的锁** —— 一个 agent 用 CLI 拿了 `screen:focus`,插件的 guard 仍会拒绝它的受保护工具。**要混用就统一用同一层取锁。**
2. **跨进程释放能力不同。** 插件的 `release(id)` 只释放**本进程**(内存里,或索引里 `pid` 等于本进程的);跨进程释放用 CLI 的 `release <id>`。
3. **`shared` 在两层都还是「单锁文件」。** 谓词层面 `shared`+`shared` 放行,但磁盘上仍是一个文件,所以它既不能给你真并发,也不能防写冲突。**真需要并发用 `pool`。**

> v2 的锁文件比 v1 多 `facets` 数组和 `owner.procStart`。**三方必须同版本部署** —— 老版本读到 v2 锁时的行为(忽略未知字段继续判等 vs 拒绝)契约未定义,不要依赖。

---

## 11. 保证边界(整段读,不许只读前半)

契约 §8 的边界,原样落在这里。

> 本节与 [DESIGN.md](DESIGN.md) §4 同源。**改一处必须改另一处**,包括措辞强度 —— 一处说「保证」、另一处说「尽力」的分歧,比没有文档更糟。

### ✅ 真保证(有测试守护)

- **已声明资源上的互斥**(G1)
- **多资源获取无死锁**(G2)
- **持有者崩溃后自动回收**(G3)—— 注意:同 host 才立即,跨 host 只能等 TTL
- **不同写法的同一资源能识别为冲突**(facet 展开)
- **跨进程、跨 session、跨 harness 实例**

### ⚠️ 尽力而为(有用,但不是保证)

- **没声明的资源。** 没有机制能阻止一个 agent 直接写文件或直接 `spawn()`。观测式守卫只覆盖**经由受保护工具**、且参数能规范化识别的调用。
- **受保护工具的覆盖面。** `protectedTools` 里登记的工具才受守卫;shell 拼接、编码过的路径、绕过工具的直接写,全部漏过。
- **跨机崩溃回收。** 只有 TTL,没有即时回收(拿不到对方进程表)。

### ❌ 做不到(直说)

1. **没声明的资源** —— 这是「先声明再使用」这种仲裁的结构性边界。
2. **符号链接 / 硬链接指向同一 inode** —— 路径规范化不解析符号链接(解析会引入 TOCTOU)。两个不同路径写法指向同一文件时可能识别不出来。
3. **跨机且 broker 不可达** —— 跨机互斥失效。此时**必须明确报错并降级为只读,不许静默继续**。
4. **进程内部的线程/协程竞争** —— 租约粒度是「持有者进程/会话」,进程内互斥自己加。
5. **NFS/SMB 上的 `O_EXCL` 不可靠** —— 跨机必须走 broker,**不要共享锁目录**。

> 用户要的「保证不撞车」,准确表述是:**声明过的资源上是真保证;没声明的是尽力而为 + 可观测;上面 5 条根本做不到。**
> 任何把这句简化成「基本能保证」的转述,都会让人关掉自己的小心 —— 那比没有保证更糟。

---

## 12. 撞车时怎么回报(主控能直接读懂)

```
BLOCKED on path:D:/out
冲突 facet: path:d:/out
持有者: atk-3   pid=14568   host=PC-01   reason=跑榜单截图   剩余 12s
我的任务: def-208 生成社交卡片
建议: 等 12s 后重试,或把本任务改成串行执行
```

一句话里要有:**被占的资源键 + 冲突 facet + 持有者 + 剩余时间 + 我的任务 + 建议动作**。

**不要这么写**:「资源被占用,失败」(主控无法决策)、「重试 3 次仍失败」(把控制冲突变成时间浪费)。

---

## 13. 给 Lead(主控)的职责

1. **派活前先看盘**:
   ```powershell
   & "./cli/lease.ps1" status
   ```
2. **在任务里声明资源**,让冲突在派活前就暴露,而不是开工后才炸:
   ```
   resources: [path:D:/out, port:9222]
   ```
3. **同名资源不并发。** 要么串行派,要么把独占权指定给一个专职 agent,其它 agent 提需求。并行改代码请开 `git worktree`(各持自己的 `path`)。
4. **看到 `BLOCKED` 就重新调度**,不要让子 agent 自己等。看到 `exit 4` 更要注意 —— 那是后端/IO 问题,重派不会好。
5. **给每个 agent 划端口段/目录段**,写进任务模板。区间法是并发下唯一不需要协调的分配方式。

---

## 14. 常见误用

| 误用 | 为什么错 | 正确做法 |
|---|---|---|
| **用目录当锁**(`mkdir` 成功就认为拿到锁) | 目录锁的成败取决于「创建时是否抛异常」:`-Force`、`CreateDirectory`、`mkdir -p` 对已存在目录**不抛**,所有 racer 都「成功」,互斥静默失效 | 锁必须是**文件** + `O_CREAT\|O_EXCL`,单次系统调用判定 |
| **按路径裸删锁文件**(`Remove-Item *.lock`、`del <key>.lock`) | 删掉的可能是活着的有效租约(文件存在 = 有人持有),也可能是别人刚接管的新锁。结果:两个或三个持有者同时以为自己独占 | 用 `release --id`(校验所有权)或 `removeIfOwned`;残留靠 `status` 里的 `EXPIRED(takeable)` 走接管流程 |
| **以为 `shared` 能防写冲突** | `shared` 只表达读意图;`shared`+`shared` 是**放行**的。两个要写的 agent 都用 `shared`,谁都不挡谁。而且磁盘上 `shared` 仍占单锁文件,你还会意外串行化 | 会写就用 `exclusive`;要并发读用 `pool` 或不声明 |
| **把 `screen:focus` 和 `window:<hwnd>` 当同一件事** | 它们故意**不**冲突:焦点是输入流,窗口是目标对象 | 往某窗口送输入 → 两个都拿,一次 acquire |
| **沿用 v1 老键**(`dir:`、`repo:root`、`browser:chromium`) | v2 的 class 表里没有它们 → 不与任何人互斥,且**不报错** | `path:<绝对路径>`、`browser:profile:<name>`、`browser:instance` |
| **多键分几次 acquire** | 拿到第一个、第二个失败 → 持有一半资源又不敢动,最后忘了释放 | 位置参数一次给全 |
| **把 `4` 当 `2` 处理** | broker 不可达 / 锁根不可写被当成「资源被占」,于是你一直等一个永远不会来的释放 | `2` = 有人占着(等或改道);`4` = 环境坏了(上报,别换键硬闯) |
| **以为取了租约就自动生效、自动保护** | 租约是**协作约定**,不是操作系统围栏:它只约束「也来取租约的人」。第三方进程、不带仲裁的脚本、直接 `spawn` 的构建,全都不受约束 —— 这是 §11 的结构性边界 | 在任务模板里要求所有协作方走同一层(CLI 或插件);对不受控的进程只能靠作业级串行和审计 |

---

## 15. 一句话

> 多键一次拿完,TTL 按最坏给,抢不到就上报,删锁只能按 leaseId 删。
> 剩下的所有细节,都是为了让**别人的正确写法**和**你的正确写法**能互相看见。
