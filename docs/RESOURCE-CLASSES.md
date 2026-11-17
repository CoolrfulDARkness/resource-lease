# 资源分类实用手册

> 回答一个问题:**我要做 X,该声明哪些资源。**
> 规格在 [RESOURCE-MODEL-v2.md](RESOURCE-MODEL-v2.md),规矩在 [PROTOCOL.md](PROTOCOL.md),这一份只讲怎么用。
> 每个场景给四件事:声明什么 / 用什么 mode / TTL 给多少 / 撞上时**长什么样**。

---

## 0. 三条前提,不理解就会用错

1. **你声明的不是一个字符串,是一组 facet。**
   `browser:profile:work` 会展开成「这个 profile 名」+「这个 profile 目录的 path」两个 facet,所以它和另一个人写的 `path:C:/Users/.../User Data` 是**同一个资源**,会互斥。这是 v2 最重要的变化:写法不同不等于资源不同。
2. **一次操作要用的键,一次 acquire 全部拿。**
   分几次拿必然出现「拿到一半」的中间态;拿到一半的锁等于没有锁(第一个键还占着,第二个键已经被人拿了)。
3. **TTL 是给崩溃兜底的,不是给你的正常耗时用的。**
   按最坏情况给 —— 卡住的那一次、要重试的那一次、要等人工确认的那一次。按平均值给,你就会在跑到一半时被接管。

> 找不到对应场景就往下读;读完了还不确定,取**更宽**的键(父目录、整个实例)而不是更窄的。宽了只是串行,**窄了会静默撞车**。

---

## 1. 快速对照表

| 我要做 | 声明 | mode | TTL 建议 |
|---|---|---|---|
| 用 DSH 插件自己的 agent 浏览器跑网页任务 | `browser:instance`(0.6.0 起它**没有调试端口**) | `pool`,slots=2 | 与宿主会话同寿 |
| 自己 `--remote-debugging-port` 起浏览器,用固定 user-data-dir | `browser:profile:<name>` | `exclusive` | 120–300s |
| 连一个**真的在监听调试端口**的浏览器(自建 fleet / 用户已登录实例) | `browser:cdp:<port>` | `exclusive` | 与宿主会话同寿 |
| 往真实 GUI 里打字、点按钮 | `screen:focus`(+ 必要时 `window:hwnd:<n>`) | `exclusive` | 900–1800s |
| 起 dev server | `port:<n>` | `exclusive` | 1800–3600s |
| 装依赖 / 构建 / 跑测试 | `path:<仓库根>` + `proc:npm-install` | `exclusive` | 600–1800s |
| 切分支 / rebase / 改 index | `path:<仓库根>` | `exclusive` | 120–1200s |
| 写一批共享文件 | `path:<公共祖先目录>` | `exclusive` | 300–900s |
| 发 npm 包 / push / 部署 | `named:publish:<name>`、`named:deploy:<target>` | `exclusive` | 300–600s |
| 打有速率限制的 API | `api:<provider>:rpm`(+ `slots`) | `pool` | 30–120s |

---

## 2. 场景一:跑 Playwright / 浏览器自动化

### 先分清三类浏览器,它们的键不一样

**这是 0.6.0 之后最容易写错的一节。** 同样是「操作浏览器」,三类的资源键不同,因为连接方式不同:

| 哪一类浏览器 | 怎么认出来 | 该声明什么 | 为什么 |
|---|---|---|---|
| **A. DSH 插件自己的 agent 浏览器**(0.6.0 起) | 你没有自己 launch,是 `windows_computer_use_*` 工具在用它;`health` 的 `browserLane` 给出 `agentBrowser` / `agentProfile` | **`browser:instance`**(要名额就用 `pool`) | 0.6.0 起它以 `--remote-debugging-pipe` 启动、走继承的 stdio 管道,**不监听 TCP 调试端口** → `browser:cdp:<port>` 对它不适用 |
| **B. 自己用 `--remote-debugging-port` 起的实例** | 启动参数里有 `--remote-debugging-port=<n>`;`tools\browser-fleet.ps1`、`tools\cdp-read.ps1`、`tools\parallel-read.mjs` 这一套 | **`browser:cdp:<n>`**,按需再加 `path:<user-data-dir>` | 它真的有端口,CDP 就是按端口连的;`browser:cdp:<n>` 会展开出 `port:<n>` 的 facet |
| **C. 连你自己已打开、已登录的实例** | 插件「连接现有浏览器」打开,或用 `WCU_BROWSER_CDP_URL` 指向一个 `ws://` CDP 地址 | **`browser:cdp:<port>`**,**独占单例** | 一个已登录的浏览器只有一份会话;两个人同时操作会互相抢同一个页面 |

> **判断标准只看一件事:它有没有在监听 TCP 调试端口。** 有端口 → `browser:cdp:<port>`;没端口 → `browser:instance`。
> 不要因为「我用的是 CDP 协议」就写 `browser:cdp:` —— **A 类也用 CDP**,只是跑在继承管道上,没有端口。

> **A 类打开「保留网站登录」时会多一个可保护的目录。** 那时 `health` 的 `browserLane` 会多出 `keptProfile`
> (本机当前 `keepSignIns:false`,所以实测的 health 里没有这个字段)。除了 `browser:instance`,
> 还可以加 `path:<keptProfile>` 保护这份保留登录的配置目录。

资源键之外还有按键鼠的那一层:

| 你的做法 | 键 | 说明 |
|---|---|---|
| 用某个固定 user-data-dir 起浏览器(B 类或自己 launch) | `browser:profile:<name>` | 会展开出该目录的 path facet,这是最关键的一个 |
| 需要真实键鼠(headed、点窗口、SendKeys) | 再加 `screen:focus` | 输入流是全局唯一的,见下面的坑 |
| 明确只操作某一个窗口 | 再加 `window:hwnd:<十进制>` | 目标对象,与焦点是两件事 |
| 只是读/操作网页(传 `browserTab`) | **不必**加 `screen:focus` | 网页操作在浏览器内部完成,不动桌面鼠标;但若宿主把 `click`/`type_text` 绑进了 `protectedTools`,守卫仍会按**工具名**要求 `screen:focus` —— 那是宿主策略,不是技术必需 |

### mode

- `browser:instance` → **`pool`**(slots 由全员约定)。它既是「N 个 agent 各起一个浏览器把内存打满」的正解(把「几个」变成显式名额,第三人直接失败,而不是大家一起变慢然后工具超时),**也是默认情况下唯一能覆盖 A 类的键** —— A 类每次用临时 profile(目录名带进程号,事先不可知),没有可声明的 profile 键;而实例是容器,与所有 `browser:*` 冲突。
- `browser:profile:<name>` → **`exclusive`**。同一个 user-data-dir 两个进程同时开,后果是 profile 被写坏,或第二个进程静默连到第一个实例上(静默劫持,最难查)。
- `browser:cdp:<port>` → **`exclusive`**。一个调试端口只可能被一个驱动方接管;它同时挡住 `port:<port>` 的持有者(蕴含关系)。
- `screen:focus` → **`exclusive`**,只在你真的要往 GUI 里送输入时拿。

### TTL

- 脚本型(打开、抓取、截图、关闭):**120–300s**。
- 人工节奏的填表/发布(长文、多重验证、等用户确认):**900–1800s**。实测填一篇长文 + 截图核对 + 发布要 5–15 分钟;给 300s 会在填一半时过期,然后下一次点击被守卫拒绝。
- C 类(用户已登录实例):按整个任务给,别按单次点击给 —— 断线重连可能要用户重新授权。

### 典型冲突

profile 型(挡住你的是目录,不是你写的名字):

```
BLOCKED on browser:profile:work
冲突 facet: path:c:/users/me/appdata/local/google/chrome/user data
持有者: agent-a   pid=14568   host=PC-01   reason=填知乎长文   剩余 412s
我的任务: agent-b 生成社交卡片
建议: 改用 browser:profile:scratch 另开一个 profile,或排到 agent-a 之后
```

端口型(挡住你的是端口,不是你写的 browser 键):

```
BLOCKED on browser:cdp:9222
冲突 facet: port:9222
持有者: agent-c   pid=7788   host=PC-01   reason=榜单抓取(自建实例)   剩余 96s
我的任务: agent-d 复用同一个调试端口
建议: 换个端口起自己的实例(--remote-debugging-port=9223),不要抢同一个
```

冲突 facet 可能报 **path**,也可能报 **port** —— 取决于你是哪一类浏览器。这正是 facet 模型的用处:不会因为「名字不一样」而误判成没冲突。

### 四个必须知道的坑

- **0.6.0 的 agent 浏览器找不到调试端口,那不是坏了。** 它走继承管道、不监听 TCP。如果你去翻它的配置目录:`DevToolsActivePort` 的第一行是 **`0`**、第二行是 `devtools/pipe/...` 的路由 —— 端口位就是 0,那是管道地址,不是可连的 TCP 端口,而且每次启动都不一样(打开「保留网站登录」时,这个文件由插件自己写入)。要操作它的网页就用 `browserTab`(`list_windows` 拿到页面 tab id)。
- **`browser:cdp:<port>` 挡不住 A 类,也保护不了它。** 它没有端口 → 不产生 `port:` facet → 你声明 `port:9222` / `browser:cdp:9222` 与它毫无关系。要它排他就用 `browser:instance`。
- **临时 profile 不撞 profile 锁,但撞容量。** 插件自己的 agent 浏览器每次用临时 profile(目录名带进程号),profile 维度确实没人跟你抢;但 N 个浏览器同时跑会把内存和 60s 工具超时打爆。这种「谁也没占锁,但机器死了」的场景只能由 `browser:instance` 的 pool 表达。
- **headless 也要声明。** headless 只是没有焦点问题,profile、容量、端口(如果有)照样冲突。

---

## 3. 场景二:起本地 dev server / 绑端口

### 声明什么

- `port:<n>` —— 单个端口。
- `port:<lo>-<hi>` —— 一段端口(框架会连开好几个时用)。

### mode

**`exclusive`**。绑端口本质是单例:第二个进程绑同一个端口会 `EADDRINUSE`,那是「已经撞了」。租约把它提前成「还没撞就看得见」。

### 怎么选不冲突的端口(照做)

1. 先看盘:`lease.ps1 status`(或 `resource_status`),把已被占的端口列出来。
2. **给每个 agent 划一段**(例如 agent-a → 4100–4199,agent-b → 4200–4299),写进任务模板。区间法是唯一在并发下不需要协调的办法。
3. 避开这些常用默认值:9222(Chrome 调试)、3000/5173/8080(各种脚手架)、5432/6379(数据库)。
4. 把选定的端口**写进任务描述**,让同批任务的其它 agent 不用猜。

### TTL

- 手工调试的长驻 server:**1800–3600s**。
- CI / 一次性:`300s`,并且用 `run` 包装,让退出时自动释放。

### 典型冲突

```
BLOCKED on port:3000
冲突 facet: port:3000
持有者: agent-b   pid=9912   reason=next dev   剩余 1740s
建议: 换到你的号段(4100–4199),不要等 —— 长驻 server 的 TTL 是按小时算的
```

区间写法的人会挡住单值:**`port:9220-9230` 与 `port:9222` 冲突**。所以如果你的框架会连开一段端口,请主动声明区间,别只声明主端口。

### 诚实边界

**动态端口(`port:0`,由系统分配)无法预先声明。** 它落在契约 §8 的「没声明的资源」里,只能靠事后 `status` 或观测式守卫撞见,不算保证。要么固定端口,要么承担这个风险。

---

## 4. 场景三:构建 / 安装依赖 / 跑测试

这是**最容易被漏掉**的一类,因为「跑个构建」听起来不像占资源。

### 声明什么

```powershell
$LEASE = "./cli/lease.ps1"   # 后面几个场景都复用这个变量

& $LEASE acquire "path:D:/repo" "proc:npm-install" --ttl 900s --reason "装依赖"
```

- `path:<仓库根>` —— 覆盖 `node_modules`、`.next`、`dist`、`tsbuildinfo`、`package-lock.json` 全部路径 facet。**锁公共祖先,不要锁到具体子目录**:节点写 `path:D:/repo/node_modules` 的人会被 `path:D:/repo` 的持有者挡住(祖先判定),反过来也成立。
- `proc:<作业名>` —— **为什么需要它**:两个 agent 同时在同一仓库跑 `npm install`,不是「慢一点」,而是互相删对方的 `node_modules`、写坏 `package-lock.json`。更糟的是两边都看不见对方在写 —— 各写各的,谁也没做错什么,结果却坏了。`path` facet 管住目录这一侧,`proc:npm-install` 表达的是「这台机器上这条构建流水线是单例」这层语义:即使用不同 outDir、不同 worktree,同一份共享缓存 / 同一套全局工具链也不该并发。

### mode

**`exclusive`**。构建和测试都是「排他地改写同一份中间产物」,没有安全的并发形态。

### TTL

| 动作 | TTL |
|---|---|
| 首次装依赖(冷缓存) | 900–1800s |
| 增量 install / ci | 300–600s |
| 单次构建 | 300–600s |
| 完整测试套件 | 600–1800s |
| watch 模式 | 不要用长 TTL 硬扛,改用 `run` 包装(见下) |

**watch / 常驻构建不要靠长 TTL。** 用 `lease.ps1 run` 把租约绑到进程生命周期上:进程在,租约在;进程退,租约走。TTL 只在进程被 kill -9 时兜底。

### 典型冲突

```
BLOCKED on path:d:/repo
冲突 facet: path:d:/repo/node_modules
持有者: agent-a   pid=14568   reason=npm install   剩余 733s
我的任务: agent-b 跑单元测试
建议: 等装完再跑(测试会读 node_modules,并发一定读到半成品),或改到独立 worktree
```

### 过度串行化的代价,要认

`proc:npm-install` 的判定是「作业名相等」,不带仓库限定 —— 也就是说两个**不同仓库**同时装依赖也会串行。这偏安全,但确实慢。要不要给不同仓库开不同作业名(例如 `proc:npm-install:repo-a`),取决于契约对 `proc` 带限定符的判定(见 §11「需要契约补的地方」第 3 条)。在补清之前:**宁可串行,不要赌**。

---

## 5. 场景四:改 git 仓库(切分支 / rebase / 改 index)

### 声明什么

`path:<仓库根>` —— v2 里没有独立的 `repo:` 类,仓库就是一棵目录树,用 `path` 的祖先 facet 表达就够,**不需要也不该**另造键。

### mode

**`exclusive`**。

### 什么时候要,什么时候不要

| 动作 | 要吗 |
|---|---|
| `git status` / `git log` / `git diff` | 不要(只读) |
| `git checkout` / `switch` / `commit` / `rebase` / `merge` / `stash` | **要** |
| `git worktree add` | 要(会改 `.git/worktrees`) |
| 只改工作区文件、不碰 git | 可不拿 git 语义的锁,但 `path` 锁照样要拿 |

### TTL

- 切分支 / commit / stash:**120–300s**
- rebase / merge / 解决冲突:**600–1200s**(冲突现场可能很久)

### 典型冲突

```
BLOCKED on path:d:/repo
冲突 facet: path:d:/repo/.git/index
持有者: cliparity   pid=7712   reason=切分支到 feat/v2   剩余 118s
建议: 先看清对方改的是哪个分支;并行改代码请开 worktree,不要排队等 index
```

### 并行改代码的正解:worktree

`git worktree add ../repo-agent-a feat/a` 之后,每个 agent 有自己的目录,`path` facet 天然不重合。**这比排队等 index 锁快一个数量级**,也是唯一能让多个 agent 真正并行写代码的形态。代价是各自 `npm install` 一遍(内存/磁盘),或者共享缓存 —— 后者就要回到场景三的 `proc` 锁。

---

## 6. 场景五:发 npm 包 / git push / 部署

### 声明什么

这一类资源**没有本地对应物**(不是文件、不是端口),冲突面是「同一个外部目标」,所以用兜底类 `named`:

| 动作 | 键 |
|---|---|
| `npm publish` | `named:publish:<包名>` |
| `git push` 到会被别人也推的分支 | `named:push:<仓库>:<分支>` |
| 部署到某环境 | `named:deploy:<环境>` |
| 对外 API 的配额 | 用 `api:<provider>:<metric>`(见场景七) |

### mode

**`exclusive`**。这些动作本身不可并行:两个人同时 publish 同一版本,第二个拿到 403 或者把版本号推成脏状态;两个人同时 deploy 同一环境,后一个覆盖前一个,而两边都以为自己的改法在里面。

### TTL

**300–600s**。别给太短:这类动作经常卡在 OTP、2FA、CI 队列、网络重试上。也别给太长:它挡住的是整条发布链。

### 典型冲突

```
BLOCKED on named:publish:@scope/pkg
冲突 facet: named:publish:@scope/pkg
持有者: lead   pid=4908   reason=发布 v2.1.0   剩余 421s
建议: 不要重试 —— 版本号是单调的,等对方发完确认 published 再发自己的下一个版本
```

### 注意

`named` **不展开 facet,只做相等判定**。所以写法必须统一:`named:publish:@scope/pkg` 和 `named:publish:@Scope/Pkg` 规范化后会一致(整串小写),但 `named:publish:pkg` 和 `named:publish:@scope/pkg` 是两个资源,**互不互斥**。把这类键写进任务模板,别让每个人自己拼。

---

## 7. 场景六:读写同一批文件

### 声明什么

`path:<公共祖先目录>`,用**绝对路径**。相对路径会按规范形转成绝对路径再判等,但别指望「我这边的相对基准」和别人的一样 —— 显式写绝对路径最省事。

### mode

**`exclusive`**(只要会写)。纯读不需要声明。

### 粒度:锁公共祖先,不要锁到文件

| 你的做法 | 结果 |
|---|---|
| A 锁 `path:D:/out`,B 锁 `path:D:/out/sub` | ✅ 冲突(祖先判定) |
| A 锁 `path:D:/out/a.png`,B 写 `path:D:/out/b.png` | ❌ 互不阻挡,但只要有一方要**新建**文件或列目录,这个粒度就漏了 |
| A 锁 `path:D:/out`,B 写 `path:D:/out2` | ✅ **不**冲突(按路径分段比较,不是裸字符串前缀) |

### TTL

按写入时长给,批量生成 **300–900s**;超长批量任务用 `run` 包装。

### 典型冲突

```
BLOCKED on path:d:/out
冲突 facet: path:d:/out
持有者: agent-a   pid=14568   reason=跑报表导出(批量 240 张)   剩余 388s
建议: 你的输出目录是 D:/out/sub —— 它在这个祖先下面,必然被挡。改成 D:/out-def208 再来
```

最后那条建议是这张表里最容易被忽略的:**冲突不是「对方占了我的目录」,而是「我选了一个在别人祖先下面的目录」**。选输出目录时先 `status` 一眼。

---

## 8. 场景七:调用有速率限制的 API

### 声明什么

`api:<provider>:<metric>`,metric 只能是 `rpm` / `tpm` / `concurrent`:

```powershell
& $LEASE acquire "api:openai:rpm" --mode pool --slots 3 --ttl 60s --reason "批量摘要"
```

### mode

**`pool`**,`slots` = 你愿意同时跑多少个。这一类的价值在于把「429 和超时」变成「明确的第三个人失败」。

- `api:<provider>:rpm` → slots ≈ 配额 / 单次消耗
- `api:<provider>:concurrent` → slots = 允许的并发请求数
- `api:<provider>:tpm` → slots 按 token 预算折算

> **slots 必须全员一致。** 它决定磁盘上存在几个 slot 文件;同一个 key 两个人写不同的 `slots`,结果是一部分人按 2 个名额抢、另一部分按 5 个名额抢,配额必然被打破。

### TTL

**30–120s**,一次调用一拿。**千万别给一小时**:占着名额不干活,等于把配额锁死;这类租约的价值密度最高,TTL 也最该短。

### 典型冲突

```
BLOCKED on api:openai:rpm
冲突 facet: api:openai:rpm(pool 2/2 已满)
持有者: agent-a(剩 41s)/ agent-b(剩 18s)
建议: --wait 20s 让 agent-b 先释放,或把自己的并发降到 1 再来
```

名额类冲突**不是「变慢」而是「明确失败」**,这正是它比 429 好的地方:429 你还会重试,失败了三次才发现是配额;租约第一次就告诉你谁占着、还剩多久。

---

## 9. 不需要申请的情况

| 情况 | 为什么不用 |
|---|---|
| 纯读文件、`git status`/`log` | 不改变共享状态 |
| 自己独占的临时目录(`_scratch/<agent>/`) | 没有第二个人会碰 |
| 纯计算、纯内存处理 | 没有共享资源 |
| 普通网络请求(不命中限流) | 不占本机资源 |
| 读别人已经发布好的产物 | 只读 |

**但「我以为是只读」不算理由。** 只要你会写、会建、会删,就按写来声明。

---

## 10. TTL 怎么定(三条经验)

1. **按最坏情况,不按平均值。** 你的构建平时 40s,那一次冷缓存 + 网络抖动可能就是 8 分钟。给 60s 的 TTL 会保证你在第 61 秒被接管,然后两个 agent 同时写。
2. **常驻进程不要靠 TTL,靠 `run`。** 进程在租约在,进程退租约走,TTL 只兜 kill -9。用长 TTL 硬扛常驻进程,等于给崩溃残留预定了几个小时的占用。
3. **越贵的资源,TTL 越短。** `screen:focus` 和 `api:*:rpm` 一秒钟都别多占;`path:<仓库根>` 可以给宽一点,因为接管后的破坏是「别人以为自己在写」。

---

## 11. 需要契约补的地方(用法层面,等 Lead 定)

1. **v1 的老类名(`dir:` / `repo:root` / `browser:chromium`)在 v2 已不是合法类。** 本手册一律改用 `path:` / `browser:profile:*` / `browser:instance`。老配置里残留的老键要么直接报错、要么落成某个 `named`,两种都不会和任何人互斥 —— 而**契约还没明确到底是哪一种**,这一点必须定。
2. **`browser:profile:<name>` → 目录 的映射从哪来** 没写。展开 facet 需要「profile 名 → 绝对路径」这张表,契约只说结果不说来源(配置字段?探测?)。本手册按「配置里有这张表」写。
3. **`proc:` 带限定符时的判定** 没写。`proc:npm-install:repo-a` 与 `proc:npm-install:repo-b` 是否冲突,取决于 subject 是否包含限定符;契约只写了「相等」。本手册一律用不带限定符的作业名(更保守,更串行)。
4. **要不要为管道式浏览器新增 `browser:pipe:<name>` 这类键?判断:不要。** 管道名每次启动随机生成(`\\.\pipe\dsh-wcu-cdp-<32 hex>`),不可预先声明,也拿不到稳定名字,做成键只会是一串没人猜得中的字符串。只需要契约把「管道型浏览器不产生 port facet、只受 `browser:instance` / `browser:profile:` 约束」写成明文 —— 契约 §3.3 已按这个结论补上边界说明。

---

## 12. 常见误用

| 误用 | 为什么错 | 正确做法 |
|---|---|---|
| **沿用 v1 的老键**:`dir:src/parser`、`repo:root`、`browser:chromium` | v2 的 class 只有 `path`/`port`/`proc`/`browser`/`screen`/`window`/`api`/`named`。老键要么解析失败,要么落成别的资源 —— 结果是**你和谁都不互斥**,还以为自己有保护 | 一律 `path:<绝对路径>`、`browser:profile:<name>`、`browser:instance` |
| **以为 `shared` 能防写冲突** | `shared` 只表达「读意图」,冲突谓词里 `shared`+`shared` 是**放行**的。两个都要写的 agent 都用 `shared` = 纯裸奔,写得七零八落也没人挡。而且磁盘上 `shared` 仍占一个单锁文件,你还会意外串行化 | 会写就用 `exclusive`;要并发读就用 `pool` 或干脆不声明读 |
| **把 `screen:focus` 和 `window:<hwnd>` 混为一谈** | 焦点是**输入流**(键盘鼠标发到前台那个窗口),窗口是**目标对象**。它们故意不冲突。只拿 `window` 的人可能一打字打进别人的窗口;只拿 `screen:focus` 的人可能操作了错误的窗口 | 要往某窗口送输入 → **两个都拿**,一次 acquire |
| **用一个键干所有事**:所有浏览器操作都只声明 `browser:instance` | 它只表达「实例容器」,不区分 profile。两个 agent 各拿一个实例名额,却指向**同一个 user-data-dir**,profile 照样被写坏 | profile 锁(`browser:profile:*`)+ 容量锁(`browser:instance` pool)一起拿 |
| **以为 `browser:cdp:9222` 能保护 DSH 自己的 agent 浏览器** | 0.6.0 起那个浏览器用 `--remote-debugging-pipe`,不监听 TCP 端口 → 不产生 `port:` facet。你写的 `browser:cdp:9222` 与它**毫无关系**,既挡不住别人也保护不了它 | 管道型用 `browser:instance`;只有真的带 `--remote-debugging-port` 的实例才用 `browser:cdp:<port>` |
| **0.6.0 之后去找 agent 浏览器的调试端口** | 找不到不是配置问题,是它不再开端口。翻 `DevToolsActivePort`、试 9222 都是死路,还会把「连不上」误判成插件坏了 | 操作网页用 `browserTab`(从 `list_windows` 拿 tab id),资源键用 `browser:instance` |
| **多键分几次 acquire** | 拿到第一个键、第二个键被人占了 → 你已经持有一半资源,又不敢继续,最后忘了释放。这就是死锁和锁泄漏的标准生成方式 | 位置参数一次给全:`acquire path:D:/out port:9222 --reason "构建"` |
| **锁到文件级路径** | 对方新建一个文件不在你的锁范围内;列目录/删目录也不在 | 锁**公共祖先目录** |
| **TTL 按平均值给** | 跑到一半过期 → 被接管 → 两个持有者同时写。这是本设计里唯一能造成**数据损坏**的用法 | 按最坏情况给;常驻进程用 `run` |
| **在锁根目录下手动清理 `.lock` 文件** | 你可能删掉一个活着的有效租约(锁文件存在 = 有人持有)。这不是清理,是制造两个持有者 | 用 `release --id`(会校验所有权)或 `release --all --owner <你>`;崩溃残留靠 `status` 里 `EXPIRED(takeable)` 自动识别 |

---

## 13. 场景八:多个 agent 各写不同网站

**该声明**:`browser:origin:<host>`,每个 agent 一个站点。

```
agent A  ->  browser:origin:zhihu.com
agent B  ->  browser:origin:juejin.cn
agent C  ->  browser:origin:github.com
```

**mode**:`exclusive`(同一站点同一时刻只能一个写入者)。**TTL**:按任务给。

**为什么这样能并行**:不同 host 之间**不冲突**,所以三个 agent 真正同时写,零协调。
同一个 host 会冲突,因为共享目标的读-改-写窗口在服务端,浏览器侧关不掉。

**典型冲突长什么样**:

```
Resource busy: browser:origin:zhihu.com held by agent-a (8s left, reason: 发文章)
```

**坑**:不要在这里申请 `browser:instance` —— 实例是容器,会挡住所有 origin,
把本可以并行的分片任务重新串起来。

---

## 14. 一句话

> 声明要**宽一点**(公共祖先把整片都罩住),TTL 要给**足一点**,多键要**一次拿完**。
> 反过来做的每一种,都对应上面「常见误用」里的某一行。
