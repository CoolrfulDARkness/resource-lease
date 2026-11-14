# 发布与收录 · PUBLISH

本文件只讲一件事:**怎么把 `plugin/` 这个包推到能被 DSH 生态发现的位置**。
三条路径互相独立,可以只做 A,也可以全做。**B 是唯一需要账号授权的一步,只能由维护者本人执行。**

仓库布局(本文件里的路径都按它写):

```
<repo root>/            = 待发布仓库根,含 README.md / LICENSE / docs / cli / mcp / plugin
└── plugin/             = 本包(dsh-resource-lease),npm 发布就在这个目录里执行
```

---

## 0. 本机现状(已核实,不是推测)

| 检查 | 结果 | 含义 |
|---|---|---|
| `npm config get registry` | `https://registry.npmmirror.com` | **镜像是只读副本,不能发布新包**;发布必须显式 `--registry https://registry.npmjs.org` |
| `npm whoami` | 失败,`npm error code ENEEDAUTH` | 当前**未登录**,`npm publish` 现在跑一定失败 |
| `npm pack` / `npm publish` 的依赖 | **会先失败**,见 §4.5:npm 缓存目录是个指向 `D:\Cache\npm-cache` 的**目录联接,而那个目标不存在** | 不修就直接 `ENOTDIR`。`npm publish` 同样受影响,不是只影响 `pack` |
| 本机 profile 安装方式 | `node_modules/dsh-resource-lease` 是**符号链接** → 源目录 | 插件必须自包含;这也是 `lib/*.js` 不 import `@deepseek-ai/*` 的原因 |

**结论:路径 B 的登录与 publish 必须由维护者本人执行。** 任何自动化流程在没有凭据时都会停在 `ENEEDAUTH`。

---

## 1. 发布前必做:替换占位符

`package.json` 里的 `repository` / `homepage` / `bugs` 现在是占位符 `OWNER`(JSON 没有注释语法,替换说明放在 `_note` 字段里)。**不替换就发布,会把一个坏链接永久写进 npm 元数据。**

推荐用 `npm pkg set` 逐个字段写死(避免整文件替换时误改 `name`、`keywords`、日志前缀里的 `resource-lease`):

```powershell
cd plugin
npm pkg set repository.type=git
npm pkg set repository.url="git+https://github.com/<owner>/<repo>.git"
npm pkg set repository.directory="plugin"                              # 包在仓库子目录里时保留
npm pkg set homepage="https://github.com/<owner>/<repo>#readme"
npm pkg set bugs.url="https://github.com/<owner>/<repo>/issues"
npm pkg delete _note
```

`<repo>` 与包名无关:仓库可以叫 `resource-lease`,也可以叫别的;`name` 字段保持 `dsh-resource-lease` 不动即可。

替换后确认一遍(应当只打出真实地址,`_note` 已消失):

```powershell
npm pkg get repository homepage bugs _note
```

> 只替换 `OWNER` 也可以用文本替换,但**不要**把 `resource-lease` 整体替换掉——它是包名(`dsh-resource-lease`)的一部分:
>
> ```powershell
> (Get-Content -Raw package.json) -replace 'OWNER', 'your-github-name' | Set-Content -NoNewline package.json
> ```

---

## 2. 发布前自检(两条路径都该跑)

```powershell
cd plugin
node --check lib/index.js
node --check lib/lock.js
node --check test/release-after-takeover.test.js
npm test                 # node --test,回归测试全绿才继续
npm pack --dry-run       # 看清单:必须含 lib/ cordis.patch.yml icon.svg locale/ README.md,
                         # 且**不含** _scratch / .git / 任何本机路径
                         # 若 §4.5 的缓存联接还没修,这一条会报 ENOTDIR:
                         # 先看 §4.5,或临时加 --cache "$env:TEMP\npm-cache-rl"
```

`files` 白名单是唯一发布清单;往目录里加文件时,先想清楚它该不该进包。

---

## 3. 路径 A — 公开 GitHub 仓库 + topic `dsh-plugin`(不需要账号授权,建议先做)

生态目录站是**topic 驱动**的,不做提交、不做申请:仓库公开且带 topic `dsh-plugin`,爬虫自己会来。

| 目录站 | 频率 |
|---|---|
| Oh-My-DSH | 每 4 小时 |
| dsh-plugin-radar | 每 15 分钟 |

### 3.1 建仓库并推上去

> **先把 `review/` 排除掉。** 仓库根(`publish/`)下的 `review/` 是审核证据,逐字保留了脱敏前的原始串,**绝不能进公开仓库**。规则、命令与强制闸门都在 [../STAGING.md](../STAGING.md)。本目录已带 `publish/.gitignore`(内容 `review/`);`git status --porcelain` 里只要出现 `review/` 就别提交。

```powershell
# 仓库根(publish/)下执行;先在 GitHub 建好空仓库或者用 gh 建
gh repo create <owner>/resource-lease --public --source . --remote origin --push
```

已有仓库就只推:

```powershell
git remote add origin https://github.com/<owner>/resource-lease.git
git branch -M main
git push -u origin main
```

### 3.2 打 topic(**这一步才是被收录的关键**)

```powershell
gh repo edit <owner>/resource-lease --add-topic dsh-plugin
```

网页做法:`https://github.com/<owner>/resource-lease` → 右侧 About 旁的齿轮 → Topics 填 `dsh-plugin` → Save。

建议一次把相关 topic 都打上(前两个是目录站识别的,其余是搜索可发现性):

```
dsh-plugin  deepseek-harness  dsh  multi-agent  concurrency  resource-lock  lease
```

### 3.3 验证

- `https://github.com/topics/dsh-plugin` 里能看到自己的仓库;
- 等一个爬虫周期(最快 15 分钟)后,在 Oh-My-DSH / dsh-plugin-radar 搜包名 `dsh-resource-lease`。

> README 顶部已经写明「这是一个 DSH 插件」——爬虫和人都靠这一句判断,别删。
> 仓库**必须 public**;private 仓库不会被抓取,也不会出现在 topic 页。

---

## 4. 路径 B — npm 发布(需要 npm 账号,只能由维护者本人执行)

### 4.1 登录(注意 registry)

```powershell
npm login --registry https://registry.npmjs.org
npm whoami  --registry https://registry.npmjs.org   # 必须打出你的用户名,不能再是 ENEEDAUTH
```

**不要**在 `registry.npmmirror.com` 上登录或发布:它是镜像,`publish` 会失败或推到没人同步的地方。

### 4.2 发布

```powershell
cd plugin
npm publish --access public --registry https://registry.npmjs.org
```

- 包名 `dsh-resource-lease` 若已被占用,`npm publish` 会 403;此时改 `package.json` 的 `name`(例如加 `-dsh` 前缀)再发,或联系占用者。
- 开了 2FA 的账号会要求 OTP:追加 `--otp 123456`,或在提示里输入。
- `prepublishOnly` 已经挂了 `npm test`:测试不过,发布不会继续。

### 4.3 验证

```powershell
npm view dsh-resource-lease version --registry https://registry.npmjs.org
npm view dsh-resource-lease keywords --registry https://registry.npmjs.org
```

再打开 `https://www.npmjs.com/package/dsh-resource-lease` 确认 README 渲染正常、`repository` 链到真实仓库。

### 4.4 后续版本

```powershell
npm version patch        # 或 minor / major,会改 package.json 并打 tag
git push --follow-tags
npm publish --access public --registry https://registry.npmjs.org
```

**同一版本号不能重复发布**,哪怕只是改了 README。

### 4.5 本机 npm 缓存坏了(会挡住 publish)

`npm pack` 在本机报:

```
npm error code ENOTDIR
npm error syscall mkdir
npm error path C:\Users\<user>\AppData\Local\npm-cache
npm error ENOTDIR: not a directory, mkdir '...\npm-cache'
```

原因:`%LOCALAPPDATA%\npm-cache` 是一个**目录联接(Junction)**,指向 `D:\Cache\npm-cache`,而那个目标路径不存在。npm 无法在悬空联接上建目录,于是 `pack` / `publish` 全部失败。

三种修法(任选一种,**维护者执行**):

```powershell
# A. 把联接的目标建出来(最省事,一次性)
New-Item -ItemType Directory -Force 'D:\Cache\npm-cache'

# B. 删掉悬空联接,让 npm 自己建
Remove-Item 'C:\Users\<user>\AppData\Local\npm-cache' -Force
# 注意:删联接不会删到目标内容;目标本来也不存在

# C. 不改环境,本次命令换一个缓存目录
npm publish --access public --registry https://registry.npmjs.org --cache "$env:TEMP\npm-cache-rl"
```

修好后 `npm pack --dry-run` 应当正常打印文件清单(本包是 10 个文件、约 32 kB)。

---

## 5. 路径 C — 官方「插件 → 发现 → 索引源」添加社区 catalog

DSH 0.2.1 起,宿主自带「索引源(Index sources)」:把一份 **format 1** 的 `index.json` 加成来源,发现页和 `plugin_market` 工具都能搜索它。

### 5.1 让别人能加上你

1. 生成一份 format-1 索引 JSON,把本包作为其中一条条目;
2. 把它放到**加载够快**的公开地址。**DSH 给一个索引源只有 15 秒**,GitHub Pages 在部分网络下会超时,所以推荐 npm/jsDelivr:
   `https://cdn.jsdelivr.net/npm/<your-catalog-package>/index.json`
3. 在 README 里写出这一行 URL,让别人复制。

参考实现(可直接照抄结构,再删到只剩自己):
`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`

```powershell
# 只看第一条,确认字段名,不要猜——索引格式以这份参考为准
$idx = Invoke-RestMethod 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/plugins.json'
$idx | Select-Object -First 1 | ConvertTo-Json -Depth 6
```

### 5.2 用户侧操作(写进 README 给使用者看)

**插件 → 发现(Discover)→ 索引源(Index sources)→ 添加**,粘贴上面的 `index.json` URL,保存后回发现页搜索 `dsh-resource-lease`。

---

## 6. 附加:dshmarket 的一键安装来自「精选列表」

`dshmarket` 只允许安装**精选列表**里的来源,其它一律拒绝。它的列表来自
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库(站点与 market 会自动跟进,通常一天内生效)。

想进一键安装:**去那个仓库提 PR,在列表里加一条**,不要往 market 仓库提插件条目。

- 上架前提:路径 A 已完成(公开仓库 + `dsh-plugin` topic),路径 B 完成更佳(npm 包能让安装更快);
- 一条条目通常只需:包名、仓库地址、一句话说明、分类。

---

## 7. 发布清单

- [ ] `review/` **没有**被打包 / 打标签带走:见 [../STAGING.md](../STAGING.md)。`publish/.gitignore` 含 `review/`,`git status --porcelain` 无 `review/` 命中,暂存副本里也没有 `review/`
- [ ] `package.json`:无 `private`、`version` 已递增、`repository`/`homepage`/`bugs` 已换成真实地址、`_note` 已删
- [ ] `keywords` 含 `dsh-plugin` `dsh` `deepseek-harness` `resource-lock` `lease` `multi-agent` `concurrency`
- [ ] `dsh.bundle.patch` 与 `icon` 仍在(DSH 靠它识别 bundle)
- [ ] `files` 白名单**不含** `_scratch`、不含本机路径
- [ ] `node --check` + `npm test` 全绿、`npm pack --dry-run` 清单正确
- [ ] 仓库 public 且有 topic `dsh-plugin`
- [ ] `npm publish --access public --registry https://registry.npmjs.org` 成功
- [ ] README 顶部仍写明「这是一个 DSH 插件」

---

## 8. 哪些必须由人来做

| 动作 | 为什么不能自动化 |
|---|---|
| `npm login` / `npm publish` | 本机 `npm whoami` = `ENEEDAUTH`;凭据与 2FA 只属于维护者账号 |
| 建公开仓库、设 public | 需要 GitHub 账号权限 |
| 给仓库打 `dsh-plugin` topic | 同上;这是被目录站收录的唯一开关 |
| 在 `awesome-dsh-plugin` 提 PR | 需要 GitHub 账号,且要人工判断条目写法 |
| 在 DSH「索引源」里添加 catalog | 需要在你自己的 DSH 客户端里点 |
| 修 npm 缓存联接(§4.5) | 要删/建 `%LOCALAPPDATA%` 下的联接与 `D:\Cache` 目录,属于改机器环境 |

能自动化的只有:改文件、跑测试、`npm pack --dry-run`、以及推代码(`git push`,前提是本机已有推送凭据)。