// test/recorder.test.js — 语音消息里与浏览器无关的那些判断
//
// MediaRecorder / getUserMedia 本身要真浏览器，这里只测能被纯函数覆盖的部分：
// MIME 协商顺序、扩展名映射、时长格式、文件名。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickMime, extFor, fmtDuration, voiceName, MIME_CANDIDATES } from '../app/js/recorder.js';

test('pickMime：按优先级取第一个受支持的', () => {
  const supportsAll = () => true;
  assert.equal(pickMime(supportsAll), MIME_CANDIDATES[0]);

  const onlyWebm = (m) => m === 'audio/webm';
  assert.equal(pickMime(onlyWebm), 'audio/webm');

  const onlyMp4 = (m) => m === 'audio/mp4';
  assert.equal(pickMime(onlyMp4), 'audio/mp4');
});

test('pickMime：一个都不支持时返回空串（交给 MediaRecorder 自己选）', () => {
  assert.equal(pickMime(() => false), '');
});

test('pickMime：isTypeSupported 抛异常也不该炸（老旧/奇怪实现）', () => {
  assert.equal(
    pickMime((m) => {
      if (m.startsWith('audio/webm')) throw new TypeError('nope');
      return m === 'audio/mp4';
    }),
    'audio/mp4',
  );
});

test('extFor：容器 → 扩展名', () => {
  assert.equal(extFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extFor('audio/ogg;codecs=opus'), 'ogg');
  assert.equal(extFor('audio/mp4'), 'm4a');
  assert.equal(extFor(''), 'bin');
});

test('fmtDuration：0:0x 与进位', () => {
  assert.equal(fmtDuration(0), '0:00');
  assert.equal(fmtDuration(999), '0:01');
  assert.equal(fmtDuration(65_000), '1:05');
  assert.equal(fmtDuration(3_599_000), '59:59');
  assert.equal(fmtDuration(3_600_000), '1:00:00');
  assert.equal(fmtDuration(7_325_000), '2:02:05');
  assert.equal(fmtDuration(-5), '0:00');
});

test('voiceName：带时间戳且扩展名跟 MIME 一致，两次录音不重名', () => {
  const a = voiceName(new Date(2026, 10, 22, 19, 5, 9), 'audio/webm;codecs=opus');
  const b = voiceName(new Date(2026, 10, 22, 19, 5, 10), 'audio/webm;codecs=opus');
  assert.equal(a, '语音 19-05-09.webm');
  assert.equal(b, '语音 19-05-10.webm');
  assert.notEqual(a, b);
  assert.equal(voiceName(new Date(2026, 10, 22, 0, 0, 0), 'audio/mp4'), '语音 00-00-00.m4a');
});

test('语音文件名以 audio/* 类型入库 → kindOf 会认成 audio（气泡用播放器）', async () => {
  const F = await import('../app/js/files.js');
  assert.equal(F.kindOf('audio/webm;codecs=opus', '语音 19-05-09.webm'), 'audio');
  assert.equal(F.kindOf('audio/mp4', '语音 00-00-00.m4a'), 'audio');
  // 极端情况：MIME 丢了，只剩扩展名，也要认出是音频
  assert.equal(F.kindOf('', '语音 19-05-09.ogg'), 'audio');
});
