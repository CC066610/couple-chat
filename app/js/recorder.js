// recorder.js — 语音消息的录制（MediaRecorder 包装 + 几个可单测的纯函数）。
//
// 单独一层的目的：ui.js 只关心"开始/结束/取消"，MIME 协商、计时、文件名这些
// 容易出错的细节放这里，好测也好换（比如以后改成固定码率或转码）。

/** 各浏览器支持的容器不同：Chrome/Edge/WebView 给 webm+opus，Safari 只给 mp4。按优先级挑。 */
export const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export function pickMime(isSupported) {
  for (const m of MIME_CANDIDATES) {
    try {
      if (isSupported(m)) return m;
    } catch {
      /* 某些实现对未知 MIME 会抛，忽略继续试 */
    }
  }
  return '';                 // 空串 = 让 MediaRecorder 自己选
}

export function extFor(mime) {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'm4a';
  return 'bin';
}

/** 毫秒 → m:ss（超过一小时才显示 h:mm:ss）。 */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 文件名带上时间，收件人下载后不至于一堆同名文件。 */
export function voiceName(date, mime) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `语音 ${stamp}.${extFor(mime)}`;
}

/** 录音器：start() 开始，stop() 拿到 {blob,mime,ms}，cancel() 直接丢弃。 */
export class Recorder {
  constructor(onTick) {
    this.onTick = onTick || (() => {});
    this._rec = null;
    this._stream = null;
    this._chunks = [];
    this._startedAt = 0;
    this._timer = null;
    this.mime = '';
  }

  get recording() {
    return this._rec !== null;
  }

  async start() {
    if (this.recording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('这个页面不是安全上下文（要用 http://127.0.0.1 或 https），浏览器不给麦克风');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('这个浏览器不支持 MediaRecorder，录不了音');
    }
    // 只要音频；关掉回声消除会让声音更"原声"，但语音消息通常更适合开着
    this._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
    const opts = this.mime ? { mimeType: this.mime } : {};
    this._rec = new MediaRecorder(this._stream, opts);
    if (!this.mime) this.mime = this._rec.mimeType || 'audio/webm';

    this._chunks = [];
    this._rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this._chunks.push(e.data);
    };
    this._rec.start(250);                     // 250ms 一个小片，停止时不必等太久
    this._startedAt = Date.now();
    this._timer = setInterval(() => this.onTick(Date.now() - this._startedAt), 200);
    this.onTick(0);
  }

  stop() {
    return new Promise((resolve, reject) => {
      const rec = this._rec;
      if (!rec) {
        reject(new Error('还没开始录'));
        return;
      }
      const ms = Date.now() - this._startedAt;
      rec.onstop = () => {
        const blob = new Blob(this._chunks, { type: this.mime });
        this._teardown();
        resolve({ blob, mime: this.mime, ms });
      };
      rec.onerror = (e) => {
        this._teardown();
        reject(new Error('录音出错：' + (e && e.error && e.error.name)));
      };
      try {
        rec.stop();
      } catch (e) {
        this._teardown();
        reject(e);
      }
    });
  }

  cancel() {
    if (!this._rec) return;
    this._chunks = [];
    try {
      this._rec.stop();
    } catch {
      /* 已经停了 */
    }
    this._teardown();
  }

  _teardown() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._stream) {
      for (const t of this._stream.getTracks()) t.stop();   // 必须关掉，否则浏览器一直显示话筒占用
      this._stream = null;
    }
    this._rec = null;
  }
}
