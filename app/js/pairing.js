// pairing.js — 二维码载荷的编解码与验签。
// 载荷 = {v,k,s(session),id, dh, n(nonce), sig}，签名覆盖前面全部字段。

import { b64u, utf8, fingerprint, signBytes, verifyBytes } from './crypto.js';

export const VERSION = 1;

function canonical(p) {
  // re（reply-to）只在回复码里出现：它指回"这条回复是给哪个邀请生成的"，
  // 参与签名，且是否存在的规则只看载荷本身，所以签名双方总能算出同一串。
  const obj = { v: p.v, k: p.k, s: p.s, id: p.id, dh: p.dh, n: p.n };
  if (p.re) obj.re = p.re;
  return utf8(JSON.stringify(obj));
}

/**
 * 生成一个配对载荷。
 * @param {'offer'|'answer'} kind
 * @param {object} session transport.packSession() 的结果
 */
export async function makePayload(kind, session, identity, opts) {
  const payload = {
    v: VERSION,
    k: kind,
    s: session,
    id: b64u.enc(identity.signPublicRaw),
    dh: b64u.enc(identity.dhPublicRaw),
    n: b64u.enc(crypto.getRandomValues(new Uint8Array(8))),
  };
  if (opts && opts.replyTo) payload.re = opts.replyTo;   // 回答码：指回对应邀请码的 n

  payload.sig = b64u.enc(await signBytes(identity, canonical(payload)));
  return payload;
}

/** 编码成二维码里放的字符串（紧凑 JSON + base64url，避免 URL 转义膨胀）。 */
export function encodePayload(payload) {
  return b64u.enc(utf8(JSON.stringify(payload)));
}

export function decodePayload(str) {
  // 二维码/聊天软件会把长串折行，粘贴进来常带换行或空格；base64url 本身不含空白，先全部去掉。
  const text = String(str).replace(/\s+/g, '');
  if (!text) throw new Error('码是空的');
  const raw = JSON.parse(new TextDecoder().decode(b64u.dec(text)));
  if (raw.v !== VERSION) throw new Error(`协议版本不支持：${raw.v}`);
  if (raw.k !== 'offer' && raw.k !== 'answer') throw new Error('载荷类型错误');
  if (!raw.s || !raw.id || !raw.dh || !raw.sig) throw new Error('载荷不完整');
  return raw;
}

/** 验签 + 返回可信的对端公钥。任何一步失败都抛错（宁可拒绝，不做"尽力而为"）。 */
export async function verifyPayload(payload) {
  const signPub = b64u.dec(payload.id);
  const ok = await verifyBytes(signPub, b64u.dec(payload.sig), canonical(payload));
  if (!ok) throw new Error('载荷签名校验失败（可能被篡改）');
  return {
    signPublicRaw: signPub,
    dhPublicRaw: b64u.dec(payload.dh),
    fingerprint: await fingerprint(signPub),
    nonce: payload.n,
    session: payload.s,
  };
}
