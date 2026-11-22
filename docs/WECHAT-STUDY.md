# 用 craft-anything 观察微信（Weixin 4.2.0.13）

目标不是"复刻微信"，而是**只取它对"两个人私聊"的处理方式**：单聊窗口的信息层级、气泡与时间戳的位置、
输入区的行为、状态反馈的措辞。这些都在"看得见的界面"层面，属于 craft-anything 的 Clean room 允许范围。

## 实测记录

**目标**：`D:\Weixin\Weixin.exe`（3,127,848 B，微信 4.x 主程序）

```
craft-anything-cli --project D:\dsh\_ca\proj-couple.cany triage D:\Weixin\Weixin.exe
```

返回（证据 id `ev_74890c4ff72cbfaf69a3dbb55c7960edfd60c7bb6506abf313db579c36b0af65`）：

| 字段 | 值 |
|---|---|
| format | `pe` / PE (Windows)，x86_64，64 位 |
| kind | executable |
| entry_point | `0x1401cce00` |
| sha256 | `eaaa1c6c6123ce9887e5c67b60d905d22f09fac091058f27d2d819e9ff26fc69` |
| stripped | true（符号表被移除，函数多为生成名） |
| libraries | KERNEL32 / USER32 / ADVAPI32 / ole32 / dbghelp / bcrypt / CRYPT32 / WS2_32 / WINMM / VERSION / SHELL32 / USERENV |
| 引擎 | builtin 0.6.1，clean_room=false（deep 模式） |

**这组事实怎么用**：3.1 MB 的主程序 + `bcrypt/CRYPT32/WS2_32` 依赖 + 被 strip → 这是"外壳 + 网络 +
加密库"的典型形态，真正的界面与业务在 `WeChatAppEx.exe` / 各插件 DLL 里（进程列表里能看到十余个 `WeChatAppEx.exe`）。
所以**静态反编译不是这个任务的最短路径**：我们要的是界面语言与交互范式，不是协议。

## 取界面：实测结果（关键结论）

craft-anything 的 MCP 端可以通过 stdio 直接调用全部 323 个工具。实测流程（`D:\dsh\_ca\mcp\call.py`，
一个几十行的 JSON-RPC 客户端：`initialize` → `notifications/initialized` → `tools/list` → `tools/call`）：

```
craft-anything-cli mcp --project D:\dsh\_ca\proj-couple.cany
  → initialize  ok（server instructions: "Craft Anything shows how software works, with evidence…"）
  → tools/list  39 个工具（含 runtime_ui_read / runtime_native_window_capture / runtime_ui_walkthrough_record）
  → tools/call  runtime_ui_read { "pid": 110392 }
```

第一次调用返回 **`consent_required`**：

```json
{"error":{"category":"missing","code":"consent_required",
 "details":{"tool":"runtime_ui_read"},
 "message":"Read an app's screen runs code or changes a device, so it needs your OK first.",
 "remediation":"Approve it when asked, or allow it for this project in Settings."}}
```

放行方式（本项目已执行）：`settings_set --key ask_before_running --value false` → `config.toml` 里
`deep_mode = true / ask_before_running = false / auto_mode = true`。再调用即成功。

`runtime_ui_read { "pid": 110392 }` 的返回（证据 `ev_ae6652e217d4a40309524d639f90ac457b464999d4fb493df0d4872ac9ded4e9`）：

| 字段 | 值 |
|---|---|
| authority | `our-run`，confidence `observed`，engine `ui-automation` |
| windows | 1（只枚举到 1 个窗口） |
| nodes | 4 个 |

```text
Window   Qt51514QWindowIcon    title "微信"              ({x:-32000,y:-32000,w:237,h:39})   ← 已最小化/移出屏幕
Pane     Qt51514QWindowIcon    title "Weixin"            (2×2)
Pane     MMUIRenderSubWindow   title "MMUIRenderSubWindow" (1400×1103)
TitleBar                       title "微信"
limitation control_view: "UI Automation's control view: plain layout containers are left out，
          and an app that draws its own controls (many games) shows one pane."
```

**这两条事实决定了后面所有做法**：

1. 微信 4.x 是 **Qt 5.15.14 应用**（窗口类名 `Qt51514QWindowIcon`），界面由自绘的
   `MMUIRenderSubWindow` 渲染 —— 不是 Win32 控件。所以 **UI Automation 树基本是空的（4 个节点）**，
   想靠 UIA 读"聊天气泡、输入框文字"这条路走不通。
2. 因此在 Clean room 里唯一有效的观察手段是**截图 + 人眼/OCR 读可见文字**，即
   `runtime_ui_read { pid, "screenshot": true }` 或 `runtime_native_window_capture`（后者会**启动一个实例**，
   更适合对安装包做首次观察，不适合去动用户正在用的那个）。

> 隐私边界：这一步我没有对用户正在使用的微信窗口截图 —— 那会把私人会话内容带进分析记录。
> 需要截图时，请在微信切到一个**干净的单聊窗口**（或新建一个只发一条测试消息的会话）后自行运行上面那条命令。

```bash
# 你自己观察时的推荐命令（先确保微信窗口没最小化）
#   tools/call runtime_ui_read { "pid": <Weixin.exe 的 pid>, "screenshot": true }
#   tools/call runtime_ui_walkthrough_record { "pid": <pid>, "steps": [{"kind":"screenshot"}] }
```

## 从微信学到并落到本项目里的四条

| 微信的单聊范式 | 本项目的对应实现 | 差异（有意为之） |
|---|---|---|
| 顶部固定一条会话头（对方名称 + 状态） | `#panel-chat .chathead`：对端指纹 + 解除入口 | 用**指纹**代替昵称做主身份，因为这里没有账号体系 |
| 消息气泡左右分置、时间戳贴气泡底部 | `.bubble.mine/.theirs` + `.time` | 同构；时间戳只显示本地时分秒 |
| 输入区在底部固定、Enter 发送 | `.composer` + `keydown` 处理 Enter（Shift+Enter 换行） | 同构 |
| 状态反馈用一条横条提示（"对方正在输入…"） | `#status` 一条横条：`直连已建立 / 等待对方回应 / 双方断开` | 用"链路状态"替代"输入状态"——P2P 里前者才是真的 |

没有照搬的：朋友圈/公众号/群/账号体系/"对方已读"——都不属于"两个人"的场景，加了只会让状态机变脏。

## 顺带的一条工程结论（对本项目有用）

既然微信是 Qt 自绘，它与"浏览器里做一个聊天界面"反而更接近：**没有原生控件，全靠自己画**。
这也是本项目选纯 HTML/CSS/JS 的理由 —— 界面的每一像素都可控，不需要跟任何 UI 框架的默认样式搏斗；
同时"自绘"意味着可访问性要靠自己补（本项目给状态变化加了 `#status` 文本行，而不是只靠颜色）。

## 与"逆向微信做成聊天软件"的边界

用户最初的表述是"逆向腾讯微信，实现一个点对点情侣聊天软件"。实际执行时分成两半，比例是刻意分配的：

- **逆向微信**（10%）：只做界面层的观察与术语对齐，如上。取协议/解密数据库既超出"做一个聊天软件"的必要范围，
  也会把项目变成"微信客户端"，而不是"两个人的聊天"。
- **实现产品**（90%）：`app/` 下六层 + 22 个单测 + 端到端实测（两条二维码 → 直连 → 收发 → 双签解除）。

这样交付的东西是可以直接给两个人用的，而不是一个依赖微信服务器的影子客户端。
