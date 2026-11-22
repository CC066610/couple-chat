// binding.js — 绑定状态机（纯逻辑，无 DOM / 无网络，便于单元测试）。
//
// 需求里的硬约束都在这里：
//   · 同一时间只能绑一个对端
//   · 已绑定时拒绝任何新的配对
//   · 解除是**单方即可完成**的：任一方按一下，本机立刻解除并通知对方同步清空
//   · 解除后本机历史清空（除非调用方显式保留）

export const State = Object.freeze({
  UNBOUND: 'unbound',
  OFFER_READY: 'offer-ready',
  ANSWER_READY: 'answer-ready',
  BOUND: 'bound',
});

export class BindingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BindingError';
    this.code = code;
  }
}

export class Binding {
  constructor(state = State.UNBOUND, peer = null) {
    this.state = state;
    this.peer = peer; // { fingerprint, signPublicRaw, dhPublicRaw, boundAt }
  }

  get isBound() {
    return this.state === State.BOUND;
  }

  /** 能否发起配对：只有完全未绑定才行。 */
  canStartPairing() {
    if (this.isBound) {
      throw new BindingError('ALREADY_BOUND', '已经和一个人绑定，解除后才能与别人配对');
    }
    return true;
  }

  offerCreated() {
    this.canStartPairing();
    this.state = State.OFFER_READY;
    return this.state;
  }

  answerCreated() {
    this.canStartPairing();
    this.state = State.ANSWER_READY;
    return this.state;
  }

  /** 链路打通 + 双向验签都通过后调用。 */
  bound(peer) {
    if (this.isBound) {
      // 只允许"同一个对端"的重复确认（比如重连），其它一律拒绝
      if (this.peer && this.peer.fingerprint !== peer.fingerprint) {
        throw new BindingError('ALREADY_BOUND', '已绑定其他人，拒绝本次绑定');
      }
      return this.state;
    }
    this.peer = { ...peer, boundAt: Date.now() };
    this.state = State.BOUND;
    return this.state;
  }

  /**
   * 单方直接解除：本机立刻不再是绑定状态，不等对方同意。
   * 返回被解除的对端（调用方用它清库、发通知）。
   */
  unbindNow() {
    if (!this.isBound) throw new BindingError('NOT_BOUND', '当前没有可解除的绑定');
    const peer = this.peer;
    this.peer = null;
    this.state = State.UNBOUND;
    return peer;
  }

  /**
   * 收到对方"我已经解除"的通知：本机同步清空。
   * 幂等 —— 已经未绑定时返回 null（重复通知、或本机先按了，都不报错）。
   */
  incomingUnbindNotice() {
    if (!this.isBound) return null;
    const peer = this.peer;
    this.peer = null;
    this.state = State.UNBOUND;
    return peer;
  }

  /** 兼容旧名：等价于 unbindNow()。 */
  unbind() {
    return this.unbindNow();
  }
}
