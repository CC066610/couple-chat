import test from 'node:test';
import assert from 'node:assert/strict';
import { Binding, State, BindingError } from '../app/js/binding.js';

const peerA = { fingerprint: 'A', signPublicRaw: new Uint8Array(), dhPublicRaw: new Uint8Array() };
const peerB = { fingerprint: 'B', signPublicRaw: new Uint8Array(), dhPublicRaw: new Uint8Array() };

test('新设备未绑定，可以发起配对', () => {
  const b = new Binding();
  assert.equal(b.state, State.UNBOUND);
  assert.equal(b.isBound, false);
  assert.equal(b.offerCreated(), State.OFFER_READY);
});

test('绑定后拒绝再发起配对', () => {
  const b = new Binding();
  b.offerCreated();
  b.answerCreated === undefined; // 说明：answer 与 offer 互斥，这里只验证 bound 后拒绝
  b.bound(peerA);
  assert.equal(b.state, State.BOUND);
  assert.throws(() => b.canStartPairing(), (e) => e instanceof BindingError && e.code === 'ALREADY_BOUND');
  assert.throws(() => b.offerCreated(), (e) => e.code === 'ALREADY_BOUND');
});

test('已绑定时接受第三方绑定会抛错', () => {
  const b = new Binding();
  b.bound(peerA);
  assert.throws(() => b.bound(peerB), (e) => e.code === 'ALREADY_BOUND');
  assert.equal(b.peer.fingerprint, 'A');
});

test('同一对端重复确认（重连）不算冲突', () => {
  const b = new Binding();
  b.bound(peerA);
  assert.equal(b.bound({ ...peerA }), State.BOUND);
});

test('单方直接解除：一方按下即生效，不需要对方同意', () => {
  const b = new Binding();
  b.bound(peerA);
  const removed = b.unbindNow();
  assert.equal(b.state, State.UNBOUND);
  assert.equal(b.isBound, false);
  assert.equal(b.peer, null);
  assert.equal(removed.fingerprint, 'A');   // 返回被解除的对端，供调用方清库
});

test('单方解除后立刻可以与第三个人配对（旧关系不再阻挡）', () => {
  const b = new Binding();
  b.bound(peerA);
  b.unbindNow();
  assert.equal(b.canStartPairing(), true);
  b.bound(peerB);
  assert.equal(b.peer.fingerprint, 'B');
});

test('收到对方的解除通知：本机无条件同步清空', () => {
  const b = new Binding();
  b.bound(peerA);
  const removed = b.incomingUnbindNotice();
  assert.equal(removed.fingerprint, 'A');
  assert.equal(b.state, State.UNBOUND);
  assert.equal(b.isBound, false);
});

test('解除通知是幂等的：本机先按了再收到通知也不报错', () => {
  const b = new Binding();
  b.bound(peerA);
  b.unbindNow();
  assert.equal(b.incomingUnbindNotice(), null);   // 已经未绑定 → 返回 null，不抛
  assert.equal(b.state, State.UNBOUND);
});

test('未绑定时不能解除', () => {
  const b = new Binding();
  assert.throws(() => b.unbindNow(), (e) => e.code === 'NOT_BOUND');
  assert.throws(() => b.unbind(), (e) => e.code === 'NOT_BOUND');
});

test('解除后旧的绑定状态不可复活（必须重新配对）', () => {
  const b = new Binding();
  b.bound(peerA);
  b.unbindNow();
  // 旧版 API 已移除：状态机不再有"待确认解除"这种中间态
  assert.equal('requestUnbind' in b, false);
  assert.equal('refuseUnbind' in b, false);
  assert.equal(b.peer, null);
});
