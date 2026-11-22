// ui.js — 界面与编排层。所有副作用（DOM、摄像头、IndexedDB、WebRTC）都集中在这里，
// 逻辑判断走 crypto / pairing / transport / binding 这些可单测的模块。

import * as C from './crypto.js';
import * as S from './store.js';
import * as F from './files.js';
import { Recorder, fmtDuration, voiceName } from './recorder.js';
import { Binding, State } from './binding.js';
import { makePayload, encodePayload, decodePayload, verifyPayload } from './pairing.js';
import { Link } from './transport.js';
import * as R from './receipts.js';

const $ = (id) => document.getElementById(id);
const log = (...a) => console.log('[couple-chat]', ...a);

const app = {
  identity: null,
  fp: '',
  binding: new Binding(),
  link: null,
  sessionKey: null,
  pendingOffer: null,
  scanning: null,
  outgoing: new Map(),   // 正在发的附件：id -> {el, meta}
  incoming: new Map(),   // 正在收的附件：id -> {meta, parts[], got, el, msg}
  urls: new Map(),
  rec: null,
  offerNonce: null,       // 已解密附件的 objectURL 缓存：id -> url
  prefs: { ...R.DEFAULT_PREFS },  // 本机偏好：已读回执 / 免打扰 / 通知
  peerPrefs: null,                // 对方的偏好（对方发 pref 帧传来）
  peerSeenTs: 0,                  // 对方已读到的水位（时间戳）
  seenSentTs: 0,                  // 我已上报给对方的已读水位，避免重复发
  mineRows: [],                   // 我发出的消息气泡：{ts, el}，用于给最新一条贴"已读"
  lastTheirsTs: 0,                // 对方最后一条消息的时间戳
  seenTimer: null,
};

/* ---------------- 身份 ---------------- */

async function bootIdentity() {
  const saved = await S.get('identity', 'self');
  if (saved) {
    app.identity = await C.importIdentity(saved);
  } else {
    app.identity = await C.generateIdentity();
    const exported = await C.exportIdentity(app.identity);
    app.identity = await C.importIdentity(exported);
    await S.put('identity', 'self', exported);
  }
  app.fp = await C.fingerprint(app.identity.signPublicRaw);
  $('fingerprint').textContent = app.fp;
}

async function loadPeer() {
  const peer = await S.get('peer', 'current');
  if (!peer) return;
  app.binding = new Binding(State.BOUND, { ...peer, boundAt: peer.boundAt });
  app.sessionKey = await C.deriveSessionKey(app.identity, C.b64u.dec(peer.dh), sessionSalt(app.fp, peer.fingerprint));
  renderBound(peer);
  await renderHistory();
}

function sessionSalt(a, b) {
  const pair = [a, b].sort().join('|');
  return C.utf8(pair);
}

/* ---------------- 视图切换 ---------------- */

function showTab(name) {
  for (const t of ['pair', 'chat', 'about']) {
    $('tab-' + t).classList.toggle('active', t === name);
    $('panel-' + t).classList.toggle('hidden', t !== name);
  }
}

function hidePairStep() {
  $('pair-step').classList.add('hidden');
  $('qr').innerHTML = '';
  $('code-out').value = '';
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function renderBound(peer) {
  $('peer-fp').textContent = peer.fingerprint;
  $('bound-badge').textContent = '已绑定';
  $('bound-badge').className = 'badge ok';
  $('chat-input').disabled = false;
  $('btn-attach').disabled = false;
  $('btn-mic').disabled = false;
  $('btn-unbind').disabled = false;
  showTab('chat');
}

function renderUnbound() {
  $('peer-fp').textContent = '（未绑定）';
  $('bound-badge').textContent = '未绑定';
  $('bound-badge').className = 'badge';
  $('chat-input').disabled = true;
  $('btn-attach').disabled = true;
  $('btn-mic').disabled = true;
  $('btn-unbind').disabled = true;
  $('messages').innerHTML = '';
  hidePairStep();
  setStatus('未绑定。生成邀请二维码，或扫描对方的邀请。');
  showTab('pair');
}

/* ---------------- 配对 ---------------- */

function qrInto(el, text) {
  el.innerHTML = '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
}

async function startPairing({ reconnect = false } = {}) {
  if (!reconnect) app.binding.canStartPairing();
  teardownLink();
  app.link = new Link();
  app.link.onFrame = onFrame;
  app.link.onBinary = onBinary;
  app.link.onState = (state) => onLinkState(state);
  const session = await app.link.createOffer();
  const payload = await makePayload('offer', session, app.identity);
  app.offerNonce = payload.n;                 // 回复码必须指回这个 nonce，防止拿旧回复糊到新邀请上
  const code = encodePayload(payload);
  qrInto($('qr'), code);
  $('code-out').value = code;
  log('PAIR-CODE:' + code); // 便于自动化验证：从控制台取出这个码
  devPublish('offer', code);
  $('pair-step').classList.remove('hidden');
  $('pair-step-title').textContent = reconnect ? '重新连接的邀请' : '你的邀请二维码';
  $('pair-hint').textContent = '把这个二维码给对方扫（或把下面的码发给对方）。对方接受后，把对方的回复码粘回来。';
  if (!reconnect) app.binding.offerCreated();
  setStatus('等待对方回应…', 'busy');
}

async function acceptOffer(text) {
  const payload = decodePayload(text);
  if (payload.k !== 'offer') throw new Error('这不是邀请码，而是回复码。请让对方扫你的邀请。');
  const info = await verifyPayload(payload);
  if (app.binding.isBound) {
    const peer = app.binding.peer;
    if (!peer || peer.fingerprint !== info.fingerprint) {
      throw new Error('你已经和别人绑定，不能接受第三方的邀请');
    }
  }
  teardownLink();
  app.link = new Link();
  app.link.onFrame = onFrame;
  app.link.onBinary = onBinary;
  app.link.onState = (state) => onLinkState(state);
  const session = await app.link.acceptOffer(info.session);
  const reply = await makePayload('answer', session, app.identity, { replyTo: payload.n });
  const code = encodePayload(reply);
  qrInto($('qr'), code);
  $('code-out').value = code;
  log('PAIR-CODE:' + code);
  devPublish('answer', code);
  $('pair-step').classList.remove('hidden');
  $('pair-step-title').textContent = '你的回复二维码';
  $('pair-hint').textContent = '让对方扫这个二维码（或把码发回给对方）。对方接受后链路就通了。';
  app.pendingOffer = info;
  if (app.link.open) await finalizeBinding();     // 同上：别漏掉已经发生的 open
  if (!app.binding.isBound) app.binding.answerCreated();
  setStatus('已生成回复，等待对方接收…', 'busy');
}

async function acceptAnswer(text) {
  const payload = decodePayload(text);
  if (payload.k !== 'answer') throw new Error('这不是回复码。应该是对方扫了你的邀请后生成的码。');
  const info = await verifyPayload(payload);
  if (!app.link) throw new Error('还没有自己的邀请，请先点击"生成邀请二维码"');
  if (payload.re && app.offerNonce && payload.re !== app.offerNonce) {
    throw new Error('这个回复码不是给你现在这个邀请生成的（可能已过期，或来自更早的一次配对）。让对方重新扫你当前屏幕上的二维码。');
  }
  await app.link.acceptAnswer(info.session);
  app.pendingOffer = info;
  setStatus('正在建立直连…', 'busy');
  // 链路可能已经在这几毫秒里 open 了（open 事件早于 pendingOffer 赋值），补一次收尾
  if (app.link.open) await finalizeBinding();
}

async function onLinkState(state) {
  log('link state', state);
  if (state === 'open') {
    await finalizeBinding();
  } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
    if (app.quietClose) {
      // 解除流程里主动关的链路：别用"连接已断开"覆盖"关系已解除"的提示
      app.quietClose = false;
      return;
    }
    setStatus('连接已断开。可点"重新连接"。', 'warn');
    $('btn-reconnect').classList.remove('hidden');
  }
}

async function finalizeBinding() {
  const peer = app.pendingOffer;
  if (!peer) return;
  if (app.binding.isBound && app.binding.peer && app.binding.peer.fingerprint !== peer.fingerprint) {
    app.link.send({ t: 'error', reason: 'already-bound' });
    setStatus('拒绝：本机已绑定其他人', 'bad');
    teardownLink();
    return;
  }
  const record = {
    fingerprint: peer.fingerprint,
    sign: C.b64u.enc(peer.signPublicRaw),
    dh: C.b64u.enc(peer.dhPublicRaw),
    boundAt: app.binding.peer ? app.binding.peer.boundAt : Date.now(),
  };
  app.binding.bound(record);
  await S.put('peer', 'current', record);
  app.sessionKey = await C.deriveSessionKey(app.identity, peer.dhPublicRaw, sessionSalt(app.fp, peer.fingerprint));
  renderBound(record);
  setStatus('直连已建立 · 端到端加密', 'ok');
  $('btn-reconnect').classList.add('hidden');
  sendPrefs();                 // 先把本机开关推过去，双方状态立刻一致
  await renderHistory();
  sendSeenSoon();
  if (!app.binding.peer.messagesShown) app.binding.peer.messagesShown = true;
}

/* ---------------- 偏好：已读回执 / 免打扰 / 通知 ---------------- */

async function loadPrefs() {
  const mine = await S.get('meta', 'prefs');
  app.prefs = { ...R.DEFAULT_PREFS, ...(mine || {}) };
  app.peerPrefs = (await S.get('meta', 'peerPrefs')) || null;
  app.peerSeenTs = (await S.get('meta', 'peerSeenTs')) || 0;
  renderOpts();
  refreshReceipts();
}

async function savePrefs() {
  await S.put('meta', 'prefs', app.prefs);
  sendPrefs();
  renderOpts();
  refreshReceipts();
  sendSeenSoon();               // 刚开启已读：把当前看到的位置立刻报过去
}

function sendPrefs() {
  if (!app.link || !app.link.open) return;
  app.link.send({ t: 'pref', read: !!app.prefs.read, dnd: !!app.prefs.dnd, notify: app.prefs.notify !== false });
}

function receiptsOn() {
  return R.readOn(app.prefs, app.peerPrefs);
}

/** 只在最新一条我方消息上显示 已读 / 已送达；双签没开就一条都不显示。 */
function refreshReceipts() {
  const on = receiptsOn();
  const rows = app.mineRows;
  const newest = rows.length ? rows.reduce((a, b) => ((b.ts || 0) > (a.ts || 0) ? b : a)) : null;
  for (const r of rows) {
    const rc = r.el.querySelector('.receipt');
    if (!rc) continue;
    const label = R.labelFor({ readOn: on, isLatest: r === newest, peerSeenTs: app.peerSeenTs, ts: r.ts });
    if (rc.textContent !== label) rc.textContent = label;
    rc.classList.toggle('hidden', !label);
  }
}

/** 上报已读：合并成一次，且只在页面确实可见（人在看）时才算已读。 */
function sendSeenSoon() {
  if (app.seenTimer) return;
  app.seenTimer = setTimeout(() => {
    app.seenTimer = null;
    flushSeen();
  }, 250);
}

function flushSeen(force = false) {
  if (!app.link || !app.link.open) return;
  if (!receiptsOn()) return;
  if (!force && document.visibilityState !== 'visible') return;   // 只有页面真的可见（人在看）才算已读
  const ts = app.lastTheirsTs;
  if (!ts || ts <= app.seenSentTs) return;
  app.seenSentTs = ts;
  app.link.send({ t: 'seen', ts });
}

function renderOpts() {
  const read = $('opt-read');
  if (!read) return;
  read.checked = !!app.prefs.read;
  $('opt-dnd').checked = !!app.prefs.dnd;
  $('opt-notify').checked = app.prefs.notify !== false;
  $('opt-status').textContent = R.receiptStatusText(app.prefs, app.peerPrefs);
  const p = app.peerPrefs;
  $('opt-peer').textContent = p
    ? '对方：已读回执' + (p.read ? '开' : '关') + ' · 免打扰' + (p.dnd ? '开' : '关')
    : '对方：当前读不到（没连上或还没同步）';
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  $('opt-perm').textContent =
    perm === 'granted' ? '通知权限：已允许（页面在后台时会提醒）'
    : perm === 'denied' ? '通知权限：被浏览器拒绝（到站点设置里改）'
    : perm === 'unsupported' ? '通知权限：这个环境不支持系统通知'
    : '通知权限：还没请求（勾选「桌面通知」时请求）';
}

function maybeNotify(payload) {
  const perm = typeof Notification === 'undefined' ? 'denied' : Notification.permission;
  if (!R.shouldNotify({ visibility: document.visibilityState, prefs: app.prefs, permission: perm })) return;
  try {
    const n = new Notification('两个人的聊天', {
      body: R.notifyBody(payload),
      tag: 'couple-chat',            // 同一条关系只保留一个通知，不堆叠
      renotify: true,
    });
    n.onclick = () => {
      try { window.focus(); } catch {}
      n.close();
    };
  } catch (e) {
    log('通知发送失败', e && e.message);
  }
}

/* ---------------- 消息 ---------------- */

async function sendMessage() {
  const input = $('chat-input');
  const textToSend = input.value.trim();
  if (!textToSend || !app.sessionKey) return;
  const msg = {
    id: C.randomId(8),
    ts: Date.now(),
    from: 'me',
    body: await C.seal(app.sessionKey, { text: textToSend }),
  };
  const ok = app.link && app.link.send({ t: 'msg', id: msg.id, ts: msg.ts, body: msg.body });
  if (!ok) {
    setStatus('发送失败：连接不在。点"重新连接"。', 'bad');
    return;
  }
  input.value = '';
  await persistMessage(msg);
  appendBubble(msg, textToSend);
}

async function persistMessage(msg) {
  await S.put('messages', msg.id, msg);
}

async function renderHistory() {
  const rows = await S.all('messages');
  rows.sort((a, b) => a.ts - b.ts);
  $('messages').innerHTML = '';
  app.mineRows = [];
  app.lastTheirsTs = 0;
  if (!app.sessionKey) return;
  for (const row of rows) {
    if (row.att) {
      const el = appendAttachment(row, row.att);
      hydrateAttachment(el, row);
      continue;
    }
    try {
      const { text } = await C.unseal(app.sessionKey, row.body);
      appendBubble(row, text);
    } catch {
      appendBubble(row, '（无法解密的历史消息）');
    }
  }
  refreshReceipts();
  sendSeenSoon();
}

function appendBubble(msg, text) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble ' + (msg.from === 'me' ? 'mine' : 'theirs');
  const p = document.createElement('div');
  p.className = 'text';
  p.textContent = text;
  const rc = document.createElement('div');
  rc.className = 'receipt hidden';
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date(msg.ts).toLocaleTimeString();
  wrap.dataset.mid = msg.id;
  wrap.append(p, rc, time);
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;
  registerBubble(msg, wrap);
}

/** 记住自己发的消息气泡（贴已读用），以及对方最后一条的时间戳（上报已读用）。 */
function registerBubble(msg, wrap) {
  if (msg.from === 'me') {
    app.mineRows.push({ ts: msg.ts, el: wrap });
    refreshReceipts();
  } else {
    app.lastTheirsTs = Math.max(app.lastTheirsTs || 0, msg.ts || 0);
    if (document.visibilityState === 'visible') sendSeenSoon();
  }
}

/* ---------------- 附件：图片 / 视频 / 任意文件 ---------------- */

/** 开发自测：把本端生成的码写到本机服务的 app/dev/ 下（仅 serve.mjs 提供该接口）。 */
function devPublish(kind, code) {
  if (location.hash !== '#dev') return;
  fetch('/dev/publish?k=' + kind, { method: 'POST', body: code }).catch((e) => log('devPublish 失败', e && e.message));
}

/** 开发自测：从本机服务读回另一端发布的码（两个端口共用一个目录）。 */
async function devFetch(kind) {
  const r = await fetch('dev/' + kind + '.txt?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('还没有 ' + kind + ' 码（对方还没生成）');
  return (await r.text()).trim();
}

function appendAttachment(msg, meta) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble att-bubble ' + (msg.from === 'me' ? 'mine' : 'theirs');

  const box = document.createElement('div');
  box.className = 'att';

  const media = document.createElement('div');
  media.className = 'att-media';

  const bar = document.createElement('div');
  bar.className = 'att-bar';
  bar.innerHTML = '<i></i>';

  const label = document.createElement('div');
  label.className = 'att-progress';
  label.textContent = '准备中…';

  const foot = document.createElement('div');
  foot.className = 'att-foot';
  const name = document.createElement('span');
  name.className = 'att-name';
  name.textContent = meta.name;
  const size = document.createElement('span');
  size.className = 'att-size';
  size.textContent = F.prettySize(meta.size);
  foot.append(name, size);

  box.append(media, bar, label, foot);
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = new Date(msg.ts).toLocaleTimeString();
  const rc = document.createElement('div');
  rc.className = 'receipt hidden';
  wrap.dataset.mid = msg.id;
  wrap.append(box, rc, time);
  $('messages').appendChild(wrap);
  $('messages').scrollTop = $('messages').scrollHeight;
  registerBubble(msg, wrap);
  return wrap;
}

function setProgress(el, ratio, note) {
  if (!el) return;
  const bar = el.querySelector('.att-bar');
  const fill = bar ? bar.querySelector('i') : null;
  const pct = el.querySelector('.att-progress');
  const done = ratio >= 1;
  if (fill) fill.style.width = Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
  if (bar) bar.classList.toggle('hidden', done);
  if (pct) {
    pct.classList.toggle('hidden', done);
    if (!done) pct.textContent = (note || '传输中') + ' ' + Math.round(ratio * 100) + '%';
  }
}

/** 把解密后的 objectURL 铺到气泡里（换成播放器 / 图片 / 下载链接）。 */
function fillAttachment(el, meta, url) {
  if (!el) return;
  const media = el.querySelector('.att-media');
  if (!media) return;
  media.innerHTML = '';
  if (meta.kind === 'image') {
    const img = document.createElement('img');
    img.src = url;
    img.alt = meta.name;
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(url, '_blank'));
    media.appendChild(img);
  } else if (meta.kind === 'video') {
    const v = document.createElement('video');
    v.src = url;
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    media.appendChild(v);
  } else if (meta.kind === 'audio') {
    const a = document.createElement('audio');
    a.src = url;
    a.controls = true;
    a.preload = 'metadata';
    media.appendChild(a);
  } else {
    const a = document.createElement('a');
    a.className = 'att-download';
    a.href = url;
    a.download = meta.name;
    a.textContent = '下载 ' + meta.name;
    media.appendChild(a);
  }
  setProgress(el, 1);
}

/** 开始录音：麦克风 + MediaRecorder，录完走和附件完全相同的加密分块通路。 */
async function startVoice() {
  if (!app.binding.isBound || !app.sessionKey) {
    setStatus('还没绑定，发不了语音。', 'warn');
    return;
  }
  if (!app.link || !app.link.open) {
    setStatus('连接不在，发不了语音。点"重新连接"。', 'bad');
    return;
  }
  if (app.rec && app.rec.recording) return;
  app.rec = app.rec || new Recorder((ms) => {
    const t = $('rec-time');
    if (t) t.textContent = fmtDuration(ms);
  });
  try {
    await app.rec.start();
  } catch (e) {
    setStatus('开不了麦克风：' + e.message, 'bad');
    return;
  }
  $('rec-bar').classList.remove('hidden');
  $('btn-mic').classList.add('recording');
  $('rec-time').textContent = '0:00';
  $('btn-rec-send').disabled = false;
}

async function finishVoice(send) {
  if (!app.rec || !app.rec.recording) return;
  const rec = app.rec;
  $('btn-rec-send').disabled = true;
  let out = null;
  try {
    out = await rec.stop();
  } catch (e) {
    setStatus('录音失败：' + e.message, 'bad');
  } finally {
    $('rec-bar').classList.add('hidden');
    $('btn-mic').classList.remove('recording');
    $('btn-rec-send').disabled = false;
  }
  if (!send || !out) {
    if (out) log('已丢弃一段语音', fmtDuration(out.ms));
    return;
  }
  if (out.ms < 400 || out.blob.size === 0) {
    setStatus('太短了（不到半秒），再按一次试试。', 'warn');
    return;
  }
  const file = new File([out.blob], voiceName(new Date(), out.mime), { type: out.mime });
  await sendFile(file, { dur: out.ms, voice: true });
}

/** 自测：画一张带随机条纹的小图并当图片发出去（走的是和真实文件完全相同的 sendFile）。 */
async function sendTestImage() {
  const cv = document.createElement('canvas');
  cv.width = 480;
  cv.height = 300;
  const g = cv.getContext('2d');
  g.fillStyle = '#101827';
  g.fillRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = 'hsl(' + Math.floor(Math.random() * 360) + ',70%,55%)';
    g.fillRect(Math.random() * 480, Math.random() * 300, 40 + Math.random() * 60, 8);
  }
  g.fillStyle = '#e8eefc';
  g.font = '20px sans-serif';
  g.fillText('附件自测 ' + new Date().toLocaleTimeString(), 16, 280);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  await sendFile(new File([blob], 'attachment-test.png', { type: 'image/png' }));
}

/** 自测：合成一段 1 秒的 440Hz 声音（WAV），用来在没有真麦克风的环境里验证语音气泡。 */
async function sendTestVoice() {
  const rate = 8000;
  const n = rate * 1;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  put(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  put(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 400, (n - i) / 400);        // 首尾淡入淡出，避免爆音
    v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * fade * 32767, true);
  }
  const file = new File([buf], 'voice-test.wav', { type: 'audio/wav' });
  await sendFile(file, { dur: 1000, voice: true });
}

/** 自测：造一个指定大小的二进制文件，用来验证多块传输与背压。 */
async function sendTestBlob(bytes) {
  const buf = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65536) {
    buf.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, bytes - i))), i);
  }
  await sendFile(new File([buf], 'blob-test.bin', { type: 'application/octet-stream' }));
}

/** 发送一个 File/Blob：先发加密的元数据，再逐块发密文（背压见 transport.drain）。 */
async function sendFile(file, extra) {
  if (!file) return;
  if (!app.binding.isBound || !app.sessionKey) {
    setStatus('还没绑定，发不了附件。', 'warn');
    return;
  }
  if (!app.link || !app.link.open) {
    setStatus('连接不在，发不了附件。点"重新连接"。', 'bad');
    return;
  }
  if (file.size === 0) {
    setStatus('空文件，没有可发的内容。', 'warn');
    return;
  }
  if (file.size > F.MAX_BYTES) {
    setStatus('文件太大：' + F.prettySize(file.size) + '，上限 ' + F.prettySize(F.MAX_BYTES) + '。', 'bad');
    return;
  }

  const id = F.newFileId();
  const ts = Date.now();
  const meta = {
    name: file.name || 'file',
    mime: file.type || '',
    size: file.size,
    chunks: F.chunkCount(file.size),
    chunk: F.CHUNK,
    kind: F.kindOf(file.type, file.name),
  };
  if (extra) Object.assign(meta, extra);
  const body = await C.seal(app.sessionKey, { file: meta });
  if (!app.link.send({ t: 'msg', id, ts, body })) {
    setStatus('发送失败：连接不在。', 'bad');
    return;
  }

  const msg = { id, ts, from: 'me', body, att: meta };
  await persistMessage(msg);
  const el = appendAttachment(msg, meta);
  app.outgoing.set(id, { el, meta });

  // 自己这边直接拿明文做预览（不落库）；库里只存密文帧。
  const localUrl = URL.createObjectURL(file);
  app.urls.set(id, localUrl);
  fillAttachment(el, meta, localUrl);

  const frames = [];
  try {
    for (let i = 0; i < meta.chunks; i++) {
      const start = i * F.CHUNK;
      const bytes = new Uint8Array(await file.slice(start, start + F.CHUNK).arrayBuffer());
      const { iv, ct } = await F.sealChunk(app.sessionKey, bytes);
      const frame = F.packFrame(id, i, iv, ct);
      frames.push(new Uint8Array(frame));
      await app.link.drain();                      // 别把几百 MB 一次灌进 SCTP 缓冲
      if (!app.link.sendBinary(frame)) throw new Error('连接已断开');
      setProgress(el, (i + 1) / meta.chunks);
    }
    await S.put('files', id, new Blob(frames, { type: 'application/octet-stream' }));
    setProgress(el, 1);
    log('附件已发出', meta.name, F.prettySize(meta.size), meta.chunks + ' 块');
  } catch (e) {
    setStatus('附件发送中断：' + e.message + '（对方会看到"未传完"）', 'bad');
    const pct = el.querySelector('.att-progress');
    if (pct) {
      pct.classList.remove('hidden');
      pct.textContent = '没传完';
    }
  } finally {
    app.outgoing.delete(id);
  }
}

/** 收到一块附件密文。 */
async function onBinary(buf) {
  if (!app.sessionKey) return;
  const { id, index } = F.parseFrameHead(buf);
  const pend = app.incoming.get(id);
  if (!pend) {
    log('收到未知附件的块，丢弃', id, index);
    return;
  }
  if (index >= pend.meta.chunks) return;
  pend.parts[index] = new Uint8Array(buf);
  pend.got++;
  setProgress(pend.el, pend.got / pend.meta.chunks, '接收中');
  if (pend.got >= pend.meta.chunks) await finishIncoming(id);
}

async function finishIncoming(id) {
  const pend = app.incoming.get(id);
  if (!pend) return;
  app.incoming.delete(id);
  const { meta, parts, el, msg } = pend;
  const frames = [];
  for (let i = 0; i < meta.chunks; i++) {
    if (!parts[i]) {
      setStatus('附件不完整（缺第 ' + (i + 1) + ' 块），已放弃。', 'warn');
      return;
    }
    frames.push(parts[i]);
  }
  try {
    const cipher = new Blob(frames, { type: 'application/octet-stream' });
    await S.put('files', id, cipher);            // 库里存密文
    const plain = await F.decryptStream(app.sessionKey, cipher, meta);
    const url = URL.createObjectURL(plain);
    app.urls.set(id, url);
    fillAttachment(el, meta, url);
    log('附件已收完', meta.name, F.prettySize(meta.size));
  } catch (e) {
    setStatus('附件解密失败：' + e.message, 'bad');
  }
}

/** 历史消息里的附件：从库里取密文，解密后挂 objectURL（同一 id 只解一次）。 */
async function hydrateAttachment(el, msg) {
  const meta = msg.att;
  let url = app.urls.get(msg.id);
  if (!url) {
    try {
      const cipher = await S.get('files', msg.id);
      if (!cipher) {
        const pct = el.querySelector('.att-progress');
        if (pct) {
          pct.classList.remove('hidden');
          pct.textContent = '本机没有这份附件（可能没传完）';
        }
        return;
      }
      const plain = await F.decryptStream(app.sessionKey, cipher, meta);
      url = URL.createObjectURL(plain);
      app.urls.set(msg.id, url);
    } catch (e) {
      log('附件解密失败', msg.id, e && e.message);
      return;
    }
  }
  fillAttachment(el, meta, url);
}

async function onFrame(frame) {
  if (frame.t === 'msg') {
    if (!app.sessionKey) return;
    try {
      const payload = await C.unseal(app.sessionKey, frame.body);
      if (payload.file) {
        // 附件：先登记待收状态，随后逐块到的二进制帧往这里填（见 onBinary）
        const meta = payload.file;
        const msg = { id: frame.id, ts: frame.ts, from: 'them', body: frame.body, att: meta };
        await persistMessage(msg);
        const el = appendAttachment(msg, meta);
        app.incoming.set(frame.id, { meta, parts: [], got: 0, el, msg });
        setProgress(el, 0, '接收中');
        maybeNotify({ file: { ...meta, kind: F.kindOf(meta.mime, meta.name) } });
        log('开始接收附件', meta.name, F.prettySize(meta.size), meta.chunks + ' 块');
        return;
      }
      const msg = { id: frame.id, ts: frame.ts, from: 'them', body: frame.body };
      await persistMessage(msg);
      appendBubble(msg, payload.text);
      maybeNotify({ text: payload.text });
    } catch {
      log('解密失败', frame.id);
    }
  } else if (frame.t === 'seen') {
    // 对方已读到我这条消息（水位只增不减）
    app.peerSeenTs = R.bumpSeen(app.peerSeenTs, frame.ts);
    await S.put('meta', 'peerSeenTs', app.peerSeenTs);
    refreshReceipts();
  } else if (frame.t === 'pref') {
    // 对方的开关：双签要两边都开才生效
    app.peerPrefs = { read: !!frame.read, dnd: !!frame.dnd, notify: frame.notify !== false };
    await S.put('meta', 'peerPrefs', app.peerPrefs);
    renderOpts();
    refreshReceipts();
    sendSeenSoon();
  } else if (frame.t === 'unbind-request') {
    await peerUnbound();
  } else if (frame.t === 'unbind-accept' || frame.t === 'unbind-refuse' || frame.t === 'unbind-confirm') {
    // 旧版（双签解除）的帧：现在单方即可解除，收到即忽略，避免旧客户端把流程卡住。
    log('忽略旧版解除帧', frame.t);
  } else if (frame.t === 'error') {
    setStatus('对端拒绝：' + frame.reason, 'bad');
  }
}

/* ---------------- 解除绑定（单方即可，不需要对方同意） ---------------- */

function requestUnbind() {
  if (!app.binding.isBound) return;
  showTab('chat');
  $('unbind-ask-text').textContent =
    '确认解除关系？对方会被立即断开，双方本机历史都会被删除。这一步不需要对方同意。';
  $('btn-unbind-yes').textContent = '确认解除';
  $('btn-unbind-no').textContent = '取消';
  $('unbind-ask').dataset.mode = 'local';
  $('unbind-ask').classList.remove('hidden');
}

async function answerUnbind(agree) {
  const mode = $('unbind-ask').dataset.mode;
  $('unbind-ask').classList.add('hidden');
  if (mode !== 'local') return;
  if (!agree) {
    setStatus('没有解除，关系保持。', 'warn');
    return;
  }
  // 顺序很重要：趁链路还在先把通知发出去，再清本机状态
  if (app.link && app.link.open) {
    try {
      app.link.send({ t: 'unbind-request', n: C.randomId(8) });
    } catch (e) {
      log('解除通知发送失败', e);
    }
  }
  await wipe('关系已解除。对方那台机器上的这段记录也已清空。');
}

/** 收到对方"我已解除"的通知：本机无条件同步清空（对方单方决定即可生效）。 */
async function peerUnbound() {
  await wipe('对方已解除关系，本机记录已清空。');
}

async function wipe(message) {
  app.quietClose = true;          // 主动断开，别报"意外掉线"
  app.binding.unbindNow();
  await S.del('peer', 'current');
  await S.clearStore('messages');
  await S.clearStore('files');
  for (const url of app.urls.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
  app.urls.clear();
  app.incoming.clear();
  app.outgoing.clear();
  app.sessionKey = null;
  app.peerPrefs = null;
  app.peerSeenTs = 0;
  app.seenSentTs = 0;
  app.mineRows = [];
  app.lastTheirsTs = 0;
  await S.del('meta', 'peerPrefs');
  await S.del('meta', 'peerSeenTs');
  $('unbind-ask').classList.add('hidden');
  teardownLink();
  renderUnbound();
  setStatus(message, 'ok');
}

/* ---------------- 扫码 ---------------- */

async function startScan() {
  // 两条识别路径：Chrome 系有 BarcodeDetector 就直接用；其余（Android WebView、Firefox、Safari）
  // 退回 vendor/jsQR.js 在 canvas 上解码。
  const hasNative = 'BarcodeDetector' in window && typeof BarcodeDetector === 'function';
  const hasJsQr = typeof window.jsQR === 'function';
  if (!hasNative && !hasJsQr) {
    setStatus('这个环境没有二维码识别能力，请用下面的"粘贴对方的码"。', 'warn');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    setStatus('拿不到摄像头：' + (e && e.message ? e.message : e) + '（可改用"粘贴对方的码"）', 'bad');
    return;
  }
  const detector = hasNative ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const video = $('scan-video');
  video.srcObject = stream;
  await video.play();
  $('scan-box').classList.remove('hidden');
  app.scanning = { stream, timer: null };

  const grabCode = async () => {
    if (detector) {
      const codes = await detector.detect(video);
      return codes.length > 0 ? codes[0].rawValue : null;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 480 / w); // 控制在 480 宽以内，解码够快
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const res = window.jsQR(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
    return res && res.data ? res.data : null;
  };

  const tick = async () => {
    if (!app.scanning) return;
    try {
      const text = await grabCode();
      if (text) {
        stopScan();
        await handleScanned(text);
        return;
      }
    } catch (e) {
      log('detect error', e && e.message ? e.message : e);
    }
    app.scanning.timer = setTimeout(tick, 300);
  };
  tick();
}

function stopScan() {
  if (!app.scanning) return;
  clearTimeout(app.scanning.timer);
  app.scanning.stream.getTracks().forEach((t) => t.stop());
  app.scanning = null;
  $('scan-box').classList.add('hidden');
}

async function handleScanned(text) {
  try {
    const payload = decodePayload(text);
    if (payload.k === 'offer') await acceptOffer(text);
    else await acceptAnswer(text);
  } catch (e) {
    setStatus('扫码失败：' + e.message, 'bad');
  }
}

/* ---------------- 其它 ---------------- */

function teardownLink() {
  if (app.link) {
    app.link.close();
    app.link = null;
  }
  stopScan();
}

/** 处理输入框里的码：offer → 产出回复码；answer → 建立链路。按钮与自测入口共用。 */
async function acceptCodeFromInput() {
  const text = $('code-in').value.trim();
  if (!text) {
    setStatus('先粘贴对方的码', 'warn');
    return;
  }
  let payload;
  try {
    payload = decodePayload(text);              // 先解一次，为了知道是 offer 还是 answer
  } catch (e) {
    const t = String(text || '').replace(/\s+/g, '');
    // 最常见的误用：把 22 个字符的身份指纹当成配对码贴进来。它不是码，是公钥哈希。
    if (t.length > 0 && t.length < 120) {
      throw new Error('这不是配对码。配对码是 700 多字符的长串（内含握手信息与签名）；' +
        '那串 22 个字符只是身份指纹，用来核对"是不是同一个人"，不能拿来建立连接。');
    }
    throw e;
  }
  if (payload.k === 'offer') await acceptOffer(text);
  else await acceptAnswer(text);
  $('code-in').value = '';
}

function wire() {
  $('btn-invite').addEventListener('click', () => startPairing().catch((e) => { hidePairStep(); setStatus(e.message, 'bad'); }));
  $('btn-scan').addEventListener('click', () => startScan().catch((e) => setStatus('摄像头打不开：' + e.message, 'bad')));
  $('btn-stop-scan').addEventListener('click', stopScan);
  $('btn-accept-code').addEventListener('click', () => acceptCodeFromInput().catch((e) => setStatus(e.message, 'bad')));
  $('btn-send').addEventListener('click', () => sendMessage());
  // 自测入口：只在地址带 #dev 时出现，用来在没有文件对话框的环境里验证图片/大文件通路
  if (location.hash === '#dev') {
    $('dev-row').classList.remove('hidden');
    $('dev-img').addEventListener('click', () => sendTestImage());
    $('dev-big').addEventListener('click', () => sendTestBlob(1.2 * 1024 * 1024));
    $('dev-voice').addEventListener('click', () => sendTestVoice());
    $('dev-get-offer').addEventListener('click', async () => {
      try {
        $('code-in').value = await devFetch('offer');
        await acceptCodeFromInput();
      } catch (e) {
        setStatus('自测取 offer 失败：' + e.message, 'bad');
      }
    });
    $('dev-get-answer').addEventListener('click', async () => {
      try {
        $('code-in').value = await devFetch('answer');
        await acceptCodeFromInput();
      } catch (e) {
        setStatus('自测取 answer 失败：' + e.message, 'bad');
      }
    });
  }
  // 自测：把"已读上报"这一步单独触发一次（多标签页环境里后台标签的 visibilityState 是 hidden，
  // 真机上是"切到别的窗口"，这里用按钮模拟"对方此刻正在看"）
  if (location.hash === '#dev') {
    $('dev-seen').addEventListener('click', () => {
      app.seenSentTs = 0;
      flushSeen(true);
      setStatus('已把「已读」上报给对方（水位 ts=' + app.lastTheirsTs + '）', 'ok');
    });
  }
  $('btn-mic').addEventListener('click', () => {
    if (app.rec && app.rec.recording) finishVoice(true);
    else startVoice();
  });
  $('btn-rec-send').addEventListener('click', () => finishVoice(true));
  $('btn-rec-cancel').addEventListener('click', () => finishVoice(false));
  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';                       // 同一个文件还能再选一次
    for (const f of files) await sendFile(f);
  });
  // 粘贴：截图直接 Ctrl+V 就发出去（图片、也从资源管理器复制的文件）
  window.addEventListener('paste', async (e) => {
    if (!app.binding.isBound) return;
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) await sendFile(f);
  });
  // 拖放：把文件拖进聊天区
  const dropZone = $('panel-chat');
  dropZone.addEventListener('dragover', (e) => {
    if (!app.binding.isBound) return;
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', async (e) => {
    dropZone.classList.remove('dragging');
    if (!app.binding.isBound) return;
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    for (const f of files) await sendFile(f);
  });
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $('opt-read').addEventListener('change', async (e) => {
    app.prefs.read = e.target.checked;
    await savePrefs();
    setStatus(e.target.checked ? '已读回执：你已开启；对方也开启后才生效。' : '已读回执：你已关闭。', 'warn');
  });
  $('opt-dnd').addEventListener('change', async (e) => {
    app.prefs.dnd = e.target.checked;
    await savePrefs();
    setStatus(e.target.checked ? '免打扰已开：页面在后台时不再弹通知，消息照收。' : '免打扰已关：后台会弹通知。', 'warn');
  });
  $('opt-notify').addEventListener('change', async (e) => {
    app.prefs.notify = e.target.checked;
    if (app.prefs.notify && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (e2) { log('请求通知权限失败', e2 && e2.message); }
    }
    await savePrefs();
  });
  // 切回页面/窗口获得焦点：这时候才算"看到了"，补报一次已读
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sendSeenSoon();
  });
  window.addEventListener('focus', () => sendSeenSoon());
  $('btn-unbind').addEventListener('click', requestUnbind);
  $('btn-unbind-yes').addEventListener('click', () => answerUnbind(true));
  $('btn-unbind-no').addEventListener('click', () => answerUnbind(false));
  $('btn-reconnect').addEventListener('click', () => startPairing({ reconnect: true }).catch((e) => setStatus(e.message, 'bad')));
  for (const t of ['pair', 'chat', 'about']) {
    $('tab-' + t).addEventListener('click', () => showTab(t));
  }
}

(async function main() {
  wire();
  await bootIdentity();
  await loadPeer();
  await loadPrefs();
  if (!app.binding.isBound) renderUnbound();
  log('ready', app.fp);
})().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin', '<pre class="fatal">启动失败：' + e.message + '</pre>');
});
