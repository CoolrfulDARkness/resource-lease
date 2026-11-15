# dsh-resource-lease

在**同一台机器上并行工作的多个 agent** 之间仲裁独占资源:浏览器 / Playwright、固定端口、屏幕与输入焦点、共享写目标。

纯 Host 插件,纯 JS,无构建步骤,无 Client 端代码。

它和零依赖的 `cli/lease.ps1` **共用同一套锁文件**,所以「用 CLI 的 agent」和「用插件的 agent」互相排斥——这是本插件存在的主要理由。

它给模型加的是三样东西:**运行时上下文**(每个 step 注入"现在谁占着什么",没有任何租约时不输出任何文本)、**三个工具**(`resource_acquire` / `resource_release` / `resource_status`)、**工具守卫**(`protectedTools` 里登记的工具,未持租约调用直接被拒)。MCP server 与 CLI **都没有第一样** —— 那是本插件与它们的主要差异。

> **这是 DSH(DeepSeek Harness)插件。** 它按 bundle 形态发布:`package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml`、`icon` 指向插件图标,DSH 靠这两个字段识别 bundle,不要删。`lib/*.js` 不依赖任何 `@deepseek-ai/*` 包(原因见 §1.1),所以本地目录 / 符号链接安装都能装载。分发与收录见 [PUBLISH.md](./PUBLISH.md)。

## 安装

```bash
# 首选:本地目录。在 DSH 的插件安装入口里指向 ./plugin
# install_bundle 装出来是一个符号链接,所以插件必须自包含(§1.1)
# 仓库里已经有它,不需要额外下载
```

```bash
# 备选:npm 包(当前未发布到 npm registry)
# 发布之后 dshmarket 的一键安装才会走这条路;在此之前下面的命令会 404
npm i dsh-resource-lease
```

装好后插件默认启用、默认配置即可工作;要改行为再动 `cordis.patch.yml`(§2)。

---

## 1. 它贡献了什么

| 贡献 | 说明 |
|---|---|
| Host 服务 `resources` | `lease` / `release` / `releaseAll` / `list`,给其它插件和脚本用 |
| 三个工具 | `resource_acquire` / `resource_release` / `resource_status`,给模型用 |
| 运行时上下文 | 每个 step 注入「当前占用 + 我持有的租约」;**没有任何租约时不输出任何文本** |
| 工具守卫 | `protectedTools` 里登记的工具,未持租约调用直接被拒,并在错误里告诉模型该 acquire 什么 |
| 自动回收 | agent 销毁时释放它持有的租约;插件卸载时释放全部 |

## 1.1 自包含(为什么没有任何 `@deepseek-ai/*` import)

`install_bundle` 安装本地目录时用的是**符号链接**(`<profile>/node_modules/dsh-resource-lease` → 本目录),而 Node 按**真实路径**解析裸模块名。也就是说它从 `./plugin/...` 这样的工作区目录一路往上找,永远到不了 profile 的 `node_modules`,更到不了 `app.asar` 里 DSH 自带的 `@deepseek-ai/*`。

所以本插件的 `lib/*.js` **只 import `node:` 内建模块和同目录的 `./lock.js`**;动态 `import()` 也不行(同样解析不到),同样没有。代价是两个:

- `defineTool` 被内联重写(`lib/index.js` 里的 `defineTool` / `parameterSchema` / `outputSchema`)。真实实现做三件事:把作者简写编译成 raw JSON Schema、同样编译 `output.schema`、并给 `execute` 包一层参数校验。内联版直接产出 raw JSON Schema(所以 `tools.register` 里的 `assertSupportedJsonSchema` 照样通过),参数校验改成在 `execute` 里针对真正用到的字段显式报错。
- **不导出 `Config`**。harness 的 Config schema 是 schemastery 的 `Schema`,而 schemastery 正是解析不到的裸包名;伪造一个长得像的对象有让 Loader 在激活期直接拒绝的风险。没有 `Config` 时,Loader 会把 `cordis.patch.yml` 的 `config:` 原样传给 `apply()`——配置照常生效,只是插件详情里不显示 schema。**配置的校验和默认值由 `normalizeConfig()` 负责**:每个字段都会被强制转型,无法识别的值回落到默认值,不会抛错。

## 2. 配置项

全部可选,省略即用默认值。注意:本节表格就是配置契约(没有正式的 Config schema 可展示),字段名和默认值以 `normalizeConfig()` 为准。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 整个插件开关。`false` 时不注册服务 / 工具 / 上下文 / 守卫 |
| `lockRoot` | string | `%LOCALAPPDATA%\dsh-resource-lease\locks` | 锁目录。留空时依次取 `DSH_RESOURCE_LOCK_ROOT` 环境变量、再取上述默认值——**与 CLI 的解析顺序一致**,所以默认就互通 |
| `defaultTtlMs` | number | `30000` | 调用方没给 `ttlMs` 时的租约寿命。持锁进程崩溃后,资源最多被占用这么久。小于 1000 会被忽略 |
| `maxWaitMs` | number | `120000` | 单次 acquire 最多等多久才触发 `onTimeout` |
| `onTimeout` | `'fail'` \| `'queue'` \| `'steal'` | `'fail'` | 等待超时后的行为:`fail` 报出持有者;`queue` 一直等到拿到;`steal` 无视 TTL 强抢。无法识别的值回落 `fail` |
| `resources` | `{ [key]: { mode, slots } }` | `{}` | 资源 key 的默认仲裁方式。`lease` 没指定 `mode` 时来这里查 |
| `protectedTools` | `{ [toolName]: resourceKey }` | `{}` | 工具名 → 资源 key。未持该资源时调用被拒 |

`cordis.patch.yml` 里的注释块列出了全部字段的写法,取消注释即可。

### 配置示例

```yaml
- insert:
    - id: resource-lease
      name: dsh-resource-lease
      config:
        defaultTtlMs: 60000
        maxWaitMs: 180000
        onTimeout: fail
        resources:
          'browser:chromium': { mode: pool, slots: 2 }
          'browser:profile:main': { mode: exclusive }
          'port:9222': { mode: exclusive }
          'screen:focus': { mode: exclusive }
          'dir:src/parser': { mode: exclusive }
        protectedTools:
          pwsh: 'screen:focus'
```

## 3. 资源 key 约定

`<category>:<specific>`,和 CLI 的文档一致:

| key | 含义 | 建议 mode |
|---|---|---|
| `browser:chromium` | 一个 Chromium 实例 | `pool`(建议 2) |
| `browser:profile:main` | 某个具体的 user-data-dir | `exclusive` |
| `port:9222` | 固定端口 | `exclusive` |
| `screen:focus` | 屏幕 / 输入焦点 | `exclusive` |
| `dir:src/parser` | 共享写目标 | `exclusive` |
| `repo:root` | 一个 git 仓库 | `exclusive` |

key 会被 sanitize 成 `[A-Za-z0-9._-]` 再当文件名,所以 `browser:chromium` 与 `browser_chromium` 是**同一个资源**。

## 4. 模型侧的三个工具

工具描述里写清了「什么时候必须用」,因为模型只看得到描述。

### `resource_acquire`

必填 `key` 和 `reason`;可选 `mode` / `slots` / `ttlMs` / `waitMs`。

`owner` **由插件自动填成调用方 agent 的 session id**,模型无法代别人取租约。

资源被占时抛错,错误里带持有者、它的 reason 和剩余时间,例如:

```
Resource busy: port:9222 - held by 01J8... (exclusive, 41s left, reason: dev server).
Wait for the holder to release it (or let its TTL expire), then acquire again.
```

### `resource_release`

`id` 释放单个;`key` 释放我持有的该资源的全部;`all: true` 释放我持有的全部。
**只能释放自己的**——拿别人的 id 会被拒。工作做完(包括失败路径)就该调它,别等 TTL。

### `resource_status`

列出当前所有活着的租约(包括其它 agent 和 CLI 持有的),标记哪条是我的;`includeExpired: true` 连已过期但锁文件还在的也列出来。

## 5. Host 服务 `resources`

```js
ctx.inject(['resources'], (ctx) => {
  const lease = await ctx.resources.lease({
    key: 'browser:chromium',
    mode: 'pool',
    slots: 2,
    ttlMs: 60000,
    waitMs: 30000,
    reason: 'capture screenshots',
    owner: 'my-plugin',        // 省略则用 pid:<pid>
  })
  ctx.resources.release(lease.id)
  ctx.resources.releaseAll('my-plugin')   // 省略 owner = 释放本进程全部
  ctx.resources.list()                    // 活的租约
  ctx.resources.list({ includeExpired: true })
  ctx.resources.lockRoot                  // 解析后的锁目录
})
```

`lease()` 返回锁文件里的那份元数据(`id` / `key` / `mode` / `slots` / `slot` / `owner` / `reason` / `pid` / `host` / `createdAt` / `expiresAt` / `lockPath`)。

## 6. 可见性(注入到 prompt 的内容)

每个 step 组装 prompt 时,注册一个名为 `resource-lease` 的 runtime context:

```
Resource leases in effect right now (file locks shared with other agents and with the resource-lease CLI):
Held by you:
- port:9222: exclusive, 41s left, id lz_9f2c..., reason: dev server
Held by other agents:
- browser:chromium: pool slot 1/2, 12s left, owner 01J7..., reason: screenshots
Call resource_acquire before using a resource another agent holds, and resource_release what you hold as soon as the work is done.
```

**硬性行为:没有任何活租约时,provider 返回空字符串,普通 agent 的 prompt 不会被污染。** 已过期的租约也算「没有」——它是可被接管的,不该占着 prompt。

## 7. 受保护工具守卫

`protectedTools: { pwsh: 'screen:focus' }` 之后,没持有 `screen:focus` 的 agent 调用 `pwsh` 会被同步守卫拒绝,错误直接告诉模型下一步:

```
Tool "pwsh" requires the resource "screen:focus", which you do not hold.
Call resource_acquire with key="screen:focus" and a reason describing what you are about to do,
then retry "pwsh". If "screen:focus" is busy, resource_status shows the current holder and the remaining time.
```

守卫和工具都挂在插件(全局)作用域上,按 `exec.agent` 区分调用者,所以不需要按 agent 分别注册。

## 8. 与 CLI 共用的锁格式

**这是兼容性契约。改这里等于改 CLI。**

### 路径

| 场景 | 路径 |
|---|---|
| `exclusive` / `shared` | `<lockRoot>/<sanitizedKey>.lock` |
| `pool` | `<lockRoot>/<sanitizedKey>.slot-<N>.lock`(N 从 0 开始) |
| CLI 的租约索引 | `<lockRoot>/_leases/<leaseId>.json`,内容 `{ "id", "key", "path" }` |
| 接管后的归档 | `<lockRoot>/<name>.lock.stale.<epochMs>.<pid>`(保留 1 小时) |

`sanitize` = 把非 `[A-Za-z0-9._-]` 的字符替换成 `_`。

### 原子性

锁 = **一个文件**,用 `fs.openSync(path, 'wx')` 创建,即 `open(O_CREAT | O_EXCL)`:一次系统调用里完成「查存在 + 创建」,没有 TOCTOU 窗口。

**绝不要用 `mkdir` / `CreateDirectory` 当锁**:目录创建是幂等的,并发时所有竞争者都会「成功」,互斥会静默失效。CLI 第一版就踩过这个坑。

### 锁文件内容

```json
{
  "id": "lz_9f2c1a4b7e83",
  "key": "browser:chromium",
  "mode": "pool",
  "slots": 2,
  "slot": 1,
  "owner": "01J8ZK...",
  "reason": "capture screenshots",
  "pid": 12345,
  "host": "WORKSTATION",
  "createdAt": 1763200000000,
  "expiresAt": 1763200060000,
  "lockPath": "<lockRoot>\\browser_chromium.slot-1.lock"
}
```

### 接管过期锁的 CAS

`fs.renameSync(lock, lock + '.stale.' + now + '.' + pid)` —— rename 就是 compare-and-swap:两个进程同时抢同一把过期锁时,只有 rename 成功的那一个继续,另一个因为源文件已消失而失败。失败即「别人抢先」,不重试同一把。

### 释放也必须校验 id(不是按路径删)

接管之后,**同一个路径上换了一把新租约**。旧持有者如果只按 `lockPath` 删除,删掉的就是新持有者的**活锁**,于是两个 agent 同时「持有」同一个资源,而且双方都毫不知情。

所以释放路径读取锁文件里的 `id`,与要释放的 `id` 比对:

- 一致 → 删除锁文件 + 清 `_leases` 索引记录;
- 不一致 / 锁文件已不存在 → **一个字节都不删**,只丢掉自己那条过期记录并记日志。

这与 MCP server 的 `releaseById()` 语义一致(它也是先比对 id 再删)。回归测试见 `test/release-after-takeover.test.js`(过期 → 接管 → 旧 id 释放 → 断言新持有者的锁仍存在)。

### 互操作方向(都已实测)

- 插件取锁 → CLI `status` 能列出、CLI `acquire` 返回 exit 2(busy)、CLI `release <id>` 能释放它(靠 `_leases` 索引)。
- CLI 取锁 → 插件 `list()` / `resource_status` 能看见,插件不会接管未过期的锁,插件也能读到 CLI 写的索引记录。

### `mode` 的真实语义

- `exclusive`:单锁文件,一个持有者。
- `pool`:每个 slot 一个锁文件,`slots` 个持有者。**所有 agent 必须对同一个 key 用同一个 `slots` 值**,它决定存在几个 slot 文件。
- `shared`:声明「只读意图」,**但磁盘上仍然是一个单锁文件,即仍然互斥**。这是为了和 CLI 保持一致——CLI 的 `-Mode shared` 用的也是 `<key>.lock`。如果插件在这里做成多持有者,就会和 CLI 的 `shared` 失去互斥。真需要并发请用 `pool`。

## 9. 自动回收

- **agent 销毁**:在 `agent/created` 监听里用 `agent.ctx.effect(...)` 挂清理,agent 被销毁时释放它持有的租约。
- **插件卸载**:插件自己作用域上的 effect 释放本进程持有的全部租约。
- **TTL**:兜底。进程被 kill -9 时前两条都不会跑,锁会在 `expiresAt` 之后被下一个人接管。

## 10. 已知限制

- **没有正式的 Config schema**(见 1.1)。配置照常生效,但插件详情里看不到字段说明,也没有 Loader 级的校验;写错的字段会静默回落默认值。排查配置问题时以 `normalizeConfig()` 为准。
- 内联的 `defineTool` **不做** 原版的 schema 遍历式参数校验。`mode` / `slots` / `key` 这类真正会用到的字段会在 `execute` 里显式报错,但「多传了一个不认识的字段」不会被拦。
- `release(id)` 只释放**本进程**持有的租约(内存里,或 `_leases` 索引里 `pid` 等于本进程的),而且只删仍然记着这个 `id` 的锁文件(见 §8)。跨进程释放请用 CLI 的 `release <id>`。
- 守卫判断「是否持有」只看 `owner` 是否等于调用方 agent 的 session id。若某个 agent 用 CLI 以 `$DSH_AGENT_NAME` 取锁,插件的守卫不认它(两边 owner 命名空间不同)。要混用就统一用插件工具取锁。
- 锁根目录每读一次都扫一遍目录(取锁 / 列表 / prompt 上下文各一次)。租约数量是个位数,这点 I/O 可以忽略。
- `steal` 会无视 TTL 强抢活锁,是逃生舱口,默认不开。
- 锁文件先 `O_EXCL` 创建再写入元数据。极窄的窗口里,别的进程可能读到空文件并把 `null` 元数据当成「可接管」(CLI 的 `Read-Meta` 也是这个行为)。这是共享格式的既有性质,插件没有让它变差,但也没有修掉。

## 11. 分发与收录(维护者)

完整命令与注意事项见 [PUBLISH.md](./PUBLISH.md),这里只列要点:

- **保持它是「DSH 插件」的形态**:`dsh.bundle.patch` 与 `icon` 两个字段是 DSH 识别 bundle 的依据,`files` 白名单要一直包含 `cordis.patch.yml`、`icon.svg`、`locale/*.json`。
- **路径 A(无需账号授权,建议先做)**:仓库设为**公开**,并给 GitHub 仓库打上 topic **`dsh-plugin`**。目录站 Oh-My-DSH(每 4 小时)和 dsh-plugin-radar(每 15 分钟)会自动爬取带该 topic 的公开仓库,不需要任何提交动作。
- **路径 B(npm)**:`npm publish --access public --registry https://registry.npmjs.org`。本机 `npm config get registry` 目前指向镜像,镜像**不能发新包**,必须显式带 `--registry`;发布前先把 `package.json` 里 `repository` / `homepage` / `bugs` 的占位符换成真实地址。
- **路径 C**:在 DSH 的「插件 → 发现 → 索引源」里添加社区 catalog 的 `index.json`。

`npm whoami` 在本机返回 `ENEEDAUTH`(未登录),发布动作必须由仓库维护者本人执行。
