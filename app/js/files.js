// files.js — 附件（图片 / 视频 / 任意文件）的分块与逐块加解密原语。
//
// 只做纯数据变换：不碰 WebRTC、不碰 DOM，因此可以在 Node 里单测（test/files.test.js）。
//
// 线格式（每块一个二进制帧）：
//   [0,16)   文件 id，ASCII，不足 16 字节用 0 补齐（base64url 的 12 字节 id 恰好 16 字符）
//   [16,20)  块序号，大端 uint32
//   [20,32)  AES-GCM IV（每块独立随机）
//   [32, …)  密文（明文块 + 16 字节 GCM tag）
//
// 为什么要逐块加密而不是整文件加密：视频动辄几十 MB，整文件加密要么吃内存要么要流式
// AES-GCM（WebCrypto 没有），逐块加密还能边传边解、坏一块不至于整份报废。

import * as C from './crypto.js';

export const CHUNK = 32 * 1024;              // 每块明文长度
export const HEADER = 20;                    // id(16) + 序号(4)
export const IV = 12;
export const TAG = 16;
export const MAX_BYTES = 300 * 1024 * 1024;  // 单文件上限：300 MB（内存与 IndexedDB 的折中）

/** 16 个 base64url 字符 = 12 字节随机，正好填满帧头的 id 区。 */
export function newFileId() {
  return C.randomId(12);
}

export function chunkCount(size) {
  return Math.max(1, Math.ceil(size / CHUNK));
}

/** 第 index 块的明文长度（最后一块可能更短）。 */
export function chunkLen(size, index) {
  const start = index * CHUNK;
  return Math.max(0, Math.min(CHUNK, size - start));
}

/** 第 index 块整帧长度——接收方预先知道，才能从拼接后的密文里切回各块。 */
export function frameLen(size, index) {
  return HEADER + IV + chunkLen(size, index) + TAG;
}

export function packFrame(id, index, iv, ct) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 16) throw new Error('文件 id 长度必须是 1..16 个字符');
  const buf = new Uint8Array(HEADER + iv.length + ct.length);
  for (let i = 0; i < id.length; i++) buf[i] = id.charCodeAt(i) & 0x7f;
  new DataView(buf.buffer).setUint32(16, index, false);
  buf.set(iv, HEADER);
  buf.set(ct, HEADER + iv.length);
  return buf.buffer;
}

export function parseFrameHead(buf) {
  const u8 = new Uint8Array(buf, 0, HEADER);
  let id = '';
  for (let i = 0; i < 16; i++) {
    if (!u8[i]) break;
    id += String.fromCharCode(u8[i]);
  }
  return { id, index: new DataView(buf, 0, HEADER).getUint32(16, false) };
}

export async function sealChunk(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv, ct };
}

export async function openChunk(key, iv, ct) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

/**
 * 把"所有块的密文帧首尾相接"还原成明文 Blob。
 * 每块长度可由 (总长度, 块大小, 总块数) 推出，所以不必额外存索引。
 */
export async function decryptStream(key, cipherBlob, meta) {
  const total = chunkCount(meta.size);
  const parts = [];
  let offset = 0;
  for (let i = 0; i < total; i++) {
    const len = frameLen(meta.size, i);
    const frame = new Uint8Array(await cipherBlob.slice(offset, offset + len).arrayBuffer());
    if (frame.length !== len) throw new Error('密文长度不符：文件可能被截断');
    offset += len;
    const iv = frame.subarray(HEADER, HEADER + IV);
    const ct = frame.subarray(HEADER + IV);
    parts.push(await openChunk(key, iv, ct));
  }
  return new Blob(parts, { type: meta.mime || 'application/octet-stream' });
}

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic'];
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'];

/** 决定渲染方式：image / video / audio / file。优先看 MIME，其次看扩展名（Windows 上 MIME 常为空）。 */
export function kindOf(mime, name) {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  const ext = (name || '').split('.').pop().toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return 'file';
}

export function prettySize(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
