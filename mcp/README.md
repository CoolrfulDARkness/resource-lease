# resource-lease-mcp

零依赖、单文件的 **MCP server**,把「资源租约」暴露成任何 MCP 客户端都能用的三个工具。让多个 agent / 多个进程在**浏览器、固定端口、屏幕焦点、共享写目录**这类独占资源上不再硬撞。

锁就是文件:用 `open(O_CREAT|O_EXCL)` 一次系统调用判成败,过期锁靠 `rename` 抢占接管。锁文件格式与 `resource-lease` 的 PowerShell CLI(`cli/lease.ps1`)**逐字节兼容**,所以用 MCP 的 agent 和用 CLI 的 agent 会互相排斥、互相看得见。

```
publish/mcp/
├─ resource-lease-mcp.mjs   单文件实现(约 1200 行,只用 node: 内建模块)
├─ package.json             bin: resource-lease-mcp, "type": "module"
├─ README.md
└─ test/                    协议 / 互斥 / 跨工具 / TTL / 接管 五组测试
```

## 环境要求

- Node.js **>= 18**(任何平台:Windows / macOS / Linux)
- 可选:Windows PowerShell 5.1+,用于跑互通的 `lease.ps1` CLI(没有 CLI 也能单独用)

## 安装与接入

### 0. 先确认它跑得起来

```powershell
node <path-to>/publish/mcp/resource-lease-mcp.mjs --print-lock-root
# 打印实际使用的锁目录,例如 C:\Users\you\AppData\Local\dsh-resource-lease\locks
```

进程启动后用 **stdio 说 JSON-RPC 2.0**(一行一个 JSON),stdout 只有 JSON-RPC,日志全在 stderr。

### 1. Claude Code

命令行添加(推荐,自动写到正确的作用域):

```bash
claude mcp add resource-lease -- node ./mcp/resource-lease-mcp.mjs
```

或项目里放 `.mcp.json`:

```json
{
  "mcpServers": {
    "resource-lease": {
      "command": "node",
      "args": [
        "./mcp/resource-lease-mcp.mjs",
        "--lock-root",
        "C:\\Users\\<you>\\AppData\\Local\\dsh-resource-lease\\locks"
      ]
    }
  }
}
```

### 2. Cursor

`~/.cursor/mcp.json`(全局)或项目内 `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "resource-lease": {
      "command": "node",
      "args": [
        "./mcp/resource-lease-mcp.mjs"
      ],
      "env": {
        "DSH_RESOURCE_LOCK_ROOT": "C:\\Users\\<you>\\AppData\\Local\\dsh-resource-lease\\locks",
        "DSH_AGENT_NAME": "cursor-local"
      }
    }
  }
}
```

### 3. 通用 `mcp.json`(Claude Desktop / Codex / 自研客户端)

任何支持 stdio 传输的 MCP 客户端都吃这一段。**这个包当前还没有发布到 npm**,所以 `npx -y resource-lease-mcp` 现在还拿不到 —— 先用 `command: node` + 绝对路径(下面第一个例子),发布之后再换成 `npx`。

```json
{
  "mcpServers": {
    "resource-lease": {
      "command": "node",
      "args": ["<path-to>/publish/mcp/resource-lease-mcp.mjs"]
    }
  }
}
```

发布到 npm 之后可以简化成:

```json
{
  "mcpServers": {
    "resource-lease": {
      "command": "npx",
      "args": ["-y", "resource-lease-mcp@latest"]
    }
  }
}
```

> 另一个不用发布的办法:`npm i -g <path-to>/publish/mcp`,然后 `"command": "resource-lease-mcp"`。
> 路径建议用绝对路径:客户端的工作目录不一定是这个仓库。

## 三个工具

| 工具 | 作用 | 参数(顶层 key) |
|---|---|---|
| `resource_acquire` | **用资源之前**先拿租约 | `key`(必填)、`reason`(必填)、`mode`、`slots`、`ttlMs`、`waitMs` |
| `resource_release` | 用完立刻还,别等 TTL | `id` / `key` / `all`(三者至少给一个) |
| `resource_status` | 看谁占着什么、为什么、还剩多久 | `key`(过滤)、`includeExpired` |

最小调用:

```jsonc
// resource_acquire
{ "key": "browser:chromium", "reason": "capture checkout screenshots" }

// resource_release
{ "id": "lz_7f3a1b2c3d4e" }

// resource_status
{}
```

`resource_acquire` 返回:

```jsonc
{
  "id": "lz_7f3a1b2c3d4e",       // 释放时用
  "key": "browser:chromium",
  "mode": "exclusive",
  "slot": 0, "slots": 1,        // 仅 pool 模式有意义
  "owner": "pid:24680",         // 缺省是 pid:<server 进程号>
  "reason": "capture checkout screenshots",
  "expiresAt": 1763000000000,   // epoch ms
  "ttlMs": 30000,
  "waitedMs": 0,
  "lockPath": "C:\\...\\browser_chromium.lock",
  "text": "Lease lz_... acquired on \"browser:chromium\" ..."
}
```

### 三种模式(取值与取舍见 `docs/PROTOCOL.md` §4)

| 模式 | 含义 | 典型资源 |
|---|---|---|
| `exclusive`(默认) | 一个持有者 | `browser:profile:main`、`port:9222`、`screen:focus`、`dir:src/parser`、`repo:root` |
| `shared` | 声明只读意图;**磁盘上仍是一个持有者**,与 CLI 行为一致 | `repo:root` 只读查看 |
| `pool` | 每个 slot 一个持有者 | `browser:chromium`(本机建议 2)、`api:<provider>:rpm` |

资源键规范 `<类别>:<具体>`;锁文件名会把非 `[A-Za-z0-9._-]` 的字符替换成 `_`,**并统一转小写**,所以 `browser:chromium` 与 `browser_chromium` 是**同一个资源**,`Browser:Chromium` 与 `browser:chromium` 也是(CLI、插件、本 server 三处规则一致;少了小写这一步,大小写敏感的文件系统上同一把锁会变成两个文件,互斥静默失效)。

### 失败时返回什么

工具错误用 MCP 的 `isError: true` 返回,**进程不会退出**(退出会把进程持有的租约一起丢掉):

```
Resource busy: port:9222 - held by ps-wins (exclusive, 42s left, pid 8740, reason: CLI owns this port).
Wait for the holder to release it (or let its TTL expire), then acquire again.
Pass waitMs to queue instead of failing immediately; do not retry in a loop.
```

持有者、原因、剩余时间、以及下一步该干什么,都在错误里。协议级错误(未知工具名 `-32602`、未知方法 `-32601`、无法解析的行 `-32700`)则按 JSON-RPC 规范返回。

## 配置

### 锁根目录(`lockRoot`)解析顺序

1. 命令行 `--lock-root <dir>`
2. 环境变量 `DSH_RESOURCE_LOCK_ROOT`
3. Windows:`%LOCALAPPDATA%\dsh-resource-lease\locks`
4. 其它平台:`$XDG_RUNTIME_DIR/dsh-resource-lease/locks`
5. 兜底:`<os.tmpdir()>/dsh-resource-lease/locks`

### 命令行参数与环境变量

| 参数 | 环境变量 | 缺省 | 说明 |
|---|---|---|---|
| `--lock-root <dir>` | `DSH_RESOURCE_LOCK_ROOT` | 见上 | 锁目录,必须与 CLI 一致才能互相看见 |
| `--owner <name>` | `DSH_AGENT_NAME` | `pid:<pid>` | 写进租约的 owner |
| `--default-ttl <dur>` | `DSH_RESOURCE_TTL` | `30s` | 租约缺省寿命,如 `30s` / `2m` |
| `--max-wait <dur>` | `DSH_RESOURCE_MAX_WAIT` | `120s` | `waitMs` 的上限 |
| `--print-lock-root` | – | – | 打印解析出的锁目录后退出 |
| `-v` / `-h` | – | – | 版本 / 帮助 |

## 与 PowerShell CLI 互通

两边**必须指向同一个锁目录**(同一个 `--lock-root` 或同一个 `DSH_RESOURCE_LOCK_ROOT`)。

```powershell
# MCP 侧拿到租约后,CLI 立刻看得见
.\lease.ps1 status
# key           mode      owner      reason                  remain  pid
# browser:chromium exclusive  pid:24680  capture screenshots  29.8s  24680

# CLI 想抢同一个 key -> 退出码 2(busy),并报出 MCP 的持有者
.\lease.ps1 acquire browser:chromium --ttl 5s --owner ps-x --reason test
# Resource busy: browser:chromium - held by pid:24680(reason=capture screenshots, 29324ms left)   [exit 2]

# CLI 也能按 id 释放 MCP 创建的租约(靠 <lockRoot>/_leases/<id>.json 索引)
.\lease.ps1 release lz_7f3a1b2c3d4e

# 反过来:CLI 拿的租约,MCP 的 resource_status 一样看得见,acquire 一样被拒
.\lease.ps1 acquire port:9222 --ttl 60s --owner ps-wins --reason "CLI owns this port"
```

盘上布局(与 CLI 完全一致):

```
<lockRoot>/<sanitized-key>.lock              独占 / 共享
<lockRoot>/<sanitized-key>.slot-<N>.lock     pool 的第 N 个名额
<lockRoot>/_leases/<leaseId>.json            索引 { id, key, owner, pid, path },给 CLI 的 release 用
<lockRoot>/<name>.lock.stale.<ms>.<pid>      过期租约的归档(留 1 小时,便于事后取证)
```

锁文件内容(字段固定,改格式等于破坏兼容):

```json
{"id":"lz_...","key":"browser:chromium","mode":"exclusive","slots":1,"slot":0,
 "owner":"pid:24680","reason":"capture screenshots","pid":24680,"host":"MACHINE",
 "createdAt":1763000000000,"expiresAt":1763000030000,"lockPath":"C:\\...\\browser_chromium.lock"}
```

## 生命周期细节

- **TTL 缺省 30s,最小 1000ms**。不释放就过期,过期即可被别人接管(先 `rename` 到 `.stale.*` 的一方赢得接管权)。
- **读不到内容的锁文件不算过期。** 那通常是"刚创建、元数据还没写"的活着的持有者;只有当文件同时老于 2s(崩溃残留)才接管。接管后还会回读归档副本,若发现是有效未过期租约就放回去 —— 否则一把锁会有两个持有者。
- **stdin 关闭 / SIGINT / SIGTERM** 时,server 会释放自己持有的全部租约再退出(退出码 0),不用等 TTL。
- 只释放**本进程持有**的租约:释放前会核对锁文件里的 `pid` 和 `id`。若租约已过期被别人接管,不会误删别人的锁文件。
- `waitMs` 期间每 150ms 轮询一次;超过上限(缺省 120s)后返回 busy 错误。

## 测试

```powershell
cd publish\mcp
node test\run-all.mjs          # 全部
node test\run-all.mjs ttl      # 只跑某个文件
$env:RL_KEEP='1'; node test\run-all.mjs   # 保留临时锁目录,便于失败后取证
```

每个测试文件都在**独立临时锁目录**里跑,不会污染真实的 `%LOCALAPPDATA%\dsh-resource-lease\locks`。

| 文件 | 覆盖 |
|---|---|
| `test/01-protocol.test.mjs` | 真子进程 + 真 JSON-RPC:initialize → initialized → tools/list → acquire → status → release;schema、`isError`、`-32602/-32601/-32700`、stdout 纯净度、锁根优先级、连接关闭时释放 |
| `test/02-mutex.test.mjs` | 两个独立进程同 key 同时抢(只一个成功)、8 进程 × 3 个 key、不同 key 不互相阻塞;以及**对照实验**:`mkdirSync(t,{recursive:true})` 这种幂等形式的目录锁会让 6 个竞争者全都"成功"(裸 `mkdirSync` 反而会抛 `EEXIST`,所以歧义在"哪种写法"),`openSync(...,'wx')` 只让一个成功 |
| `test/03-cross-tool.test.mjs` | MCP 拿锁 → `lease.ps1 status` 看得见 → `lease.ps1 acquire` 退出码 2;CLI 拿锁 → `resource_status` 看得见、MCP acquire 被拒;`lease.ps1 release <id>` 能释放 MCP 的租约;两边缺省锁根一致 |
| `test/04-ttl.test.mjs` | 过期前仍互斥、过期后接管并归档 `.stale.`、`includeExpired`、TTL 下限、`"2s"` 字符串、`waitMs` 排队与超时、双向跨工具接管,以及「过期后旧 id 不得误删新持有者的锁」回归 |
| `test/05-takeover.test.mjs` | 接管的安全性:读不到内容的锁文件**若是新文件**视为"正在写",绝不可抢(抢了就是一把锁两个持有者);**若是老文件**才按崩溃残留接管;同一规则 CLI 与 MCP 一致;TTL 只认 `expiresAt`,不认文件 mtime |
| `test/06-release-fail-closed.test.mjs` | 释放的 fail-closed:锁文件能解析但**没有 string `id`** 时(`{}`、`{"id":123}`、`{"id":null}`、半截 JSON)一律**不删**,只记日志;精确 id 匹配才正常释放 —— 证明守卫不是"一律拒绝" |

`ttlMs` / `waitMs` 在 schema 里声明为 `oneOf: [number, string]`:数字按**毫秒**;字符串带单位(`"500ms"` / `"30s"` / `"2m"`)按单位;字符串里的**裸数字按秒**(`"600"` = 600 秒,与 CLI 的 `-Ttl 600` 一致);解析不了是硬报错,不静默回落。所以做严格 schema 校验的客户端不会在发出前把字符串拒掉。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 客户端里看不到这三个工具 | 用 `node <绝对路径>` 启动试试;stdout 被别的东西写了会直接破坏协议(本 server 不会,但包装脚本可能会) |
| `resource_status` 说没有租约,但 CLI 显示有 | 两边 `lockRoot` 不一致。`--print-lock-root` 和 `lease.ps1 help` 各看一眼 |
| 一直 busy,但没人真的在用 | 那是过期租约;`resource_status` 加 `includeExpired: true` 看 `expired, takeable`,或直接 acquire 一次(会自动接管) |
| 想确认锁文件长什么样 | `Get-Content <lockRoot>\<key>.lock`;字段必须与上面的契约一致 |
| Windows 上跑 CLI 报执行策略错误 | `powershell -NoProfile -ExecutionPolicy Bypass -File lease.ps1 status` |

## 边界与设计取舍

- **这是协作式仲裁,不是安全边界。** 锁是普通文件,同机任何进程都能删;它防的是"多个 agent 互相撞车",不防恶意进程。
- 单机多进程(两个宿主进程、若干 pwsh 子进程、若干 MCP 客户端)足够;不做跨机器租约。
- 不做优先级抢占;`shared` 不是读写锁,磁盘上仍是一个持有者(与 CLI 保持一致,宁可少一个特性也不让两套工具语义分叉)。
- `reason` 是必填的:主控要知道子 agent 在干什么,一条 `browser:chromium held by agent-a (导出报表截图, 剩余 12s)` 比日志有用。
