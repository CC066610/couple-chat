// 已读回执 / 通知 的纯逻辑（不碰 DOM、不碰网络，方便单测）。
//
// 设计约定：
//   · 已读回执是"双签功能"：只有双方都把开关打开才生效（对方关掉，你这边也不再显示已读）。
//   · 已读只标在"最新一条我方消息"上，旧消息上的标记会被清掉（不堆一屏的"已读"）。
//   · 免打扰只影响通知，不影响消息收投；它是个人的开关，与已读回执互不干扰。

export const DEFAULT_PREFS = Object.freeze({ read: false, dnd: false, notify: true });

/** 已读回执是否生效：双方都开启才算。 */
export function readOn(mine, peer) {
  return Boolean(mine && mine.read) && Boolean(peer && peer.read);
}

/** 免打扰是否生效（只看本机）。 */
export function dndOn(mine) {
  return Boolean(mine && mine.dnd);
}

/** 通知是否应当弹出：页面在前台就不弹（人正看着）；免打扰不弹；没授权不弹。 */
export function shouldNotify({ visibility, prefs, permission }) {
  if (visibility === 'visible') return false;
  if (dndOn(prefs)) return false;
  if (!prefs || prefs.notify === false) return false;
  return permission === 'granted';
}

/** 通知正文：文本给前 60 字，附件给类型 + 文件名。 */
export function notifyBody(what) {
  if (!what) return '新消息';
  if (what.text) {
    const t = String(what.text).replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 60) + '…' : t;
  }
  if (what.file) {
    const kind = what.file.voice ? '语音' : what.file.kind === 'image' ? '图片' : what.file.kind === 'video' ? '视频' : '文件';
    return kind + '：' + (what.file.name || '');
  }
  return '新消息';
}

/** 只在最新一条我方消息上显示状态；返回 '' 表示不显示。 */
export function labelFor({ readOn: on, isLatest, peerSeenTs, ts }) {
  if (!on || !isLatest) return '';
  if (peerSeenTs && ts && peerSeenTs >= ts) return '已读';
  return '已送达';
}

/** 取时间戳最大的那条（用于定位"最新一条我方消息"）。 */
export function latest(rows, from) {
  let best = null;
  for (const r of rows) {
    if (from && r.from !== from) continue;
    if (!best || (r.ts || 0) > (best.ts || 0)) best = r;
  }
  return best;
}

/** 已读水位只增不减（乱序/重复的 seen 帧不会把"已读"退回"已送达"）。 */
export function bumpSeen(current, incoming) {
  const a = Number(current) || 0;
  const b = Number(incoming) || 0;
  return Math.max(a, b);
}

/** 双签状态给用户看的一句话。 */
export function receiptStatusText(mine, peer) {
  const m = Boolean(mine && mine.read);
  const p = Boolean(peer && peer.read);
  if (m && p) return '已读回执：双方都已开启，生效中';
  if (m && !p) return '已读回执：你已开启，等对方也开启才生效';
  if (!m && p) return '已读回执：对方已开启，你开启后才生效';
  return '已读回执：双方都未开启';
}
