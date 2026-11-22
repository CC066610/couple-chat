# 协议 v1

两种传输内容：**二维码载荷**（人肉信道，一次性）与**数据通道帧**（WebRTC，加密后）。

## 1. 二维码载荷

```jsonc
{
  "v": 1,                       // 协议版本
  "k": "offer" | "answer",      // 角色
  "s": {                        // 迷你 SDP（见 transport.js:packSession）
    "ufrag": "U6t2",
    "pwd": "cQdakGhxJ9dGtjD5SEo0CYTE",
    "fp": "D1:A6:...:F9",       // DTLS 证书 SHA-256 指纹
    "setup": "actpass",         // offer: actpass；answer 侧固定写 active
    "candidates": [["udp", "192.168.1.5", 55011, "host"]]
  },
  "id": "<base64url(签名公钥 raw, 65B)>",
  "dh": "<base64url(ECDH 公钥 raw, 65B)>",
  "n":  "<base64url(8B 随机数)>",
  "sig": "<base64url(ECDSA-P256-SHA256(上面 JSON 的规范序))>"
}
```

- **规范序**：签名输入是 `JSON.stringify({v,k,s,id,dh,n})` 的 UTF-8 字节（`pairing.js:canonical`）。
  验证方必须用同样字段顺序重建，否则验签失败。
- **编码**：整个 JSON → UTF-8 → base64url → 二维码内容（约 700～900 字符）。
- **验签失败即拒绝**，不做"尽力而为"：`verifyPayload()` 抛错，上层显示红字。
- **重放**：`n` 是一次性随机数（`C.randomId(8)`），仅用于日志关联；解除是单方的，不再依赖 nonce 做确认匹配。

## 2. 数据通道帧

全部是 JSON 文本帧，`t` 区分类型。应用层正文已用会话密钥加密（`seal` 输出 `{iv, ct}`）。

| t | 方向 | 字段 | 作用 |
|---|---|---|---|
| `msg` | 双向 | `id, ts, body{iv,ct}` | 一条聊天消息（`body` 是 `{text}` 的密封结果） |
| `unbind-request` | 解除方 → 对方 | `n` | **解除通知**：我已解除，请你同步清空（无应答、无否决） |
| `error` | 双向 | `reason` | 例如 `already-bound`（对端已和别人绑定） |

`unbind-accept` / `unbind-confirm` / `unbind-refuse` 属于 v1 的"双签解除"，**v2 起不再发送**；
收到时直接忽略（`ui.js` 打一行 `忽略旧版解除帧`），以便与旧客户端共存而不卡流程。

解除设计要点（v2 = 单方语义）：

1. **谁按谁生效**：解除方本地立刻 `unbindNow()` 并清 `peer`/`messages`，不等任何回应。
2. **通知而非请求**：`unbind-request` 只是告知；接收方 `incomingUnbindNotice()` 无条件清空，没有 accept/refuse。
   这不会引入新的攻击面 —— 能发出这一帧的前提是"你本来就是已绑定的对端"（链路在 DTLS + 指纹校验之后建立）。
3. **幂等**：两端都按、或通知重复到达，都不报错（已未绑定时返回 null）。
4. **离线解除**：对方不在线也能解除（本机状态已清），他下次打开时本机无对端记录，只能重新配对——符合"任一方可直接解除"。

## 2.2 已读与偏好（v1.4 起）

两个新的控制帧，都和消息走**同一条** DataChannel（因此自动继承 DTLS 加密；内容不过会话密钥，
因为它们不含正文）。

### `seen` —— 我已读到哪

```json
{ "t": "seen", "ts": 1795351031114 }
```

- `ts` 是"已读水位"：本机最近一次真正看到（`visibilityState === 'visible'`）的对方消息时间戳。
- 接收侧做 `peerSeenTs = max(peerSeenTs, ts)`——水位只增不减，乱序或重复帧不会把"已读"退回"已送达"。
- 只在**最新一条我方消息**上渲染结果：`peerSeenTs >= msg.ts` → `已读`，否则 `已送达`。
- 已读回执未生效（双签未齐）时，收到 `seen` 也只存水位、不显示。

### `pref` —— 我的开关

```json
{ "t": "pref", "read": true, "dnd": false, "notify": true }
```

- 每次勾选/取消都会立刻广播一次；绑定建立时（`finalizeBinding`）也会先发一次，保证两端状态一致。
- `read` 是**已读回执意愿**：只有 `mine.read && peer.read` 才生效（双签）。任一方关掉即时失效。
- `dnd` 是免打扰（只压通知）；`notify` 是是否要系统通知，两者都是本机偏好，对端只做展示，不能替你改。
- 断开/解除后，对端偏好与已读水位一起清除（`meta.peerPrefs` / `meta.peerSeenTs` 删除），
  本机自己的开关保留。

## 3. 握手时序

```
A                                    B
│ createOffer() → offer 包            │
│ ── 二维码 / 粘贴 ─────────────────▶ │ acceptOffer(): verifyPayload → setRemote(offer)
│                                     │ createAnswer() → answer 包
│ ◀───────────────── 二维码 / 粘贴 ── │
│ acceptAnswer(): verifyPayload → setRemote(answer)
│                                     │
│ ═══ DTLS 握手 / DataChannel open ══▶ │
│ finalizeBinding(): 指纹校验 → bound │ finalizeBinding(): 指纹校验 → bound
│                                     │
│ ◀──────── sealed messages ─────────▶ │
```

两端的会话密钥分别用"自己的 ECDH 私钥 + 对方的 ECDH 公钥"派生，`salt` 取双方指纹排序拼接，因此必然一致。

## 4. 兼容性

- `v` 不匹配 → 拒绝（`payload.v !== 1`）。加字段请升 `v` 并在 `decodePayload` 里做分支。
- `k` 只允许 `offer`/`answer`；未知角色拒绝。
- 迷你 SDP 丢了完整协商能力：加音视频时需要扩展 `s`（例如带上 `m=` 段），同样要升版本号。

## 附件（v1.2 起）

附件不走 JSON 帧，而是「一条加密元数据帧 + N 条二进制帧」。原因：base64 会把体积撑大 33%，
而且 WebRTC DataChannel 本来就支持二进制。

### 1. 元数据帧（走文本帧，与普通消息同一条通道）

```json
{ "t": "msg", "id": "<文件 id：12 字节随机，base64url，16 字符>", "ts": 1763800000000,
  "body": { "iv": "...", "ct": "..." } }
```

`body` 解密后的明文是：

```json
{ "file": { "name": "photo.png", "mime": "image/png", "size": 1048576,
            "chunks": 32, "chunk": 32768, "kind": "image" } }
```

`kind` 由发送方按 MIME（优先）与扩展名（兜底）推断，取值 `image / video / audio / file`，
接收方只拿它决定渲染方式，不参与任何安全判断。

### 2. 二进制帧（每块一条）

```
偏移  长度   内容
0     16     文件 id（ASCII，与元数据帧的 id 相同，不足 16 字节补 0x00）
16    4      块序号，大端 uint32，从 0 开始
20    12     AES-GCM IV（每块独立随机，不复用）
32    n+16   密文（明文块 n 字节 + 16 字节 GCM tag）
```

- 明文块固定 `chunk` 字节，最后一块按余数变短；`size`、`chunk`、`chunks` 都在元数据里，
  所以接收方无需索引即可从「按序拼接的密文流」里切回每一块。
- **每块单独加密**（不是整文件一个 IV）：视频动辄几十 MB，WebCrypto 没有流式 AES-GCM，
  逐块加密才能边传边解、坏一块不连累整份。
- 发送侧用 `drain()` 做背压：`channel.bufferedAmount` 超过 1 MB 就等 `bufferedamountlow`，
  避免一次把几百 MB 灌进 SCTP 缓冲把浏览器卡死。
- 接收侧把密文帧按序拼成一个 Blob 落库（形如 `[帧0][帧1]…`），渲染时按块长切回去解密。

### 2.1 语音消息（v1.3 起）

语音不是新帧类型，就是附件元数据上多两个字段：

```json
{ "file": { "id": "AB12cd34EF56gh78", "name": "语音 20-12-28.webm",
            "mime": "audio/webm;codecs=opus", "size": 16084, "chunks": 1,
            "voice": true, "dur": 2580 } }
```

- `voice: true` 只影响接收端的渲染（音频元素 + 名字后附 `（0:02）`）与排序习惯，不影响加密与分块。
- `dur` 是发送端 `MediaRecorder` 的实际录音时长（毫秒）；接收端不重算，避免解码一整段音频。
- `mime` 可能是 `audio/webm`、`audio/ogg`、`audio/mp4`（Safari），接收端按 `kindOf()` 归到 `audio`，
  播放器失败时退化成普通文件下载项。

### 3. 失败语义

| 情况 | 表现 |
|---|---|
| 某块丢了 / 没传完 | 该块缺失，`decryptStream` 报「密文长度不符：文件可能被截断」，气泡显示「没传完」 |
| 单块被篡改 | GCM 校验失败，整份放弃（不会静默输出半份错内容） |
| 本地没有这份附件 | 历史里的气泡显示「本机没有这份附件（可能没传完）」 |
| 超过 300 MB | 发送前就拒绝，不入库 |
