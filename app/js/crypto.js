// crypto.js — 所有密码学原语的唯一入口。
// 设计原则：只依赖 WebCrypto（浏览器内置），不引入第三方加密库，便于审计与替换。

const text = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (s) => text.encode(s);
export const unutf8 = (b) => decoder.decode(b);

export const b64u = {
  enc(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

/** 生成设备身份：签名密钥（证明"我是我"）+ 协商密钥（派生会话密钥）。 */
export async function generateIdentity() {
  const signKeys = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const dhKeys = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  // 同时挂上 raw 公钥：让 generateIdentity / importIdentity 返回同样的形状，
  // 调用方不必判断"这个 identity 有没有 raw 字段"。
  return {
    signKeys,
    dhKeys,
    signPublicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', signKeys.publicKey)),
    dhPublicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', dhKeys.publicKey)),
  };
}

export async function exportIdentity(identity) {
  return {
    signPrivate: await crypto.subtle.exportKey('jwk', identity.signKeys.privateKey),
    dhPrivate: await crypto.subtle.exportKey('jwk', identity.dhKeys.privateKey),
    signPublic: await crypto.subtle.exportKey('raw', identity.signKeys.publicKey),
    dhPublic: await crypto.subtle.exportKey('raw', identity.dhKeys.publicKey),
  };
}

export async function importIdentity(stored) {
  const signPrivate = await crypto.subtle.importKey('jwk', stored.signPrivate, ECDSA, true, ['sign']);
  const dhPrivate = await crypto.subtle.importKey('jwk', stored.dhPrivate, ECDH, true, ['deriveBits']);
  // publicKey 从私钥 JWK 派生（JWK 里带 x/y）
  const signPublic = await crypto.subtle.importKey('jwk', { kty: stored.signPrivate.kty, crv: stored.signPrivate.crv, x: stored.signPrivate.x, y: stored.signPrivate.y }, ECDSA, true, ['verify']);
  const dhPublic = await crypto.subtle.importKey('jwk', { kty: stored.dhPrivate.kty, crv: stored.dhPrivate.crv, x: stored.dhPrivate.x, y: stored.dhPrivate.y }, ECDH, true, []);
  return {
    signKeys: { privateKey: signPrivate, publicKey: signPublic },
    dhKeys: { privateKey: dhPrivate, publicKey: dhPublic },
    signPublicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', signPublic)),
    dhPublicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', dhPublic)),
  };
}

/** 设备指纹：公钥的 SHA-256 前 128 位，用 base32 风格短串展示（人眼比对用）。 */
export async function fingerprint(rawPublicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublicKey));
  return b64u.enc(digest).slice(0, 22);
}

export async function signBytes(identity, bytes) {
  return new Uint8Array(await crypto.subtle.sign(ECDSA_SIGN, identity.signKeys.privateKey, bytes));
}

export async function verifyBytes(peerSignPubRaw, signature, bytes) {
  const key = await crypto.subtle.importKey('raw', peerSignPubRaw, ECDSA, false, ['verify']);
  return crypto.subtle.verify(ECDSA_SIGN, key, signature, bytes);
}

/** ECDH → HKDF-SHA256 → AES-256-GCM 会话密钥。salt 由双方指纹排序拼接，保证两端一致。 */
export async function deriveSessionKey(identity, peerDhPubRaw, saltBytes) {
  const peerKey = await crypto.subtle.importKey('raw', peerDhPubRaw, ECDH, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, identity.dhKeys.privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: text.encode('couple-chat/v1/session') },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, text.encode(JSON.stringify(obj)));
  return { iv: b64u.enc(iv), ct: b64u.enc(cipher) };
}

export async function unseal(key, sealed) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64u.dec(sealed.iv) },
    key,
    b64u.dec(sealed.ct),
  );
  return JSON.parse(decoder.decode(plain));
}

export function randomId(bytes = 8) {
  return b64u.enc(crypto.getRandomValues(new Uint8Array(bytes)));
}
