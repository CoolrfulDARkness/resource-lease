# 资源租约 CLI(零改动层)

不装插件、不改 DSH,今天就能用。跨进程文件锁,带 TTL 与崩溃自愈。

```powershell
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
& $LEASE acquire browser:chromium -Ttl 5m -Wait 120s -Reason "榜单截图"
```

- `-Ttl` 默认 30s(或 `$DSH_RESOURCE_TTL`)。**长任务务必给足**,否则跑到一半锁被别人接管。
- `-Wait` 默认 0(立即失败)。要排队就显式给。
- `-Owner` 不能为空:两个空 owner 无法区分,`release --all` 会互删租约,所以实现直接退 3。
- `-Reason` 强烈建议填:主控和别的 agent 都靠它判断该等还是该改道。

### status —— 看谁占着什么

```powershell
& $LEASE status
```

```
key              mode        owner  reason       remain  pid
---              ----        -----  ------       ------  ---
browser:chromium pool(1/2)   atk-3  榜单截图     42s     14568
port:9222        exclusive   def-208 调试端口     8s     9912
```

`remain` 显示 `EXPIRED(takeable)` 表示这条锁已过期、下一个人可以接管。

### release —— 释放

```powershell
& $LEASE release <leaseId>              # 释放单个
& $LEASE release --all -Owner atk-3     # 释放某个 agent 的全部
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
| 3 | 参数错误(含空 owner、相对路径的 `path:` 键、未知 class 的近似拼写) |
| 4 | 后端 / IO 错误(锁根不可写、锁根不可用等) |

> **v2 新增 4。** 把"IO 出问题"和"资源被占"分开很重要:前者是环境坏了,重试没用;
> 后者是对手在占,等一等可能就好。混成一个码会让调用方用错策略。

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

37 项(含 20 组 v1 用例 + 17 组 v2 用例下的 **207 条断言**),全部真起子进程(不是假 job),覆盖:独占互斥、跨进程竞争、TTL 接管、崩溃残留自愈(造真实 `.lock` 文件残骸并断言 `.stale` 计数 0→1)、pool 名额、`run` 异常释放、退出码、以及三条回归:**接管后旧 id 释放不误删新锁**、**`run` 中途被接管不误删**、**键大小写归一 / 半写锁文件不可抢**。

v2 新增覆盖(对应 `docs/RESOURCE-MODEL-v2.md` §11 测试矩阵):多键原子获取 `[21]`、canonical 归一 `[24]`、多键中途失败逆序回滚无残留 `[25]`、删掉 `_leases/` 索引后互斥仍成立 `[26]`、两进程抢同一 facet 恰好一个赢 `[27]`、**相反顺序请求不死锁** `[28]`、存活判定优先于 TTL `[29]`、跨 class facet 展开 `[30]`、shared 读者共存与写者互斥 `[31]`、`--keys` 逗号形式 `[32]`、冲突输出含持有者全字段 `[33]`、键语法错 exit 3 `[34]`、锁根不可用 exit 4 `[35]`、**path 必须是绝对路径** `[36]`、**orderKey 是全序** `[37]`。

用临时锁根目录,且**每个用例一个独立锁根**,不污染真实环境、也不跨用例串味;v2 的 15 个组每组末尾还有兜底清理,防止某个组忘了释放的持有者伪装成产品 bug。

## 已知局限

- 单机 + 多进程。不做跨机器租约。
- 不做优先级抢占:先到先得,等不到就失败。
- `-Mode shared` 目前与 `exclusive` 行为一致(都只允许一个持有者),真正的"共享读"尚未实现 —— 因为尚未遇到真实需要,先不猜着实现。
- 不检测"持锁进程是否还活着":只认 TTL。所以 TTL 给太长会让崩溃残留多占一会儿。
