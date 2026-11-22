# 架构与设计取舍

## 1. 分层

```
┌──────────────────────────────────────────────┐
│ ui.js         DOM / 摄像头 / 消息编排         │  ← 唯一允许碰副作用的一层
├──────────────────────────────────────────────┤
│ pairing.js    二维码载荷：生成/解析/验签      │
│ binding.js    绑定与解除状态机（纯函数）      │
├──────────────────────────────────────────────┤
│ transport.js  WebRTC 数据通道 + 迷你 SDP      │
│ store.js      IndexedDB（本机持久化）         │
├──────────────────────────────────────────────┤
│ crypto.js     ECDSA / ECDH / HKDF / AES-GCM   │
└──────────────────────────────────────────────┘
```

规则：**下面四层不认识 DOM，也不认识 `RTCPeerConnection`**（`transport.js` 里对它的使用被包在 `Link` 类内，`
packSession/rebuildSdp` 是纯函数）。这样 `binding.js`、`pairing.js`、SDP 的 pack/rebuild 都能在 Node 里直接跑单测。

## 2. 为什么要"迷你 SDP"

零服务器意味着**握手信息必须靠人肉信道搬运**（二维码）。而浏览器生成的 SDP 通常 1.5～3 KB，
base64 之后塞进二维码会变成上百个小方块，手机根本扫不动。

做法：只抽取重建远端描述所需的最小集合 —— `ice-ufrag`、`ice-pwd`、DTLS `fingerprint`、`setup`、以及每个候选的
`(proto, ip, port, type)` —— 约 300～600 字节，编码后 ~700 字符，二维码版本 ~10～15，扫得又快又稳。
`transport.js` 的 `rebuildSdp()` 负责把它还原成一份合法的最小 SDP（只有 data channel 的 m-line）。

代价：丢掉了完整 SDP 里的编解码协商、多 m-line、ICE 重启等能力。这个应用只需要一条可靠有序的数据通道，够用。
若将来要加音视频通话，需要扩展 pack/rebuild（比如把 `m=` 段整段也带上），这也正是 `PROTOCOL.md` 里保留 `v` 字段的原因。

## 3. 一对一是怎么被"强制"的

三层，缺一不可：

1. **UI 层**：已绑定时「生成邀请二维码」直接抛 `ALREADY_BOUND`，按钮点了只出红字。
2. **状态机层**（`binding.js`）：`canStartPairing()` / `bound()` 双重检查；`bound()` 只接受与已存指纹**相同**的对端（用于重连），
   不同指纹一律抛错。
3. **协议层**：`finalizeBinding()` 在数据通道打开后**再校验一次**对端指纹；不一致就发 `{t:'error',reason:'already-bound'}` 并断开。
   也就是说，即使有人绕过界面，把一个第三方载荷喂给程序，链路也会在建立后被主动掐断。

解除是**单方即可**的（产品要求）：本机 `unbindNow()` 立刻生效并清库，同时向对端发一条 `unbind-request` 通知帧；
对端收到后 `incomingUnbindNotice()` 无条件同步清空。三层里只有"绑定"需要三层校验，"解除"只需要"是本人在按"——
因为拦住第三方靠的是绑定，而不是解除。本地仍保留一次确认框（`#unbind-ask`），只为防误触，不构成对方否决权。

## 4. 密钥与加密

| 用途 | 算法 | 生命周期 |
|---|---|---|
| 身份证明（签名） | ECDSA P-256 / SHA-256 | 本机首次打开生成，永久存在 IndexedDB |
| 密钥协商 | ECDH P-256 | 同上（私钥存 JWK） |
| 会话密钥 | ECDH → HKDF-SHA256 → AES-256-GCM | 每次重连按需重新派生，不落盘 |
| 指纹 | SHA-256(签名公钥) 前 128 位 → base64url | 用于人眼核对 |

- HKDF 的 `salt` = 双方指纹排序拼接，`info` = `couple-chat/v1/session`。排序保证两端一致，`info` 保证跨版本隔离。
- 会话密钥 `extractable: false`：JS 拿不到原始字节，只能用于 `encrypt/decrypt`。
- 消息体在**写库之前**就 `seal()`，所以 IndexedDB 里只有密文；重载后重新派生会话密钥即可解密历史。

## 5. 扩展点（"易功能拓展"落到具体位置）

| 想加的东西 | 改哪里 | 不改什么 |
|---|---|---|
| 语音/图片 | `ui.js` 的 composer + `crypto.js` 的 `seal`（改成 seal 分片/流） | binding、transport 不用动 |
| 多设备（同一对情侣多端） | `store.js` 的 `peer` 记录改成数组 + `binding.js` 增加 `peers[]` | 握手协议本身不用改 |
| 离线消息队列 | `ui.js`：`sendMessage()` 失败时入本地队列，重连后 flush | crypto / 协议不变 |
| `app/js/recorder.js` | 录音封装：`Recorder.start/stop/cancel`、格式探测与命名 | 不碰 UI，不碰网络；`stop()` 必停轨道 |
| `app/js/receipts.js` | 已读双签、已读水位、通知与免打扰判定 | 纯函数；不碰 DOM/网络/存储 |
| 第二套 UI（比如 Tauri/Electron 壳） | 直接复用 `app/js/*` 除 `ui.js` 之外的全部 | 逻辑层零 DOM 依赖 |
| 换 STUN/TURN | `transport.js` 的 `RTC_CONFIG` | 其余不动 |
| 更换加密套件 | `crypto.js`（全仓唯一的密码学入口） | 上层只调 `seal/unseal/deriveSessionKey` |

## 6. 威胁模型（说清楚能防什么）

**防得住**
- 平台/中间人留存聊天内容：没有服务器，消息不经第三方；二维码是当面/私聊传递，不经过服务器。
- 被动监听局域网：DTLS-SRTP + 应用层 AES-GCM 双层。
- 陌生人搭话：绑定后本机拒绝一切第三方；第三方即使拿到载荷也会被指纹校验掐断。
- 单方甩掉对方：解除必须双方签名确认。
- 随手翻设备：库内是密文（但密钥也在同一台设备上，见下）。

**防不住**
- 对方截图、拍照、录屏。
- 被改造过的客户端：本机状态机是"自己的承诺"，一个逆向过的客户端可以无视它。协议层能保证"对方必须签名才能解除"，
  但无法阻止一个恶意实现自行丢弃本地记录。这是无中心系统的本质边界。
- 设备被完全控制（恶意软件能读 IndexedDB 与内存里的密钥）。
- 长时间离线期间的"中间人换码"：靠**当面核对 22 字符指纹**来防；不核对就只能信任二维码送达渠道。

## 7. 状态机

```
unbound ──offerCreated──▶ offer-ready ──(收到回复码)──▶ 建立链路 ──▶ bound
   ▲                          │                                        │
   │                    answerCreated                      unbindNow()（本地）
   │                          ▼                       或 incomingUnbindNotice()
   └────────────────────── unbound ◀───────────────────────────────────┘
```
只有 `bound` 算"绑定中"（`isBound === true`）。解除没有中间态：按下就是 unbound，
所以不存在"请求解除却还占着位置"的窗口。

## 存储表（IndexedDB `couple-chat`，v2）

| store | key | 内容 |
|---|---|---|
| `identity` | `me` | 长期身份（ECDSA P-256 + ECDH P-256），只在首次启动生成 |
| `peer` | `current` | 绑定中的对端：指纹、公钥、解除挑战用的 nonce |
| `messages` | 消息 id | 消息行；文本消息只有 `{iv,ct}`，附件消息另有 `att` 元数据 |
| `files` | 消息 id | 附件的**密文帧** Blob；明文从不落库，渲染时才解密 |
| `meta` | 任意 | 运行时杂项 |

v1 → v2 的升级只新建 `files` 表，老库里的文本消息不受影响。
