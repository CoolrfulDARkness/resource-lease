# 资源仲裁层 v2 —— 契约规格

版本 v2.0 · 2026-11-17 · Lead 设计
前身:[DESIGN.md](DESIGN.md)(v1,单键独占/容量/共享)
本文是**实现契约**。CLI、插件、后端三方必须按本文语义实现,否则互相看不见对方。

---

## 0. v1 → v2:补的是什么

v1 的非目标里有三条,正是"任何形态都不撞车"缺的部分:

| v1 明确不做 | v2 必须做 | 为什么 |
|---|---|---|
| 不做跨机器租约 | 后端抽象 + 网络 broker | "任何形态"包含多机 |
| 不做自动资源推断 | facet 展开 + 观测式冲突检测 | 没声明的资源也要能撞见 |
| 不做优先级抢占 | 仍不做(见 §9) | 抢占会把冲突变成数据损坏 |

v2 真正新增的三个地基:

1. **冲突不再是字符串相等** —— 变成 facet 集合上的谓词(§3)
2. **多资源原子获取** —— 一个操作通常同时占多个资源(§4)
3. **存活判定优先于 TTL** —— 死进程立即回收,不等超时(§5)

---

## 1. 三条不可退让的保证

写进实现和测试的硬约束:

- **G1 互斥**:任意时刻,同一 facet 上不存在两个互斥持有者。
- **G2 无死锁**:多资源获取不可能形成环形等待。
- **G3 可自愈(同机)**:**同一台机器上**的持有者进程死亡后,其租约在下一次观测时被回收,不依赖 TTL 到点。
  跨机只能靠 TTL —— 没有 broker 的实时心跳,任何"立即"都是做不到的承诺。见 §5。

> G3 必须带"同机"限定。不加限定就变成做不到的承诺,而做不到的承诺会让人关掉自己的防护。

> 这三条能保证的是"**已声明资源上不撞车**"。
> 没声明的资源不可能被保证 —— 见 §8 的诚实边界。

---

## 2. 资源键语法与规范形

```
key      := class ":" rest
class    := "path" | "port" | "proc" | "browser" | "screen" | "window" | "api" | "named"
rest     := 按 class 解析;除 path 外,subject 与 qualifier 以 ":" 分段
```

**`path` 类是唯一例外:第一个 `path:` 之后的整串都是 subject。** 因为绝对路径本身
必然含冒号(`path:C:/Users/x`、`path:\\\\server\\share`),按 `:` 分段会把路径切碎。
其他 class 的 subject 仍不含 `:`。

**`path` 必须是绝对路径。** 相对路径(`path:out`)的 canonical 形会依赖 `process.cwd()`,
而两个 cwd 不同的 agent 会把同一个相对路径规范成不同绝对路径 —— 互斥会**悄悄失效**,
且失败方向是"以为防住了其实没防"。所以:

- 相对路径一律**报参数错误**(插件抛错、CLI 退出码 3),不猜、不用 cwd 兜底
- 调用方要传相对路径,自己先 `path.resolve()` 或用 `pathKey()` 转成绝对路径
- `pathKey(input)` 接受裸路径或带前缀路径,产出规范的 `path:` key(§9 的守卫需要它)

> 这条与 §3.4「与进程无关」是同一个原则:任何让 canonical 形依赖进程状态的输入,
> 都会让互斥在跨进程场景下静默失效。

**规范形(canonical)是唯一判等依据。** 写入锁文件前必须规范化,读出来比较前也必须规范化。

| class | subject 规范规则 |
|---|---|
| `path` | 转绝对路径 → Windows 下反斜杠转正斜杠、盘符小写、整串小写(大小写不敏感)→ 解析 `.`/`..` → 去尾部 `/`(根除外)。**不做符号链接解析**(见 §8 边界) |
| `port` | 十进制整数,无前导零;区间用 `lo-hi` 且 `lo<=hi` |
| `proc` | 作业名小写;`proc:pid:<n>` 表示具体 PID |
| `browser` | `browser:instance` / `browser:profile:<name>` / `browser:cdp:<port>` / `browser:origin:<host>` |
| `screen` | `screen:focus`(固定)、`screen:pointer` |
| `window` | `window:hwnd:<十进制>` |
| `api` | `api:<provider>:<metric>`,metric ∈ {rpm, tpm, concurrent} |
| `named` | 原样小写,仅用于兜底 |

`sanitizeKey()` 只负责把 canonical key 变成**文件名安全**的串(映射非法字符、限长、加短哈希),**不参与语义判等**。语义判等永远用 canonical key。

### 2.1 v1 键名的迁移(必须显式,不许静默)

v1 的存量键名里有三个**不在** v2 class 表里,而存量文档、模板、配置示例全在用:

| v1 写法 | v2 等价写法 | 处理 |
|---|---|---|
| `dir:<路径>` | `path:<绝对路径>` | **别名,自动改写**并 warn 一次 |
| `repo:root` | `path:<仓库根绝对路径>` | 别名,需配置仓库根;未配置时按未知处理 |
| `browser:chromium` | `browser:instance` | 别名,自动改写并 warn 一次 |
| 其他未知 class | — | **按方向分流,见下** |

**未知 class 的处理:接受为不透明单例,但对"近似已知 class"告警。**

```js
parseKey('race:key')   // known=false, canonical='race:key' —— 合法的任意资源名
parseKey('paht:d:/out') // known=false, 但 warn: 'paht' 与已知 class 'path' 只差一个字符
```

理由(这是实现期达成的结论,推翻了本文早期草案"一律硬失败"):

- 任意资源名是**合法需求**。`race:key`、`build:key`、`csv:key` 这类名字在真实调用方里大量存在,
  硬失败会让存量调用方当天全报错,而收益只是"早发现拼写错误"。
- 真正的风险只有一种:**把已知 class 拼错**,于是本该冲突的两个键静默不冲突。
  这种情况用**近似匹配**抓(与已知 class 的编辑距离 ≤ 1),既精准又不误伤。
- 不透明单例的语义必须明确:canonical 原样保留、只按**相等**判冲突、**不展开任何 facet**。

**近似告警是"必须做",不是"可选":** 漏掉它,`paht:` 这类错字就会静默失去保护,
而这正是本设计存在的理由。告警走与降级告警相同的通道(每键一次)。

| 方向 | 行为 |
|---|---|
| **新申请**,class 是已知 class 的近似拼写 | 接受,但**必须告警** |
| **新申请**,class 与已知 class 无关 | 接受,静默(合法的自定义资源名) |
| **读已有锁文件**,任意未知 class | 接受,不抛错(否则读不出别人的锁,反而制造盲区) |

> 早期草案写的"一律硬失败"已废弃:它会把合法的自定义键名当成错误,而且与磁盘存量锁文件不兼容。

三个已知别名必须**在一处集中定义**(与 §3.3 的蕴含表同一个模块),并各自 `warn` 一次,让存量调用方知道自己在用旧写法。

---

## 3. 冲突关系(本设计的核心)

### 3.1 facet 展开

一个 key 会**展开成一组 facet**。冲突在 facet 集合上判定,不在原始 key 上。

```js
expandFacets("browser:profile:work") 
  → ["browser:profile:work", "path:<该 profile 的绝对路径>"]
```

这解决了一类最隐蔽的撞车:**两个 agent 用了不同写法的同一个资源**。

| 写法 A | 写法 B | 是否冲突 | 靠哪条 facet |
|---|---|---|---|
| `browser:profile:work` | `path:C:/Users/x/AppData/.../User Data` | ✅ | profile 路径 facet |
| `path:D:/out` | `path:D:/out/sub` | ✅ | 祖先-后代 |
| `port:9222` | `port:9220-9230` | ✅ | 区间重叠 |
| `browser:cdp:9222` | `port:9222` | ✅ | cdp 端口 facet |
| `window:hwnd:197772` | `browser:instance` | ⚠️ | 见 §3.3 蕴含关系 |
| `path:D:/out` | `path:D:/out2` | ❌ | 前缀必须按路径分段比,不能裸字符串前缀 |

**`path` 的祖先判定必须按路径分隔符分段**,`D:/out` 与 `D:/out2` 不冲突。这是 v1 最容易写错的地方。

### 3.2 冲突谓词

对 facet `fa`(已被 A 以模式 `ma` 持有)与 `fb`(B 想以模式 `mb` 获取):

```
conflict(fa, fb, ma, mb) :=
     sameClass(fa, fb) && subjectsConflict(fa, fb)
  && !(ma == shared && mb == shared)          // 共享读之间不冲突
```

**这个谓词的适用范围必须收窄,否则 pool 会退化成 1 个名额:**

`facetsConflict` **只用于 `exclusive` / `shared` 的准入预检,不得用于 `pool` 的准入判定。**

原因:pool 的容量由 **slot 文件**表达(§4.1 step 4),不是由 facet 冲突表达。按上面的字面公式,
`pool + pool` 在同一 facet 上会判成冲突,于是 `slots=2` 的池永远只放行 1 个。
lock.js 的准入逻辑因此是两层:`facetsConflict` 做 exclusive/shared 预检,slot 文件做 pool 计数。

实现上允许把 `COMPATIBLE_MODES` 扩成 `['shared','pool']`(让 `pool+pool` 在该谓词里返回 false),
但**这只是让谓词更宽容,不能替代 slot 文件计数** —— 两种做法都必须保证 §11 #12 成立。

`subjectsConflict` 按 class:

| class | 判定 |
|---|---|
| `path` | 相等,或一方是另一方的**路径祖先**(分段比较) |
| `port` | 单值相等,或区间相交 |
| `proc` | 相等 |
| `browser` | 相等;**且** `browser:instance` 与任意 `browser:profile:*` / `browser:cdp:*` / `browser:origin:*` 冲突(实例是容器)。**不同 `browser:origin:<host>` 之间不冲突** |
| `screen` | 相等 |
| `window` | 相等 |
| `api` | 相等(名额由 pool slots 表达,不靠键) |
| `named` | 相等 |

### 3.3 跨 class 的蕴含

少数跨类冲突必须显式编码,否则会漏:

- `browser:instance` ⟹ 与所有 `browser:*` 冲突(一个实例容器)
- `browser:cdp:<p>` ⟹ 与 `port:<p>` 冲突
- `browser:profile:<n>` ⟹ 与 `path:<profileDir>` 冲突(§3.1)
- `screen:focus` ⟹ 与 `window:*` 冲突吗?**不。** 焦点是输入流,窗口是目标对象;两个 agent 可各持不同窗口但都需要焦点 → 焦点本身由 `screen:focus` 串行化。**不要**让 `screen:focus` 与 `window:*` 冲突,否则会过度串行化。

> 蕴含关系集中定义在 `resources.js` 的一个表里,**不允许散落在调用点**。新增一类资源时只改这张表。

### 3.3.1 facet 展开的数据来源(配置,不是魔法)

`browser:profile:<name>` 要展开出 profile 目录的 path facet,但**这个映射是环境相关的**,不能硬编码。
解析顺序**必须按下面的优先级逐级回落,且 CLI 与插件逐级一致**:

1. **显式别名表**(最高优先):函数参数 `aliases` 或插件配置 `config.aliases`,
   形如 `{ "browser:profile:work": "C:/Users/x/.../User Data" }`
2. **环境变量** `DSH_BROWSER_PROFILE_ROOT` 存在时:`<该变量>/<name>`
3. **默认根**:`%LOCALAPPDATA%/dsh-resource-lease/browser-profiles/<name>`
   (非 Windows 用 `$XDG_DATA_HOME/dsh-resource-lease/browser-profiles/<name>`)
4. 以上都不成立 → **不展开**,只保留自身 facet,并报告为未解析别名

> **这一条是跨实现互通的硬要求。** 如果 CLI 和插件各自算出不同的 profile 路径,
> `browser:profile:work` 在两边会得到不同的 path facet,**互不冲突**,§11 #4 就形同虚设。
> 曾经出现过这种分歧(CLI 用默认根、资源模型只认别名),所以现在把回落链写死。
> 真实场景(用户自己的 Edge profile)应当用第 1 条显式配置别名,不要依赖默认根。

**静默不展开是危险的**:调用方以为写了 `browser:profile:work` 就防住了那个目录,实际上没防。
所以未解析的别名要能被观测到:`expandReport(key)` 的 `unresolved` 数组,
`browser:profile` 行的 `unresolved` 必须是 `'required'`(缺映射=目录没被保护)。

`expandFacets(key, options)` 的第二个参数:`{ aliases, profileDirs, base }`。
`resources.js` 必须导出 `unresolvedAliases()` 与 `expandReport()`。

### 3.4 全序

需要一个**全局稳定全序**用于多键获取排序(§4)。

```
orderKey(facet) := facet 的 canonical key 全文(含 class、subject 和全部 qualifier)
比较方式        := 按 UTF-16 码元序(ordinal)升序
```

**两条都是硬要求,写错就破坏 G2:**

1. **必须包含 qualifier。** 早期草案写成 `class:subject`,丢了 qualifier,于是
   `browser:profile:a` 与 `browser:profile:b` 得到**同一个** orderKey。
   两个进程分别以 [a,b] 和 [b,a] 请求时,排序结果都保留各自入参顺序 →
   环形等待仍可能发生,**正是 G2 要挡的死锁**。所以排序键就是 canonical key 本身。
2. **必须是 UTF-16 码元序,不是 Unicode 码位序。** PowerShell 的
   `[StringComparer]::Ordinal` 是码元序,Node 的 `<` 也是码元序;而"码位序"
   在国际码位(如 emoji 出现在 profile 名里)会与前者分叉,导致 CLI 与插件
   排出不同顺序 → 跨机死锁。统一成码元序,两边天然一致。

不要引入"长度优先"之类的附加规则 —— 那是对同一批数据定义第二个序,只会制造分叉。
前缀关系由码元序自然处理(短的是长的前缀时排在前)。

这个序必须与"谁先申请"无关、与进程无关、与机器无关。

---

## 4. 多资源原子获取

### 4.1 算法(必须逐字实现)

```
acquire(requests[], ttlMs, reason, strategy):
  1. 对每个 request 求 facets;收集 (facet, mode, slots)
     同一 facet 重复出现 → 合并:mode 取更强(exclusive > shared),slots 取 max
  2. 按 orderKey 升序排序          ← 全序保证无环形等待 (G2)
  3. acquired = []
  4. for each facet in order:
       slot = 尝试获取(exclusive 用单文件;pool 用最低空闲 slot)
       if 失败:
          strategy == fail  → 回滚 acquired(逆序释放),返回冲突详情
          strategy == queue → 轮询直到 waitTimeout,仍失败则同样回滚
       acquired.push(slot)
  5. 全部成功 → 写租约记录(一个 leaseId 覆盖多个 facet)
  6. 返回 { id, facets, expiresAt }
```

**回滚必须逆序且必须验证所有权**(`removeIfOwned`),否则会删掉别人的锁 —— v1 已在此处踩过坑。

### 4.2 租约记录

一个 `leaseId` 对应**一组** facet。锁文件按 facet 存放(保持与 v1 CLI 兼容),另在索引目录写一条聚合记录:

```
<lockRoot>/<sanitized-facet>.lock          每个 facet 一个文件(v1 兼容)
<lockRoot>/_leases/<leaseId>.json          聚合记录:本租约占了哪些 facet
```

**释放按 leaseId 进行**:读聚合记录 → 逐个 `removeIfOwned` → 删聚合记录。
**TTL 到期按 facet 文件判定**(与 v1 一致),聚合记录只做索引,丢了不影响互斥正确性 —— 这一点很重要:索引损坏不能导致死锁。

**聚合记录的字段集(三方必须一致,新增字段只能追加)**:

```jsonc
{
  "id": "lz_94c8569d991f",        // 必需。与 facet 锁文件里的 id 相同
  "facets": ["port:9222", "..."], // 必需。本租约占用的全部 canonical facet
  "owner": { "agent": "...", "session": "...", "pid": 123, "host": "...", "procStart": 0 },
  "reason": "构建",
  "createdAt": 0,
  "expiresAt": 0,
  "keys": ["port:9222"]           // 可选。调用方原始写法,仅供诊断
}
```

- `id` 与 `facets` 是**唯一必需字段**。读不到这两个字段的记录按"损坏"处理并忽略,不许据此删锁。
- v1 的 `{id, key, path}` 记录仍然可读:缺 `facets` 时退化成 `[canonicalKey(key)]` 单 facet。
- 写入用**先写临时文件再 rename**,避免读到半截 JSON。

### 4.3 部分失败的可观测性

冲突时必须返回**谁挡的**,而不是笼统失败:

```json
{
  "ok": false,
  "conflicts": [
    { "facet": "path:d:/out", "heldBy": {"agent":"agent-a","session":"...","pid":1234,"host":"PC"},
      "reason": "跑报表导出", "expiresInMs": 12000, "mode": "exclusive" }
  ],
  "released": ["port:9222"]        // 已回滚的
}
```

---

## 5. 存活判定(优先于 TTL)

owner 记录的逻辑字段:`{ agent, session, pid, host, procStart }`

**磁盘上有两种合法形态,读取方必须同时接受:**

```jsonc
// 插件写(形态 1):owner 是对象
"owner": { "agent": "agent-a", "session": "s_...", "pid": 1234, "host": "PC", "procStart": 0, "pidGated": true }

// CLI 写(形态 2):owner 是字符串,身份另放 ownerInfo
"owner": "agent-a",
"ownerInfo": { "agent": "agent-a", "session": "...", "pid": 1234, "host": "PC", "procStart": 0, "pidGated": false }
```

- 读侧:先看 `owner` 是否为对象,是则直接取字段;否则取 `ownerInfo`,缺失时把字符串 `owner` 当作 `agent`。
- **`pidGated`(默认 `true`)**:表示这条租约的 pid 可作为存活依据。**CLI 必须写 `false`** ——
  CLI 是一次性进程(acquire 完立刻退出,pid 立即死亡),若参与 PID 回收,每条 CLI 租约都会被
  下一个进程立刻判定"持有者已死"并回收,**互斥会稳定崩溃**。这是实现期发现的,漏掉它压测必挂。
- `procStart` = 进程启动时间(epoch ms,精度秒即可)。**用于区分 PID 复用**。
- 回收规则:
  - 同 `host`、`pidGated` 真、且 `pid` 不存在 → **立即回收**(G3)
  - 同 `host`、`pidGated` 真、且 `pid` 存在但 `procStart` 不符 → 立即回收(PID 被复用)
  - `pidGated` 假,或跨 host → 只能靠 TTL
- 回收前必须走 v1 的两条安全规则:**读不到内容 + 文件老于 2s** 才按崩溃残留处理;**接管后回读归档副本**校验。

> `procStart` 与 `pidGated` 都是 v2 新增。没有 `procStart`,PID 复用会让锁泄漏到 TTL 结束;
> 没有 `pidGated`,CLI 的租约会被立刻误回收。

---

## 6. 后端抽象

```js
interface LeaseBackend {
  tryCreate(lockPath, meta) -> boolean      // O_CREAT|O_EXCL 语义
  read(lockPath)            -> meta | null
  remove(lockPath, leaseId) -> boolean      // 必须校验所有权
  rename(from, to)          -> boolean      // CAS,用于接管
  list()                    -> [{ path, meta }]
  stat(lockPath)            -> { mtimeMs, size } | null
}
```

- `local`(默认):`fs` 实现,零依赖
- `broker`(可选):HTTP 服务实现同一语义,CAS 用 ETag/If-Match。**接口一致是硬要求**,调用方不得区分后端。
- 跨机场景:所有节点指向同一 broker;`lockRoot` 由 broker 管理。

---

## 7. 公开 API 契约

### 7.1 插件工具

```
resource_acquire({
  resources: [{ key, mode?, slots? }] | key: string,   // 单键向后兼容
  ttlMs?, reason, strategy?: "fail"|"queue", waitMs?
})
resource_release({ id } | { all: true, owner? })
resource_status({ key? , owner? })
```

**`reason` 必填**(v1 原则:主控要看得见在干嘛)。

### 7.2 CLI

```powershell
.\lease.ps1 acquire path:D:/out port:9222 --ttl 300s --reason "构建"
.\lease.ps1 acquire browser:profile:work --ttl 600s
.\lease.ps1 release --id <leaseId> | --all --owner agent-a
.\lease.ps1 status [--key <key>]
.\lease.ps1 run --keys path:D:/out,port:9222 -- node build.mjs
```

多键用位置参数并列(不要用逗号串,PowerShell 数组更自然)。

### 7.3 退出码(CLI)

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 冲突(资源被占) |
| 3 | 参数错误 |
| 4 | 后端/IO 错误 |

---

## 8. 保证边界(必须写进文档,不许含糊)

**能保证的:**

- 已声明资源上的互斥(G1)
- 多资源获取无死锁(G2)
- 持有者崩溃后自动回收(G3)
- 不同写法的同一资源能识别为冲突(§3.1 facet)
- 跨进程、跨 session、跨 harness 实例

**不能保证的(诚实边界):**

1. **没声明的资源。** 没有机制能阻止一个 agent 直接 `fs.writeFileSync` 或直接 `spawn()`。观测式守卫(§9)只能覆盖**经由受保护工具**的调用。
2. **符号链接/硬链接指向同一 inode。** 路径规范化不解析符号链接(解析会引入 TOCTOU)。需要时由调用方用同一写法。
3. **跨机且 broker 不可达时。** 退化为各机本地锁,互斥失效 —— 必须**明确报错并降级为只读**,不许静默继续。
4. **进程内部自己开的线程/协程竞争。** 这不是资源租约的职责。
5. **网络文件系统(NFS/SMB)上的 `O_EXCL` 语义不可靠。** 跨机必须走 broker,不要共享目录。
6. **`shared` 目前只是"声明意图",不是真正的多读者。** 判定逻辑允许 `shared + shared` 共存
   (§3.2),但落盘模型是"一个 facet 一个文件 + `O_EXCL`",一个文件装不下两个持有者。
   所以 v2.0 的 `shared` 实际仍是单持有者(v1 行为),**真正的多读者需要"每持有者一个文件"
   或"一个文件多记录"的存储变更,尚未实现**。
   需要并发只读时,当前正确做法是用 `pool` 给出 N 个名额,而不是 `shared`。
7. **8.3 短文件名与符号链接/目录联接不归一。** `path:C:\Users\JOHNDO~1\x` 与
   `path:C:\Users\JohnDoe\x` 指向同一目录,但 canonical 形不同 → 互斥静默失效。
   不解析符号链接是为了避开 TOCTOU(解析与使用之间存在竞态),这个取舍保留;
   **同一资源必须由调用方用同一写法**。跨 agent 协作时建议统一用长名绝对路径。

> 用户要的"保证不撞车"在**声明过**的资源上是真保证;在没声明的资源上是**尽力而为 + 可观测**。
> 把这条边界写清楚,比承诺一个做不到的绝对保证更有价值。

---

## 9. 观测式冲突检测(让"没声明"也能被撞见)

### 9.1 先分清两层,它们不矛盾

守卫必须实现成**两层,按工具分流**,不能混成一个判定:

| 层 | 触发条件 | 语义 | 可关闭 |
|---|---|---|---|
| **L-strict** | 工具名在 `protectedTools` 里 | **必须持租约**,没持有就拒绝 | 否 |
| **L-observe** | 工具名**不在** `protectedTools` 里 | 参数里的资源与**他人已持有**的 facet 相交才拒绝;无人持有则放行 | 是 |

关键:**同一个工具只走一层**。`protectedTools` 里的工具不参与观测式判定,所以"既 strict 又放行"的矛盾不存在。
v1 的 `protectedTools` 语义完全保留,行为不变。

### 9.2 L-observe 的判定

1. 从工具参数里抽出候选资源(路径、端口、URL),**规范化成 facet**
2. 与**当前全部活租约**的 facet 求交(不只是自己的)
3. 若与**他人**持有的 facet 相交 → 拒绝,并指出冲突 facet 与持有者
4. 若相交但**都是自己**持有的 → 放行(自己持有就说明声明过了)
5. 若不相交 → 放行

**这一层是尽力而为,不是保证** —— 参数形态千变万化,不可能穷举。它只降低"忘了声明"的概率,不构成互斥保证。

### 9.3 一个必须先解决的前置问题:身份不对齐

L-observe 要判断"这个 facet 是不是我自己持有的",而**持有者身份的表示在两端不一致**:

- 插件用 **session id**(`agent.session.id`)
- CLI 用**名字或 `pid:<n>`**

后果:CLI 持锁时,插件侧的 agent 会被判成"他人持有"而误拒。

**在身份映射落地之前,L-observe 只能按"任何持有者都算他人"实现(更保守,误拒多于漏放)。**
这是可接受的失败方向 —— 误拒会让 agent 重新申请,漏放会导致静默撞车。

身份映射本身是 v2.1 的事:owner 记录里同时写 `agent`(名字)、`session`、`pid`、`host`,判等时只要**任一字段命中**就算自己持有。

---

## 10. 明确不做

- 优先级抢占(会把冲突变成数据损坏)
- 分布式共识/Raft(过度设计;broker 用简单 CAS 足够)
- 自动推断"这个操作需要哪些资源"(推断错误比漏判更危险)
- 符号链接解析(TOCTOU 风险大于收益)

---

## 11. 测试矩阵(实现必须覆盖)

| # | 场景 | 期望 |
|---|---|---|
| 1 | 两进程同抢 `path:D:/out` | 一个成功一个冲突(G1) |
| 2 | `path:D:/out` vs `path:D:/out/sub` | 冲突(祖先) |
| 3 | `path:D:/out` vs `path:D:/out2` | **不**冲突(分段比较) |
| 4 | `browser:profile:work` vs `path:<profileDir>` | 冲突(facet) |
| 5 | `port:9222` vs `port:9220-9230` | 冲突(区间) |
| 6 | 两进程以相反顺序请求 A,B | 都成功或都失败,**不死锁**(G2) |
| 7 | 多键获取中途冲突 | 已获取的全部回滚,无残留 |
| 8 | 持有者进程被杀 | 下一次 status 立即回收(G3) |
| 9 | PID 复用(procStart 不符) | 立即回收 |
| 10 | `shared` + `shared` | 不冲突 |
| 11 | `shared` + `exclusive` | 冲突 |
| 12 | pool slots=2,三方争抢 | 恰好两个成功 |
| 13 | 索引文件被删 | 互斥仍正确(facet 文件为准) |
| 14 | broker 不可达 | 明确报错,不静默降级 |
| 15 | 回滚时锁已被他人接管 | 不删除他人锁(`removeIfOwned`) |

---

## 12. 交付分工

| 文件 | 内容 | 依赖 |
|---|---|---|
| `plugin/lib/resources.js` | §2 §3 全部(class 表、facet、谓词、全序) | 本契约 |
| `plugin/lib/lock.js` | §4 §5 §6(多键原子、存活、后端) | resources.js |
| `plugin/lib/index.js` | §7.1 §9(工具、guard、上下文) | 上两者 |
| `cli/lease.ps1` | §7.2 §7.3(多键、退出码、同格式锁) | 本契约 |
| `docs/*` | §8 边界、资源分类手册 | 本契约 |

### 3.5 按 origin 分片:让并行写入变安全

`browser:origin:<host>` 存在的唯一目的,是把"并行写入"从**不安全**变成**安全**,
手段是**分片**而不是加锁。

```
不同 host 不冲突 → 两个 agent 各写各的站点,真并行,零协调
同一 host 冲突   → 共享目标的读-改-写窗口无法从浏览器侧关闭,只能串行
```

**为什么必须这样**:实测(见 `tools/_e2e/E2E-RESULT.md`)表明,两个标签页并发写
同一目标时,**服务端有 250ms 读改写窗口的情况下会静默丢一条,而两边都收到 HTTP 200**。
浏览器侧的协调(一个标签、两个标签、两个 profile)对这个危险完全无效 ——
窗口在服务端。能消除它的只有两种办法:

1. **服务端乐观并发**(`If-Match` / ETag) —— 第三方站点不会为我们加
2. **串行**,或者让它们根本不写同一个东西(**分片**)

所以:分工给 agent 时**按站点分**,不是按任务分。任务可以按站点切,也可以按
"读/写"切,但**同一时刻同一个 host 只能有一个写入者**。

> 反面提示:如果一个 agent 拿 `browser:instance`,它会挡住所有 origin ——
> 实例是容器。分片场景下**不要**申请 instance。
