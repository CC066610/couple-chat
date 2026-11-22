import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../app/js/crypto.js';

test('身份导出/导入后指纹不变', async () => {
  const id = await C.generateIdentity();
  const exported = await C.exportIdentity(id);
  const restored = await C.importIdentity(exported);
  const a = await C.fingerprint(id.signKeys.publicKey ? new Uint8Array(await crypto.subtle.exportKey('raw', id.signKeys.publicKey)) : id.signPublicRaw);
  const b = await C.fingerprint(restored.signPublicRaw);
  assert.equal(a, b);
  assert.equal(a.length, 22);
});

test('签名可验证，改动一个字节就失败', async () => {
  const id = await C.generateIdentity();
  const exported = await C.exportIdentity(id);
  const sig = await C.signBytes(id, C.utf8('hello'));
  assert.equal(await C.verifyBytes(exported.signPublic, sig, C.utf8('hello')), true);
  assert.equal(await C.verifyBytes(exported.signPublic, sig, C.utf8('hellp')), false);
});

test('双方 ECDH 派生出同一把会话密钥，能互相解密', async () => {
  const a = await C.generateIdentity();
  const b = await C.generateIdentity();
  const aExp = await C.exportIdentity(a);
  const bExp = await C.exportIdentity(b);
  const salt = C.utf8('salt|for|test');
  const keyA = await C.deriveSessionKey(a, bExp.dhPublic, salt);
  const keyB = await C.deriveSessionKey(b, aExp.dhPublic, salt);
  const sealed = await C.seal(keyA, { text: '晚安' });
  const opened = await C.unseal(keyB, sealed);
  assert.equal(opened.text, '晚安');
});

test('换一个 salt 就解不开（防不同会话混用）', async () => {
  const a = await C.generateIdentity();
  const b = await C.generateIdentity();
  const bExp = await C.exportIdentity(b);
  const k1 = await C.deriveSessionKey(a, bExp.dhPublic, C.utf8('salt-1'));
  const k2 = await C.deriveSessionKey(a, bExp.dhPublic, C.utf8('salt-2'));
  const sealed = await C.seal(k1, { text: 'x' });
  await assert.rejects(() => C.unseal(k2, sealed));
});

test('base64url 往返（含二进制）', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  const round = C.b64u.dec(C.b64u.enc(bytes));
  assert.deepEqual(Array.from(round), Array.from(bytes));
  assert.ok(!C.b64u.enc(bytes).match(/[+/=]/));
});
