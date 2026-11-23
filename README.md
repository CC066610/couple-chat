# 两个人的聊天（couple-chat）

一个只属于两个人的点对点聊天：**没有服务器、没有账号、没有云端**。两个人在各自设备上打开页面，用两张二维码完成握手，
之后浏览器之间直连；关系一旦建立就锁死，除非**双方都同意**，否则不能和任何第三个人建立对话；所有消息只写进各自设备的本地数据库。

```
两个人 + 两张二维码  →  浏览器 ↔ 浏览器（WebRTC DataChannel，端到端加密）
                              ↓
                     只落在本机 IndexedDB（写入前已加密）
```

## 为什么不是"再来一个 IM"

| 常见做法 | 问题 | 这里怎么做 |
|---|---|---|
| 服务端存消息 | 平台能看到、能留存、能合规调取 | 没有服务端；消息不进任何第三方 |
| 账号 + 好友列表 | 需要一个中心化身份源 | 身份是本机生成的密钥对，指纹即身份 |
| 扫码加好友 → 服务器配对 | 配对逻辑在服务器上，可被改写 | 二维码里就是 WebRTC 的 offer/answer，本地直连 |
| 解除关系只需一方操作 | 对方被无声甩掉、还以为在聊 | 任一方按下即生效（本地确认框防误触），同时通知对方在本机清空这段关系 |

## 快速开始

```bash
cd couple-chat
node serve.mjs                 # 打开 http://127.0.0.1:8123/
```

两台设备（或两个浏览器）各开一个：

1. **A** 点「生成邀请二维码」→ 得到二维码和一个可复制的码。
2. **B** 点「扫描二维码」（用摄像头）或在「粘贴对方的码」里贴入 A 的码 → B 得到「回复二维码」。
3. **A** 扫/贴 B 的回复码 → 双方状态变成「已绑定 · 端到端加密」。
4. 开始聊。顶部徽标显示「已绑定」；对端指纹显示在聊天页header，可当面核对（防中间人）。
5. 解除：**任一方**点「解除关系」→ 本地再确认一次（防误触）→ 立刻解除；对方那台机器收到通知后同步清空，不需要对方同意。

> 摄像头扫码需要 `http://localhost` 或 https（浏览器的安全上下文要求）。粘贴方式不受限制。
> 跨设备使用时，两台机器要在同一局域网（或能直连），因为默认不带 STUN 服务器 —— 这是"零服务器"的代价。

## 需求对照

| 你的要求 | 实现位置 |
|---|---|
| 仅两个用户绑定交流 | `app/js/binding.js`：`canStartPairing()` 在已绑定时抛错；`bound()` 拒绝不同指纹 |
| 绑定期无法与任何第三人建立对话；解除由**任一方**直接完成 | `binding.js`：绑定期拒绝一切第三方（三层校验）；解除为**单方即可**（`unbindNow()` + `incomingUnbindNotice()`，`ui.js` 的 `unbind-request` 通知帧） |
| 扫描二维码匹配聊天对象 | `app/js/pairing.js`（载荷编解码）+ `app/vendor/qrcode.js`（生成）+ `ui.js` 的 `startScan()`（`BarcodeDetector`） |
| 易维护、易功能拓展 | 六层切分：crypto / transport / pairing / binding / store / ui，逻辑层零 DOM 零网络，22 个单测覆盖 |
| 无官方（无中心服务器） | 零后端：静态文件 + WebRTC 直连；SDP 压成 ~700 字节塞进二维码 |
| 聊天内容仅存用户设备 | `app/js/store.js` IndexedDB；`ui.js` 写库前用会话密钥 AES-GCM 加密 |

## 目录

```
couple-chat/
├── app/
│   ├── index.html          三个面板：配对 / 聊天 / 说明
│   ├── styles.css
│   ├── vendor/qrcode.js    二维码生成（qrcode-generator，MIT，已本地化）
│   └── js/
│       ├── crypto.js       ECDSA(P-256) 签名 · ECDH→HKDF→AES-256-GCM · 指纹
│       ├── transport.js    WebRTC + 迷你 SDP（pack/rebuild）
│       ├── pairing.js      二维码载荷：生成 / 编解码 / 验签
│       ├── binding.js      绑定状态机（纯逻辑，可单测）
│       ├── store.js        IndexedDB 持久层
│       └── ui.js           编排层：DOM、摄像头、消息流、解除流程
├── test/                   22 个 node:test 用例
├── docs/
│   ├── ARCHITECTURE.md     分层、扩展点、安全模型
│   ├── PROTOCOL.md         握手与消息帧格式（可直接照此实现第二客户端）
│   └── WECHAT-STUDY.md     craft-anything 对微信（Weixin 4.2.0.13）的观察记录
└── serve.mjs               本地静态服务（localhost = 安全上下文）
```

## 测试

```bash
cd couple-chat
node --test test/*.test.js
# tests 23  pass 23  fail 0
```

覆盖：指纹稳定性、签名/篡改、双方 ECDH 一致性、salt 隔离、base64url、绑定状态机全部转移、
**单方解除与通知幂等**、二维码载荷验签与篡改拒绝、迷你 SDP 解析与重建。

## 已知限制（诚实清单）

- **没有 STUN/TURN**：同一局域网/可直连最稳。跨公网 NAT 需要自己在 `transport.js` 的 `RTC_CONFIG.iceServers` 里加 STUN，
  或改用 TURN 中继（那就有服务器了，属于另一种取舍）。
- **清浏览器数据 = 身份和历史一起消失**：这正是"只存在你设备里"的另一面。要长期用，别用无痕窗口。
- **不做离线消息**：对方不在线时发不出去（P2P 的必然结果）。可在 `ui.js` 的 `sendMessage()` 外面包一层本地待发队列作为扩展。
- **不防对方截图**，也不防被改造过的客户端 —— 见 `docs/ARCHITECTURE.md` 的威胁模型。
- **解除是单方的**：一方按下即生效，不需要对方在线同意。代价是「被解除的一方没有否决权」——这正是你要的语义（谁都能立刻退出）。

## 许可

MIT。二维码生成部分来自 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT）。

## 附件：图片 / 视频 / 文件（v1.2 起）

聊天框左边多了一个「＋」，或者干脆：

| 方式 | 操作 |
|---|---|
| 选文件 | 点「＋」选一个或多个，可多选 |
| 粘贴 | 截图后直接 Ctrl+V（剪贴板里的图片或资源管理器复制的文件都行） |
| 拖进来 | 把文件拖到聊天区，出现虚线框后松手 |

- 图片直接显示（点一下新标签打开），视频/音频带播放器，其他类型给一个「下载 xxx」。
- 传输是**分块**的：32 KB 一块，每块单独 AES-256-GCM 加密，块序号写在帧头（见 docs/PROTOCOL.md）。
  所以几十 MB 的视频也不会一次性吃满内存；`drain()` 做背压，`bufferedAmount` 超过 1 MB 就等一等。
- 单文件上限 **300 MB**（内存 + IndexedDB 的折中，想改就改 `app/js/files.js` 的 `MAX_BYTES`）。
- 附件和文本一样**只存在设备上**：落库的是密文帧，重开页面时按块解密再渲染；
  清浏览数据 = 附件一起没了（对方那边还在）。
- 传输中气泡上有进度条；中断会显示「没传完」，历史里会显示「本机没有这份附件」。

自测（没有文件对话框的环境）：

```bash
# 两个端口各起一份，地址后面加 #dev 会出现三个自测按钮：
#   发一张生成的图 / 发 1.2 MB 测试文件 / 取对方 offer|answer 码
PORT=8123 node serve.mjs
PORT=8124 node serve.mjs
```

`#dev` 会用 `serve.mjs` 的 `/dev/publish` 把配对码落到 `app/dev/`，让另一端口读回去 ——
只是为了在自动化环境里跳过「复制长串码」这一步，正式发行版（exe / apk）用不到它。

## 语音消息（v1.3 起）

按住 🎤 录、再点一次发送；录的时候可以「取消」。收方看到的是可播放的音频条，名字后面带时长。

- 录音：`getUserMedia({audio:true})` + `MediaRecorder`（250 ms 分片）。格式按优先级试探
  `audio/webm;codecs=opus` → `audio/webm` → `audio/ogg;codecs=opus` → `audio/mp4`，
  都不支持就交给浏览器默认，Safari 那边会落到 `.m4a`。
- 传输：语音就是"一条附件消息"，走的是同一条分块加密通道（32 KB/块、每块独立 IV、AES-256-GCM），
  元数据里多两个字段：`voice: true` 和 `dur`（毫秒）。所以 ≥300 MB 的上限、背压、落库前加密都自动继承。
- 太短（<400 ms）或空录音会被拦下，提示「太短了」，不发送也不落库。
- 停止时 `getTracks().stop()`，麦克风指示灯不会一直亮着；切换标签页/关页面不会留下悬挂的录音。

浏览器限制照旧：只有 `http://127.0.0.1`、`https` 与 App 内嵌的 localhost 页面能拿到麦克风；
从 `http://192.168.x.x` 打开时浏览器会拒绝，页面会提示改用本机地址或手机 App。

## 已读回执 / 桌面通知 / 免打扰（v1.4 起）

三件事都放在「说明 → 偏好」里，各自设置、互不强制。

### 已读回执（双签）

- **双方都开启才生效**：任一方关掉，两边都不再显示已读（对方能看见你的开关状态）。
- **只标在最新一条消息上**：新消息发出后，旧消息上的「已读」自动清掉，不会堆一屏。
- 状态两个：`已送达`（帧已进对端链路）与 `已读`（对端页面**可见**且已读到）。
- 判定用时间戳水位：`{t:'seen', ts}`，水位只增不减（乱序/重发不会把"已读"退回"已送达"）。
- 只有页面 `visibilityState === 'visible'` 才算"看到"——切到别的窗口/最小化时不会替你上报。

### 桌面通知

- 页面在后台（`hidden`）时，新消息用系统通知提醒；前台不打扰（你正看着）。
- 首次勾选「桌面通知」时向浏览器请求权限；被拒绝会在偏好里明确写出来（去站点设置改）。
- 通知正文：文本消息取前 60 字，附件显示类型与文件名（如「语音：语音 20-12-28.webm」）。
- 同一条关系只保留一个通知（`tag`），不会堆叠。

### 免打扰

- **本机个人开关**，只压通知，不影响消息收取、不影响已读回执。
- 对方能看到你开了免打扰（偏好状态会同步），但**不能替你关掉**。

传输层新增两个帧（`seen` / `pref`），格式与语义见 `docs/PROTOCOL.md`「已读与偏好」。
纯逻辑在 `app/js/receipts.js`（单测 `test/receipts.test.js`，9 条）。

## 签名与备份（重要）

安卓包的**升级资格**由签名证书决定：`android/couplechat-release.keystore` 的私钥一旦丢失，
老用户只能卸载重装，而卸载会清掉身份与全部历史。这个文件**故意不进 git、不进 Release**。

- 细节、指纹、备份/恢复命令：见 [`docs/KEYSTORE.md`](docs/KEYSTORE.md)
- 加密备份工具：`tools/keystore-backup.py`（scrypt + AES-256-GCM，容器 `.ccks`）
- 每次发版校验一条：`apksigner verify --print-certs android/dist/CoupleChat-<ver>.apk | findstr /i SHA-256`
  必须等于 `5d05ce76c2764822d48554171dbe6442e0120452a4dc74d47cc8d508f8596991`

## 手机端（安卓 APK）

浏览器里能跑，但手机上要"像 App 一样用"，有两个硬约束：

1. **摄像头（扫码）只在安全上下文可用** —— Android 上只有 `http://127.0.0.1`、`localhost`、`https://` 算安全上下文；
   局域网 `http://192.168.x.x` 和 `file://` 都不算。
2. **`crypto.subtle` 同样要求安全上下文** —— 没有它就连密钥都生成不出来。

所以 `android/` 目录是一个**自带进程内 HTTP 服务的外壳**：Activity 在 `127.0.0.1:17321`（被占用则自动往后试）
起一个只听本机回环的迷你服务，把 `assets/www`（= `app/` 的副本）喂给 WebView。于是页面 origin 是
`http://127.0.0.1:端口`：摄像头可用、IndexedDB 可用、聊天记录只落在这台手机上。

### 构建（不需要 Android Studio / Gradle）

```bash
# 一次性：build-tools 34 + platform 34 + 独立 r8.jar（放 D:\dsh\_ca\android\）
curl -x http://127.0.0.1:7897 -L -o build-tools_r34.zip https://dl.google.com/android/repository/build-tools_r34-windows.zip
curl -x http://127.0.0.1:7897 -L -o platform-34.zip      https://dl.google.com/android/repository/platform-34-ext7_r03.zip
curl -x http://127.0.0.1:7897 -L -o r8-8.11.18.jar       https://maven.google.com/com/android/tools/r8/8.11.18/r8-8.11.18.jar

# 每次构建
python android/build.py --version 1.1
# -> android/dist/CoupleChat-1.1.apk
```

流水线：`javac --release 8` → `d8` → `aapt2 compile/link` → 塞 `classes.dex` → `zipalign` → `apksigner`。
签名用 `android/couplechat-release.keystore`（首次自动生成，口令 `couplechat`；升级要用同一把）。

### 踩过的坑（省下次的时间）

- **build-tools 34 自带的 `d8.bat`（R8 8.2.2）在 JDK 21 上直接 NPE**（`Cannot invoke "String.length()" ...
  R8_8.2.2 ... R0.a`），换独立发布的 `r8.jar`（8.11.x）跑同一个 `com.android.tools.r8.D8` 就好。
- `javac` 不能再用 `-bootclasspath`（JDK 9+ 移除），用 `--release 8 -classpath android.jar`。
- `platform-34_r03.zip` 这个文件名不存在（404），清单里是 `platform-34-ext7_r03.zip`；解包后是 `android-34/android.jar`。
- WebView **没有 `BarcodeDetector`**，所以扫码加了 `vendor/jsQR.js` 兜底（canvas 取帧 → jsQR 解码），
  桌面 Firefox/Safari 也顺带受益。
- 顶部栏是 flex + 三个 min-content 块，窄屏不换行会撑出横向溢出；已在 `@media (max-width: 560px)` 里处理。

### HTTP 层不必上真机就能验

`AssetServer` 刻意不依赖 `android.*`，内容由 `Source` 接口提供，于是同一份代码能在桌面用文件目录跑：

```bash
cd android
javac --release 8 -d build/harness-classes src/com/couplechat/app/AssetServer.java harness/ServerHarness.java
java -cp build/harness-classes ServerHarness assets/www 18321
curl -i http://127.0.0.1:18321/js/ui.js
```
