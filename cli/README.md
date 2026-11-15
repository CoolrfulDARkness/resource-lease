# 资源租约 CLI(零改动层)

不装插件、不改宿主,今天就能用 —— 标题里的"零改动层"就是这个意思:**不动宿主代码、不加插件,一个 `.ps1` 脚本谁要用谁调**。跨进程文件锁,带 TTL 与崩溃自愈。

**平台要求:Windows 专用,需要 PowerShell 5.1+。** 脚本按 Windows PowerShell 5.1 的语义写(见「实现要点」),Linux / macOS 上不能直接跑;跨平台的是 MCP server,两者共用锁格式。

```powershell
# 在仓库根目录执行
$LEASE = "./cli/lease.ps1"
& $LEASE help
```

## 为什么是它,而不是"大家小心一点"

| 光靠约定 | 用这个 CLI |
|---|---|
| 两个 agent 同时起 Chromium,谁也不知道 | 第二个立刻拿到 `exit 2` 和持有者信息 |
| agent 崩了,锁留在那里没人管 | TTL 过期可接管,且有日志 |
| 主控不知道谁占着什么 | `status` 一条命令看全 |
| 冲突表现成"偶发超时",查不出原因 | 冲突表现成明确退出码 |

## 命令

### acquire —— 申请

```powershell
& $LEASE acquire <资源键> [-Mode exclusive|shared|pool] [-Slots N] [-Ttl 30s] [-Wait 120s] [-Owner 名字] [-Reason 说明]
```

成功时把租约 JSON 打到 stdout(含 `id`、`expiresAt`),退出码 0。

```powershell
& $LEASE acquire browser:chromium -Ttl 5m -Wait 120s -Reason "导出报表截图"
```

- `-Ttl` 默认 30s(或 `$DSH_RESOURCE_TTL`)。**长任务务必给足**,否则跑到一半锁被别人接管。没有"续期"操作,lease 不会自动延长。
- `-Wait` 默认 0(立即失败)。要排队就显式给。
- 时长写法(`-Ttl` / `-Wait`,与 MCP 的 `ttlMs` / `waitMs` 同一套规则):数字是毫秒,带单位的字符串(`30s` / `500ms` / `2m`)按单位,**裸数字字符串(`"600"`、`-Ttl 600`)按秒**;解析不了直接退 3,TTL 下限 1000ms。详见 [docs/PROTOCOL.md](../docs/PROTOCOL.md) §5。
- `-Owner` 不能为空:两个空 owner 无法区分,`release --all` 会互删租约,所以实现直接退 3。
- `-Reason` 强烈建议填:主控和别的 agent 都靠它判断该等还是该改道。

### status —— 看谁占着什么

```powershell
& $LEASE status
```

```
key              mode        owner    reason          remain  pid
---              ----        -----    ------          ------  ---
browser:chromium pool(1/2)   agent-a  导出报表截图    42s     14568
port:9222        exclusive   agent-b  调试端口        8s      9912
```

`remain` 显示 `EXPIRED(takeable)` 表示这条锁已过期、下一个人可以接管。

### release —— 释放

```powershell
& $LEASE release <leaseId>              # 释放单个
& $LEASE release --all -Owner agent-a     # 释放某个 agent 的全部
```

### run —— 持租约执行(最实用)

```powershell
& $LEASE run browser:chromium -Cmd "node render.mjs"
& $LEASE run browser:chromium -Cmd "python -m http.server 8000"
```

自动申请 → 执行 → **无论成功失败都释放** → 透传子进程退出码。

默认值:`-Wait 0`(抢不到立刻失败,和铁律一致;要排队显式给 `-Wait 120s`)、`-Ttl` 取 `$DSH_RESOURCE_TTL`,缺省 `600s`。

结束时若发现租约已被别人接管(命令跑过了 TTL),它**只记日志,不删对方的锁** —— 删除前会核对锁文件里的 `id`/`owner`。

> **为什么有 `-Cmd` 这种形式**:`--` 透传(如 `run k -- node x.js`)只适合不带 `-` 开关的简单命令。因为 CLI 是 PowerShell 脚本,`-NoProfile`、`-m` 这类开关会被 PowerShell 当成 CLI 自己的参数。带开关的命令一律用 `-Cmd`(它交给 `cmd.exe /c`,开关安全)。

## 退出码

协议自身的码:

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 资源被占 / 等待超时 / 找不到该租约 id(已释放,或已被接管) |
| 3 | 参数错误(含空 owner) |

`run` 是例外:**它透传子进程的退出码**,所以取值任意,子进程返回 2 不代表"资源被占"。区分办法看 stderr:有 `Resource busy` 且无 `Acquired lease` = 没拿到锁;有 `Acquired lease` = 锁拿到了、命令本身失败。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `DSH_RESOURCE_LOCK_ROOT` | `%LOCALAPPDATA%\dsh-resource-lease\locks` | 锁根目录。测试时指到临时目录即可 |
| `DSH_RESOURCE_TTL` | `30s` | `acquire` 的默认 TTL。**`run` 也读它**,缺省 600s |
| `DSH_AGENT_NAME` | `pid:<PID>` | 默认 owner 名。**建议每个 agent 设成自己的名字**;留空会被拒绝(退 3) |

## 实现要点(改代码前必读)

1. **锁是文件,不是目录。** 用 `FileMode::CreateNew`(即 `O_CREAT|O_EXCL`)一次系统调用判定成败。
   ⚠️ **不要改成目录锁**:目录锁的成败取决于"创建时是否抛异常"。PS 5.1 里普通 `New-Item -ItemType Directory` 对已存在目录**会报错**,但 `-Force` 与 `[System.IO.Directory]::CreateDirectory` **不抛** —— 于是每个 racer 都"成功",互斥**静默失效**。文件 + `FileMode::CreateNew` 没有这个歧义,测试里有一条专门守着它。
2. **接管过期锁靠 `File.Move` 当 CAS。** 两个进程同时接管,只有 rename 成功的那个继续。
3. **读不到内容的锁文件不等于过期。** 那正是"创建了但还没写元数据"的活着的持有者;把它当过期会抢走一把全新租约,于是一把锁有两个持有者(实测复现过)。规则:能解析且已过期 → 可接管;解析不了但文件已老(>2s) → 崩溃残留,可接管;解析不了且很新 → 视为持有,不许抢。接管后再回读归档副本,若发现是有效未过期租约就放回去。**锁路径上是一个目录**时按同样规则处理(没有正文、但有修改时间):很新 → 视为持有,够老 → 用 `Directory.Move` 归档成 `.stale`。少了这一条,那个键会永远 busy 且没有 TTL 逃生(旧版实测过;插件与 MCP 早就会自愈)。
4. **释放必须先核对 `id`/`owner`。** 否则"过期 → 被接管 → 旧持有者释放"会删掉新持有者的有效锁,第三个 agent 立刻进来,而新持有者仍以为独占(与 MCP 侧 `releaseById` 语义一致)。
5. **脚本必须是纯 ASCII。** Windows PowerShell 5.1 按系统 ANSI 代码页读 `.ps1`,中文字面量会损坏、甚至吞掉后面的引号导致整个文件解析失败。中文文档写在 `.md` 里。
6. **退出码用 `$script:code` 传,不要用 `return 0`。** PowerShell 函数会把输出和返回值一起收集成数组,`exit ([int]$code)` 会崩。

## 测试

```powershell
& "./cli/tests/test-lease.ps1"
```

一条测试脚本(`./cli/tests/test-lease.ps1`)、20 组用例、**93 条断言**,全部真起子进程(不是假 job),覆盖:独占互斥、跨进程竞争、TTL 接管、崩溃残留自愈(造真实 `.lock` 文件残骸并断言 `.stale` 计数 0→1)、pool 名额、`run` 异常释放、退出码、以及三条回归:**接管后旧 id 释放不误删新锁**、**`run` 中途被接管不误删**、**键大小写归一 / 半写锁文件不可抢**。用临时锁根目录,且**每个用例一个独立锁根**,不污染真实环境、也不跨用例串味。

## 已知局限

- 单机 + 多进程。不做跨机器租约。
- 不做优先级抢占:先到先得,等不到就失败。
- `-Mode shared` 目前与 `exclusive` 行为一致(都只允许一个持有者),真正的"共享读"尚未实现 —— 因为尚未遇到真实需要,先不猜着实现。
- 不检测"持锁进程是否还活着":只认 TTL。所以 TTL 给太长会让崩溃残留多占一会儿。
