import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFS, readOn, dndOn, shouldNotify, notifyBody,
  labelFor, latest, bumpSeen, receiptStatusText,
} from '../app/js/receipts.js';

test('默认值：已读关闭、免打扰关闭、通知开启', () => {
  assert.deepEqual({ ...DEFAULT_PREFS }, { read: false, dnd: false, notify: true });
});

test('已读回执必须双方都开', () => {
  assert.equal(readOn({ read: true }, { read: true }), true);
  assert.equal(readOn({ read: true }, { read: false }), false);
  assert.equal(readOn({ read: false }, { read: true }), false);
  assert.equal(readOn(undefined, { read: true }), false);
  assert.equal(readOn({ read: true }, undefined), false);
});

test('免打扰只看本机', () => {
  assert.equal(dndOn({ dnd: true, read: false }), true);
  assert.equal(dndOn({ dnd: false }), false);
  assert.equal(dndOn(null), false);
});

test('通知：前台不弹、免打扰不弹、未授权不弹、关掉通知不弹', () => {
  const on = { read: true, dnd: false, notify: true };
  assert.equal(shouldNotify({ visibility: 'visible', prefs: on, permission: 'granted' }), false);
  assert.equal(shouldNotify({ visibility: 'hidden', prefs: on, permission: 'granted' }), true);
  assert.equal(shouldNotify({ visibility: 'hidden', prefs: { ...on, dnd: true }, permission: 'granted' }), false);
  assert.equal(shouldNotify({ visibility: 'hidden', prefs: { ...on, notify: false }, permission: 'granted' }), false);
  assert.equal(shouldNotify({ visibility: 'hidden', prefs: on, permission: 'default' }), false);
  assert.equal(shouldNotify({ visibility: 'hidden', prefs: on, permission: 'denied' }), false);
});

test('通知正文：文本截断到 60 字，附件按类型', () => {
  assert.equal(notifyBody({ text: '在吗' }), '在吗');
  const long = 'x'.repeat(80);
  assert.equal(notifyBody({ text: long }).length, 61); // 60 + …
  assert.equal(notifyBody({ text: ' a\n b ' }), 'a b');
  assert.equal(notifyBody({ file: { voice: true, name: '语音 1.webm' } }), '语音：语音 1.webm');
  assert.equal(notifyBody({ file: { kind: 'image', name: 'a.png' } }), '图片：a.png');
  assert.equal(notifyBody({ file: { kind: 'video', name: 'a.mp4' } }), '视频：a.mp4');
  assert.equal(notifyBody({ file: { kind: 'file', name: 'a.zip' } }), '文件：a.zip');
  assert.equal(notifyBody(null), '新消息');
});

test('已读标记只贴在最新一条我方消息上', () => {
  const base = { readOn: true, isLatest: false, peerSeenTs: 200, ts: 100 };
  assert.equal(labelFor(base), '');
  assert.equal(labelFor({ ...base, isLatest: true }), '已读');
  assert.equal(labelFor({ ...base, isLatest: true, peerSeenTs: 99 }), '已送达');
  assert.equal(labelFor({ ...base, isLatest: true, peerSeenTs: 0 }), '已送达');
  assert.equal(labelFor({ ...base, isLatest: true, readOn: false }), '');
});

test('latest 只在我方/对方范围内挑时间最大的', () => {
  const rows = [
    { id: 'a', ts: 10, from: 'me' },
    { id: 'b', ts: 30, from: 'them' },
    { id: 'c', ts: 20, from: 'me' },
  ];
  assert.equal(latest(rows).id, 'b');
  assert.equal(latest(rows, 'me').id, 'c');
  assert.equal(latest([], 'me'), null);
});

test('已读水位只增不减', () => {
  assert.equal(bumpSeen(0, 100), 100);
  assert.equal(bumpSeen(100, 50), 100);
  assert.equal(bumpSeen(undefined, 7), 7);
  assert.equal(bumpSeen(7, undefined), 7);
});

test('双签状态文案覆盖四种组合', () => {
  assert.match(receiptStatusText({ read: true }, { read: true }), /双方都已开启/);
  assert.match(receiptStatusText({ read: true }, { read: false }), /等对方也开启/);
  assert.match(receiptStatusText({ read: false }, { read: true }), /你开启后才生效/);
  assert.match(receiptStatusText({}, {}), /双方都未开启/);
});
