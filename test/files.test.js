// test/files.test.js — 附件分块 / 帧格式 / 逐块加解密 / 类型判定
//
// 只测纯数据变换（files.js 不碰 WebRTC、不碰 DOM），所以能在 Node 里直接跑。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as C from '../app/js/crypto.js';
import * as F from '../app/js/files.js';

const newKey = async () => {
  const id = await C.generateIdentity();
  return C.deriveSessionKey(id, id.dhPublicRaw, new Uint8Array(16));
};

test('块数：空文件也按 1 块处理，整块边界不多算一块', () => {
  assert.equal(F.chunkCount(0), 1);
  assert.equal(F.chunkCount(1), 1);
  assert.equal(F.chunkCount(F.CHUNK), 1);
  assert.equal(F.chunkCount(F.CHUNK + 1), 2);
  assert.equal(F.chunkCount(F.CHUNK * 3), 3);
  assert.equal(F.chunkCount(F.CHUNK * 3 + 7), 4);
});

test('块长度：只有最后一块可能短，其余都是 CHUNK', () => {
  const size = F.CHUNK * 2 + 10;
  assert.equal(F.chunkLen(size, 0), F.CHUNK);
  assert.equal(F.chunkLen(size, 1), F.CHUNK);
  assert.equal(F.chunkLen(size, 2), 10);
  assert.equal(F.chunkLen(size, 3), 0);
  // 各块长度加起来正好等于文件长度
  let sum = 0;
  for (let i = 0; i < F.chunkCount(size); i++) sum += F.chunkLen(size, i);
  assert.equal(sum, size);
});

test('帧长度：= 头 + IV + 明文块 + tag', () => {
  const size = F.CHUNK + 5;
  assert.equal(F.frameLen(size, 0), F.HEADER + F.IV + F.CHUNK + F.TAG);
  assert.equal(F.frameLen(size, 1), F.HEADER + F.IV + 5 + F.TAG);
});

test('文件 id：16 个 base64url 字符，正好填满帧头 id 区，且不重复', () => {
  const a = F.newFileId();
  const b = F.newFileId();
  assert.equal(a.length, 16);
  assert.match(a, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(a, b);
});

test('帧头往返：id 与块序号能原样取回', async () => {
  const key = await newKey();
  const id = F.newFileId();
  const plain = new Uint8Array([1, 2, 3, 4]);
  const { iv, ct } = await F.sealChunk(key, plain);
  const frame = F.packFrame(id, 7, iv, ct);

  const head = F.parseFrameHead(frame);
  assert.equal(head.id, id);
  assert.equal(head.index, 7);
  assert.equal(frame.byteLength, F.HEADER + F.IV + plain.length + F.TAG);
});

test('单块加解密往返；密文被改动一个字节就解不开', async () => {
  const key = await newKey();
  const plain = crypto.getRandomValues(new Uint8Array(1000));
  const { iv, ct } = await F.sealChunk(key, plain);
  const back = await F.openChunk(key, iv, ct);
  assert.deepEqual(Array.from(back), Array.from(plain));

  const tampered = new Uint8Array(ct);
  tampered[10] ^= 0x01;
  await assert.rejects(() => F.openChunk(key, iv, tampered));
});

test('拿错密钥解不开（每块都是独立密钥流，换 key 必失败）', async () => {
  const k1 = await newKey();
  const k2 = await newKey();
  const { iv, ct } = await F.sealChunk(k1, new Uint8Array(64));
  await assert.rejects(() => F.openChunk(k2, iv, ct));
});

test('decryptStream：多块密文拼成的 Blob 能还原成原文（含最后一块不整）', async () => {
  const key = await newKey();
  const size = F.CHUNK * 2 + 1234;
  // getRandomValues 一次最多 65536 字节，所以按块填
  const plain = new Uint8Array(size);
  for (let i = 0; i < F.chunkCount(size); i++) {
    const start = i * F.CHUNK;
    plain.set(crypto.getRandomValues(new Uint8Array(F.chunkLen(size, i))), start);
  }

  const frames = [];
  for (let i = 0; i < F.chunkCount(size); i++) {
    const start = i * F.CHUNK;
    const piece = plain.subarray(start, start + F.chunkLen(size, i));
    const { iv, ct } = await F.sealChunk(key, piece);
    frames.push(new Uint8Array(F.packFrame(F.newFileId(), i, iv, ct)));
  }
  const meta = { size, mime: 'application/octet-stream' };
  const plainBlob = await F.decryptStream(key, new Blob(frames), meta);

  assert.equal(plainBlob.size, size);
  const back = new Uint8Array(await plainBlob.arrayBuffer());
  assert.deepEqual(Array.from(back), Array.from(plain));
});

test('decryptStream：密文被截断时报错，而不是静默返回半份内容', async () => {
  const key = await newKey();
  const size = F.CHUNK + 100;
  const frames = [];
  for (let i = 0; i < F.chunkCount(size); i++) {
    const { iv, ct } = await F.sealChunk(key, new Uint8Array(F.chunkLen(size, i)));
    frames.push(new Uint8Array(F.packFrame(F.newFileId(), i, iv, ct)));
  }
  const good = new Blob(frames);
  const cut = good.slice(0, good.size - 40);            // 砍掉尾巴
  await assert.rejects(() => F.decryptStream(key, cut, { size }), /密文长度不符/);
});

test('渲染类型：优先 MIME，其次扩展名（Windows 上 MIME 常为空）', () => {
  assert.equal(F.kindOf('image/png', 'a.bin'), 'image');
  assert.equal(F.kindOf('video/mp4', 'a'), 'video');
  assert.equal(F.kindOf('audio/mpeg', 'a'), 'audio');
  assert.equal(F.kindOf('', 'photo.JPG'), 'image');
  assert.equal(F.kindOf('', 'clip.mov'), 'video');
  assert.equal(F.kindOf('', 'song.m4a'), 'audio');
  assert.equal(F.kindOf('', 'notes.txt'), 'file');
  assert.equal(F.kindOf('application/pdf', 'x.pdf'), 'file');
  assert.equal(F.kindOf('', ''), 'file');
});

test('体积文案', () => {
  assert.equal(F.prettySize(0), '0 B');
  assert.equal(F.prettySize(999), '999 B');
  assert.equal(F.prettySize(2048), '2.0 KB');
  assert.equal(F.prettySize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(F.prettySize(-1), '?');
});
