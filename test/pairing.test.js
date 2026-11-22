import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../app/js/crypto.js';
import { makePayload, encodePayload, decodePayload, verifyPayload } from '../app/js/pairing.js';

const session = { ufrag: 'uf', pwd: 'pw', fp: 'ff:00', setup: 'actpass', candidates: [['udp', '192.168.1.5', 54321, 'host']] };

test('payload 编码 → 解码 → 验签，返回对端公钥与指纹', async () => {
  const id = await C.generateIdentity();
  const payload = await makePayload('offer', session, id);
  const code = encodePayload(payload);
  const decoded = decodePayload(code);
  const info = await verifyPayload(decoded);
  const exp = await C.exportIdentity(id);
  assert.deepEqual(Array.from(info.signPublicRaw), Array.from(new Uint8Array(exp.signPublic)));
  assert.equal(info.fingerprint, await C.fingerprint(new Uint8Array(exp.signPublic)));
  assert.equal(info.session.ufrag, 'uf');
});

test('篡改任何字段都会被验签拒绝', async () => {
  const id = await C.generateIdentity();
  const payload = await makePayload('offer', session, id);
  const evil = JSON.parse(JSON.stringify(payload));
  evil.s.ufrag = 'HACK';
  await assert.rejects(() => verifyPayload(evil), /签名校验失败/);
});

test('类型/版本校验', async () => {
  const id = await C.generateIdentity();
  const payload = await makePayload('answer', session, id);
  const badKind = { ...payload, k: 'nope' };
  assert.throws(() => decodePayload(encodePayload(badKind)), /载荷类型错误/);
  const badVer = { ...payload, v: 99 };
  assert.throws(() => decodePayload(encodePayload(badVer)), /协议版本不支持/);
});

test('二维码字符串足够短（< 2000 字符，能进普通二维码）', async () => {
  const id = await C.generateIdentity();
  const many = { ...session, candidates: [['udp', '192.168.1.5', 54321, 'host'], ['udp', '192.168.1.6', 54322, 'host'], ['udp', '10.0.0.7', 54323, 'host']] };
  const code = encodePayload(await makePayload('offer', many, id));
  assert.ok(code.length < 2000, 'code length=' + code.length);
});

test('粘贴的码带换行 / 空格 / 制表符也能解码（聊天软件会折行）', async () => {
  const id = await C.generateIdentity();
  const code = encodePayload(await makePayload('offer', session, id));
  const wrapped = code.replace(/(.{40})/g, '$1\n\t');
  assert.equal(decodePayload(wrapped).k, 'offer');
  assert.equal(decodePayload(code).k, 'offer');
  assert.throws(() => decodePayload('   '), /码是空的/);
});


test('回复码带 re（指回邀请的 nonce）：验签通过，且篡改 re 会被拒', async () => {
  const a = await C.generateIdentity();
  const offer = await makePayload('offer', session, a);
  const b = await C.generateIdentity();
  const answer = await makePayload('answer', session, b, { replyTo: offer.n });

  assert.equal(answer.re, offer.n);
  const info = await verifyPayload(decodePayload(encodePayload(answer)));
  assert.equal(info.fingerprint, await C.fingerprint(b.signPublicRaw));

  // 把 re 换成别的 nonce（模拟"旧回复码糊到新邀请上"），签名必须对不上
  const forged = { ...answer, re: offer.n.slice(0, -2) + 'AA' };
  await assert.rejects(() => verifyPayload(forged));
});

test('没有 re 的旧版回复码仍然可用（向后兼容）', async () => {
  const b = await C.generateIdentity();
  const legacy = await makePayload('answer', session, b);      // 不带 opts
  assert.equal('re' in legacy, false);
  const info = await verifyPayload(decodePayload(encodePayload(legacy)));
  assert.ok(info.session.sdp || info.session.ufrag);
});
