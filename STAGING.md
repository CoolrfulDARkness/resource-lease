# 打包与打标签前的暂存规则 · STAGING

本文件只讲一件事:**`publish/` 整棵树不是全部都能进公开产物的**。打标签、`npm publish`、把目录复制到临时目录做"第三方 checkout 模拟"之前,必须排除 `review/`。

**本文件不执行发布,只定义规则。** 发布动作(§打包、打标签、`npm publish`、`git push`)及其凭据都由维护者本人执行,见 [plugin/PUBLISH.md](plugin/PUBLISH.md)。

---

## 1. 必须排除的目录

```
publish/review/          <- 永远不进公开产物
```

`review/` 里是审核与复核的过程证据(对抗审核报告、脱敏扫描报告、逐条验收表)。它们**故意保留了改动前的原始字符串**用于举证,因此逐字包含四类已在正文里脱敏的内容:

| 类别 | 举例(只描述,不复写) |
|---|---|
| 真实盘符 + 内部项目代号 | 变更前的绝对路径前缀 |
| 内部工作区目录名 | 只在本机存在的目录 |
| 内部 agent / 会话命名 | 编排层的私有命名 |
| 私有错误码常量 | 某个上游产品的报错前缀 |

**这些文件不能删**(它们是"哪条改动被谁因为什么证据否掉"的唯一记录),但**绝不能随产物出去**。所以处置办法是"排除",不是"删除",也不是"重写"。

一条粗略判据:整个 `publish/` 里除 `review/` 之外对上述四类串的命中数是 **0**;`review/` 内部命中数不是 0。这个不等式就是这条规则存在的理由。

---

## 2. 三条落地规则

### 2.1 仓库根的 `.gitignore`

本仓库当前**还没有 `.gitignore`**(也没有 `.git`):`publish/` 现在是"待发布目录",不是已存在的 git 仓库。

- 已经有 `.gitignore` 的仓库:**加一行 `review/`**,不要加在别处。
- 还没有的:在**把 `publish/` 初始化为仓库根**的那一刻就加上(内容见 §2.2),不要等第一次 `git add .` 之后补 —— 一旦 `review/` 进过 index,后面 `git rm --cached` 也改不掉它已经进过的历史。

### 2.2 已随本目录提供的一份 `.gitignore`

`publish/.gitignore` 已经写好(内容就是 `review/`)。它覆盖两种情况:

- 把 `publish/` 当仓库根(推荐做法):`review/` 直接被忽略;
- 在 `publish/` 下临时 `git init` 试推:同样被忽略。

**验证忽略真的生效**(本机实测:下面的输出里 `status` 命中数必须是 `0`,`check-ignore` 必须指向 `.gitignore`):

```powershell
cd publish
git init --quiet .
"status hits: " + @(git status --porcelain --untracked-files=all | Select-String 'review/').Count   # 必须是 0
git check-ignore -v review/round2-correctness.md        # 必须打出 .gitignore:<行号>:review/
Remove-Item -Recurse -Force .git                        # 只是验证,不要留下 .git
```

预期输出(实测):

```
status hits: 0
.gitignore:7:review/    review/round2-correctness.md
```

更省事、也够用的做法是不碰 git,直接问"哪些文件会被带走"(见 §2.3)。

### 2.3 复制到临时目录时

模拟第三方 checkout、或者做发布前的干净副本时,**先排除 `review/`**:

```powershell
# 从 publish/ 目录执行,这样片段里不需要写死任何本机路径
$src = (Get-Location).Path
$dst = Join-Path $env:TEMP ("publish-stage-" + [guid]::NewGuid().ToString('N').Substring(0,8))

# robocopy 的 /XD 排除目录;退出码 0-7 都算成功
robocopy $src $dst /E /XD "$src\review" /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }

# 兜底断言:目标里不允许出现 review
$leak = @(Get-ChildItem -Recurse -File -Force $dst | Where-Object { $_.FullName -match '\\review\\' })
if ($leak.Count -ne 0) { throw "review/ leaked into the staging copy: $($leak.Count) file(s)" }
"staged: $dst (review/ excluded, $($leak.Count) leaks)"
```

实测输出(本机,`publish/` 下执行):`robocopy` 退出码 `1`(有文件被复制,属成功),`leaks` 为 `0`,副本顶层是 `cli docs mcp plugin .gitignore LICENSE README.md STAGING.md` —— 没有 `review`。

`Copy-Item` 没有排除参数,所以用 `robocopy /XD`,不要用 `Copy-Item -Recurse`。

### 2.4 打标签 / `git push` 时

```powershell
cd publish
git add -A

# 硬闸门 1:未跟踪/新变更里不能有 review/(.gitignore 生效时这里为空)
git status --porcelain | Select-String 'review/'    # 必须没有任何输出

# 硬闸门 2:索引里也不允许存在 review/。
# 为什么必须有这一条:一旦 review/ 被 add 过（哪怕之后写进 .gitignore），
# `git status` 就再也看不见它 —— 已跟踪文件被 .gitignore 忽略是静默的。
# 这条对"已被跟踪"是 fail-closed 的。
$tracked = @(git ls-files -- review)
if ($tracked.Count -ne 0) {
  throw "review/ is tracked by git ($($tracked.Count) file(s)). Run: git rm -r --cached review"
}

git commit -m "release: v<version>"
git tag -a v<version> -m "v<version>"
git push --follow-tags
```

两条闸门**都要过**。第 1 条只覆盖"未被跟踪"的情形;真正会泄漏历史的是第 2 条——`review/` 一旦进过索引,后面每一条 commit 都带着它,而 `.gitignore` 对此完全无效。**本机目前还没有任何 `.git`,所以这是清单漏洞而非活泄漏**;第一次 `git init` 之前把两条都跑一遍。

### 2.5 `npm publish`

`npm publish` 的清单由 `plugin/package.json` 的 `files` 白名单决定,`review/` 不在白名单里,所以 npm 这条路本来就带不出去。仍然照 `plugin/PUBLISH.md` §2 跑一遍 `npm pack --dry-run`,确认清单里只有 `lib/`、`cordis.patch.yml`、`icon.svg`、`locale/`、`README.md`、`PUBLISH.md`、`test/*.test.js`。

**注意 `npm publish` 只打包 `plugin/` 一个子目录**,而 git 仓库/标签是整棵 `publish/`。两条路的闸门不同:前者靠 `files` 白名单,后者靠 `.gitignore` + §2.4 的 `git status`。别用一条的通过去推断另一条也通过。

---

## 3. 发布前检查清单(与本节一一对应)

- [ ] `publish/.gitignore` 存在且内容是 `review/`(§2.2)
- [ ] 临时目录副本里没有 `review/`(§2.3 的 `$leak` 断言通过)
- [ ] `git status --porcelain` 里没有 `review/`(§2.4 闸门 1)
- [ ] **`git ls-files -- review` 输出为空**(§2.4 闸门 2,对已跟踪 fail-closed)
- [ ] `npm pack --dry-run` 清单与 `files` 白名单一致(§2.5)
- [ ] 除 `review/` 外,`publish/` 对四类脱敏串的命中数为 0(§1 的判据)
- [ ] `review/` 文件**仍然在本机**(排除了,没删掉)

最后一条容易被"顺手清理"掉:这些报告是复核时唯一的原始证据,丢了就没法回答"当初为什么这么改"。

---

## 4. 为什么不把 `review/` 移到 `publish/` 之外

`ACTION-PLAN.md`、`DRAFTS.md` 这类过程文件已经移到 `publish-internal/`,因为它们是**过时的论断**;`review/` 不一样:它是**当前的证据**,而且刻意保留未脱敏原文。移到外面等于让"这条阻断是怎么被验掉的"离开发布目录,复核时又要跨两棵树对照。

排除法(留在原地 + 不许带走)同时满足两件事:**证据在原地可查**,且**产物里没有它**。代价是发布流程多一道闸门 —— 就是本文件。
