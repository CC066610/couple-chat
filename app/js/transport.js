// transport.js — WebRTC 数据通道，但把 SDP 压成"迷你 SDP"，这样能塞进二维码。
// 不做完整 SDP 交换，是因为一个二维码放不下 2KB 以上的 SDP。

const CANCEL = 0;

/** 等待 ICE 收集完成（不含 STUN 时，本机/局域网候选几乎立刻到齐）。 */
export function iceComplete(pc, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/** 从本地 SDP 里抽出重建远端描述所需的全部字段。 */
export function packSession(sdp) {
  const pick = (re) => {
    const m = re.exec(sdp);
    return m ? m[1] : null;
  };
  const ufrag = pick(/a=ice-ufrag:(\S+)/);
  const pwd = pick(/a=ice-pwd:(\S+)/);
  const fp = pick(/a=fingerprint:sha-256 (\S+)/i);
  const setup = pick(/a=setup:(\S+)/);
  const candidates = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=candidate:\S+ \d+ (\S+) (\d+) (\S+) (\d+) typ (\S+)/.exec(line);
    if (!m) continue;
    // 捕获顺序：proto, priority, ip, port, typ
    const [, proto, /* priority */ , ip, port, typ] = m;
    if (typ === 'host' || typ === 'srflx' || typ === 'prflx') candidates.push([proto, ip, Number(port), typ]);
  }
  return { ufrag, pwd, fp, setup, candidates };
}

/** 用迷你字段重建一份最小可用 SDP（只有 data channel 的 m-line）。 */
export function rebuildSdp(pack, role) {
  const setup = role === 'offer' ? (pack.setup || 'actpass') : 'active';
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${pack.ufrag}`,
    `a=ice-pwd:${pack.pwd}`,
    `a=fingerprint:sha-256 ${pack.fp}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  (pack.candidates || []).forEach(([proto, ip, port, typ], i) => {
    lines.push(`a=candidate:${i + 1} 1 ${proto} 2122260223 ${ip} ${port} typ ${typ}`);
  });
  return lines.join('\r\n') + '\r\n';
}

const RTC_CONFIG = {
  // 默认不带 STUN：零服务器。需要跨公网时在这里加 STUN/TURN 即可（见 docs/PROTOCOL.md）
  iceServers: [],
};

export class Link {
  constructor() {
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.channel = null;
    this.onFrame = () => {};
    this.onBinary = () => {};
    this.onState = () => {};
    this.pc.addEventListener('connectionstatechange', () => this.onState(this.pc.connectionState));
  }

  /** 发起方：建数据通道 → 生成 offer → 等 ICE → 返回可放进二维码的包。 */
  async createOffer() {
    this.channel = this.pc.createDataChannel('chat', { ordered: true });
    this._attach(this.channel);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await iceComplete(this.pc);
    return packSession(this.pc.localDescription.sdp);
  }

  /** 应答方：拿到 offer 包 → 设远端 → 生成 answer → 等 ICE → 返回答案包。 */
  async acceptOffer(pack) {
    this.pc.addEventListener('datachannel', (e) => this._attach(e.channel));
    await this.pc.setRemoteDescription({ type: 'offer', sdp: rebuildSdp(pack, 'offer') });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await iceComplete(this.pc);
    return packSession(this.pc.localDescription.sdp);
  }

  /** 发起方收到答案包。 */
  async acceptAnswer(pack) {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: rebuildSdp(pack, 'answer') });
  }

  _attach(channel) {
    this.channel = channel;
    // RTCDataChannel 默认给 string；附件走 ArrayBuffer，必须显式声明。
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 512 * 1024;
    channel.addEventListener('open', () => this.onState('open'));
    channel.addEventListener('close', () => this.onState('closed'));
    channel.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') {
        // 二进制帧：附件的分块（见 files.js 的线格式）
        try {
          this.onBinary(e.data);
        } catch (err) {
          console.warn('[couple-chat] binary frame error', err);
        }
        return;
      }
      let frame;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onFrame(frame);
    });
  }

  send(frame) {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    this.channel.send(JSON.stringify(frame));
    return true;
  }

  /** 发一块二进制（附件分块）。返回 false 表示链路已经不在。 */
  sendBinary(buf) {
    if (!this.channel || this.channel.readyState !== 'open') return false;
    this.channel.send(buf);
    return true;
  }

  /** 待发字节数：发送附件时用它做背压，避免一次把几百 MB 灌进内存。 */
  get bufferedAmount() {
    return this.channel ? this.channel.bufferedAmount : 0;
  }

  /** 等到待发量降到 limit 以下（背压）。 */
  async drain(limit = 1024 * 1024, timeoutMs = 120000) {
    const started = Date.now();
    while (this.bufferedAmount > limit) {
      if (!this.open) throw new Error('连接已断开，传输中断');
      if (Date.now() - started > timeoutMs) throw new Error('链路太慢，传输超时');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  get open() {
    return !!this.channel && this.channel.readyState === 'open';
  }

  close() {
    try {
      this.channel && this.channel.close();
    } catch {}
    try {
      this.pc.close();
    } catch {}
  }
}
