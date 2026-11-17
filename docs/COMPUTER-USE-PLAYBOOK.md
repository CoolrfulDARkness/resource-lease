# Windows Computer Use 实战手册

> 给下一个用 `dsh-computer-use-win` 操作真实桌面的 agent。
> 这份手册里每一条都是**踩过坑换来的**,不是从文档抄的。
> 主要作者的一次实战:在知乎编辑器里填 1155 字并发布,前半程反复失败,后半程一次成功。

---

## 0. 三十秒版

```
1. list_windows → 找 Chrome_WidgetWin_1 且标题含 Edge 的窗口,记下 hwnd
2. 确认它不是最小化(Win32 IsIconic)—— 最小化时 activate_window 无效,必须 ShowWindow(9)
3. resource_acquire screen:focus   ← protectedTools 守卫会拦,不拿租约连 click 都不能调
4. focus 目标控件 → set_value → keypress Enter     ← 三步都要,缺一不可
5. 用「产物」验证(字数、控件值、页面里的具体文字),不要用 URL 或标题验证
6. resource_release
```

---

## 1. 四条最容易犯的错(按危害排序)

### ❌ 错误 1:用 URL / 标题变化判断"操作成功"

**这是最贵的错误。** 我今晚因此误判了五次:

| 我看到的 | 我的结论 | 事实 |
|---|---|---|
| URL 变成 `graduated-access` | "X 拒绝发帖" | 帖子**已经发出去了** |
| 页面空白 | "知乎编辑器坏了" | 可能是回车没生效,也可能**内容还没进 DOM**(见错误 4)——**一次读空区分不了** |
| cookie 查询返回 0 | "所有平台掉登录" | cookie 都在,只是页面没导航过所以没加载 |

**改成**:用**产物**验证。

- 填完表单 → 读**字数统计**或控件的 `verifyValue`
- 发帖 → 去**个人主页**看那条帖在不在
- 导航 → 读**页面里应该出现的具体文字**

> 口诀:**URL 只证明"请求发出去了",不证明"结果如何"。**

### ❌ 错误 2:以为指定了 `nativeWindowHandle` 就一定作用在那个窗口

`keypress` 的 `dispatch: "foreground"` 走 `SendKeys`,**发往当前前台窗口**。
`set_value` 走 ValuePattern,**不需要焦点**——所以它会成功,给你"我操作了"的错觉,
然后 `keypress` 打进另一个窗口,你却以为是页面坏了。

**正确的三步序列(缺一不可)**:

```
focus(目标控件 elementId)      ← 让控件进入"用户正在编辑"状态
set_value(elementId, 值)        ← ValuePattern 写入
keypress(["Enter"])             ← 现在才会被当成用户提交
```

**只做 `set_value` + `Enter` 会静默失败** —— 地址栏里有字,但不会导航。

### ❌ 错误 3:把"列表里没有"当成"不存在"

- `list_windows` 默认**不列最小化窗口** → 你会以为浏览器被关了
- 用 `includeInvisible: true` 也未必够 —— 有时候它报的是 `Chrome_WidgetWin_0`(隐藏框架窗口)而不是 `_1`(真正的浏览器窗口)

**改成**:用 Win32 直接枚举,看 `IsWindowVisible` + `IsIconic`。

### ❌ 错误 4:把"读空了"当成"页面坏了 / 没登录"

这是第二贵的错误,而且比错误 1 更隐蔽,因为**工具什么都没说错**——它只是返回一个
`{ok: true, lines: 0}` 的成功形状空结果。空白页、`about:blank`、还没 hydrate 的 SPA 外壳、
**以及白字白底但 innerText 有 479 个字符的页面**,在 Edge 157 + 本插件 0.5.7 上实测
**截图逐字节相同**(9396 B / 1 种颜色 / 100% 白)。而同一次实测里,正常页是
19676 B / 32 色 / 292 字符,已登出的页面是 402888 B / 171 色 / 459 字符。

三件必须知道的事:

1. **`webContent.state == "ready"` 不代表页面有内容。** 它的判据是「无障碍树挂上子节点了没有」
   (`scripts/windows-uia.ps1` 的 `Test-ChromiumPage`:根节点有 ≥1 个子节点即算就绪),
   而空白文档的 `RootWebArea` 之下也有一个不带文字的容器节点,所以**它同样返回 `ready`**。
   别拿这个字段当"页面加载好了"的证据。
2. **截图不能作为"空白"的证据。** 上面四种截然不同的状态,截图像素完全一样。截图为空 = 零信息量。
3. **reload 不是解药,而且可能更糟。** 实测 n=3,reload 后 +600 ms 和 +3000 ms 仍然全白,
   **修复率 0/3**——reload 会把渲染计时重置。真正修好它的是**时间**:+1.5 s 还是空,
   **+5.5 s 出现了 297 个字符**。成因是「document 已 complete,但内容还没进 DOM」。

已排除的猜测:`--disable-gpu` 结果同值、headless 结果同值、窗口最小化返回的是上一已绘制帧(不是白帧)。
**未测**:后台节流。

**正确顺序(这些是幂等的重做,不是"重试"):**

```
1. 等约 3 秒  → 再读一次
2. 再等       → 再读一次,累计约 10 秒
3. 还空       → 才 reload 一次,但 reload 之后仍然要再等、再读
4. 仍然空     → 这时才可以说"读不到内容",并说清:等了多久、读了几次、reload 过没有
```

**"未登录"只有这几种证据能证**:

- 读到内容(`lines > 0`)且里面有登录表单
- URL 跳到了 `/signin` 或 `/login`
- 页面里存在只有登录后才出现、未登录时不存在某个元素

导航失败会以**显式错误**回来,例如 `BROWSER_NAVIGATION_FAILED: net::ERR_*`——
**那是网络问题,不是登录问题**,必须照实说成网络问题。
另外,浏览器在跑的时候 cookie 库是被独占锁住的,所以**"读不到 cookie"永远不等于"没登录"**。

> 口诀:**空白页 + 一次读空 = 什么都没证明。** 没等够就说"没登录",是把诊断工作丢回给人。
> 结论的强度不得超过证据的强度。

> **两种"重试"必须分开。** 重放一个非幂等动作(再提交一次表单、再点一次发布)是禁止的——
> 先读产物,看第一次到底做了什么。**重做一次幂等观测**(再读一次、再截一次、reload 后再读)
> 是**必须**做的,在把问题交回给用户之前。别用"不许重试"的规则去否掉第二种。

---

## 2. 最小化窗口:插件的已知缺口

**症状**:`activate_window` 返回 `{"activated": true}`,但窗口仍是 `iconic: true`,
截图只有 220 字节(一个 219×30 的空条),UIA 坐标变成 `-32000` 之类的负数。

**原因**:`activate_window` 只做 `SetForegroundWindow`,对最小化窗口不恢复。

**解决**:自己调 Win32。

```powershell
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [IntPtr]460282          # 你的目标 hwnd
[W]::ShowWindow($h, 9) | Out-Null     # SW_RESTORE = 9
Start-Sleep -Milliseconds 800
[W]::SetForegroundWindow($h) | Out-Null
$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
"rect: $($r.Left),$($r.Top) - $($r.Right),$($r.Bottom)"   # 负数=还在最小化
```

**判断标准**:`rect` 出现负数 → 仍然最小化;正常值(如 `219,27 - 1499,947`)→ 已恢复。

---

## 3. 找窗口:不要只靠 list_windows

```powershell
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class E {
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public delegate bool Proc(IntPtr h, IntPtr l);
}
"@
$found = @()
$cb = [E+Proc]{
  param($h,$l)
  $cn = New-Object Text.StringBuilder 256
  [E]::GetClassName($h,$cn,256) | Out-Null
  if($cn.ToString() -eq 'Chrome_WidgetWin_1' -and [E]::IsWindowVisible($h)){
    $sb = New-Object Text.StringBuilder 512
    [E]::GetWindowText($h,$sb,512) | Out-Null
    if($sb.ToString() -match 'Edge'){
      $script:found += [pscustomobject]@{ hwnd=$h.ToInt64(); min=[E]::IsIconic($h); title=$sb.ToString() }
    }
  }
  return $true
}
[E]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null
$found | Format-Table -AutoSize
```

`Chrome_WidgetWin_0` 是隐藏框架窗口,**`_1` 才是带标签页的真窗口**。

---

## 4. 坐标换算:截图 → 屏幕

截图返回两个关键字段:

```json
{"bounds": {"x":337,"y":40,"width":1902,"height":1371}, "imageScale": 0.3943}
```

公式:

```
screen_x = bounds.x + image_pixel_x / imageScale
screen_y = bounds.y + image_pixel_y / imageScale
```

**实测例子**:截图 750×541,「请输入标题」在图片 `(200, 145)`:

```
screen_x = 337 + 200 / 0.3943 = 844
screen_y =  40 + 145 / 0.3943 = 408
```

点 `(844, 408)` 命中。**`imageScale` 每次都不同**(窗口大小、`maxWidth` 都会影响),不能缓存。

---

## 5. 省 token 的四条(实测省 90%)

OCR 每次返回 **3–5 万 token**,因为它把所有识别出的文字全吐出来,不管你的 query。

| 目的 | ❌ 别用 | ✅ 用 |
|---|---|---|
| 找元素位置 | `ocr` | `find`(几百 token)+ `screenshot`(1–2k) |
| 确认页面变了 | `ocr` 全文 | `screenshot` + `read_image`(但"一片白"的截图零信息量,见错误 4) |
| 读某个数字(字数/价格) | `ocr` 全文 | `screenshot` 局部 + 看图 |
| 确认控件存在 | `ocr` | `find controlType=Edit query=...` |

**例外**:`ocr` 的 `matched` 字段会给出精确坐标,如果只要坐标,`ocr` + 读 `matched` 也还行——但输出仍然巨大,不如 `find`。

---

## 6. 中文输入:用 clipboard

```json
{"method": "clipboard", "text": "..."}
```

- 实测一次粘贴 **1056 个中文字符,零错字**
- `sendinput` 逐字符发 Unicode 事件,中文长文本容易漏字
- 工具会自动恢复剪贴板,不污染用户环境

**大段文本一次粘,不要分段** —— 分段要多次调用,每次都有失败风险。

---

## 7. 输入类工具需要租约(如果宿主配了守卫)

如果宿主配置了 `protectedTools`(例如把 `click`/`type_text`/`keypress` 绑到 `screen:focus`),
**不持租约调用会被直接拒绝**:

```
Tool "..." requires the resource "screen:focus", which you do not hold.
```

这不是 bug,是设计。流程:

```
resource_acquire key="screen:focus" reason="<你要干什么>"
  ↓ 干活
resource_release id=<lease id>
```

租约**要够长**:填一篇长文 + 截图确认 + 发布,实测需要 **5–15 分钟**。
给 300 秒会在填一半时过期,然后下一次点击被拒。

---

## 8. 完整的"发一篇长文"流程(实测跑通)

```
1. 恢复窗口(ShowWindow 9)+ SetForegroundWindow
2. resource_acquire screen:focus ttl=1200s
3. screenshot → 算坐标 → click 标题栏
4. type_text method=clipboard → 标题
5. click 正文栏(坐标重新算,因为粘贴后布局可能变)
6. type_text method=clipboard → 正文(一次粘完)
7. wait 2000-3000ms → screenshot → 读字数统计验证
8. 截图给用户确认(不可逆动作前必做)
9. click 发布按钮
10. wait → 用产物验证(去列表页看文章在不在)
11. resource_release
```

**关键**:第 5 步的坐标必须**重新算**,不能复用第 3 步的 —— 标题填进去后页面可能滚动或重排。

---

## 9. 出问题时的诊断顺序

```
1. 窗口真的可见吗?  → Win32 IsWindowVisible + IsIconic + GetWindowRect
2. 目标控件有焦点吗? → find 该控件看 hasKeyboardFocus
3. 读到内容了吗?     → 读出来的文字/节点数为 0 时,**先等 3 秒再读、累计约 10 秒**,
                       之后才 reload 一次再读(见错误 4)。不要用 `webContent.state == "ready"`
                       当"有内容"的证据——空白页同样是 ready
4. 操作生效了吗?     → 读产物(字数/控件值/页面文字),不看 URL
5. 还不行 → snapshot 重新观察,不要用旧 elementId(会 stale)
```

**elementId 会过期**。页面一变就 stale,报错是:

```
Element 'uia:rt:...' is stale or was not observed by this backend.
```

→ **重新 `find` / `snapshot`**,不要重试旧 id。

---

## 10. 一句话总结

> 这个工具报 `ok: true, verification: "sent"` 只说明**它的代码跑完了**,
> 不说明**事情做成了**。
> 永远用产物验证,永远给输入类操作先拿焦点。
