import test from 'node:test';
import assert from 'node:assert/strict';
import { packSession, rebuildSdp } from '../app/js/transport.js';

const SAMPLE = [
  'v=0',
  'o=- 123 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:AbCd',
  'a=ice-pwd:0123456789abcdef0123456789ab',
  'a=fingerprint:sha-256 AA:BB:CC:DD',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  'a=candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host generation 0',
  'a=candidate:2 1 udp 1686052607 8.8.8.8 54321 typ srflx raddr 192.168.1.5 rport 54321',
].join('\r\n');

test('packSession 抽出 ufrag/pwd/fingerprint/candidates', () => {
  const p = packSession(SAMPLE);
  assert.equal(p.ufrag, 'AbCd');
  assert.equal(p.pwd, '0123456789abcdef0123456789ab');
  assert.equal(p.fp, 'AA:BB:CC:DD');
  assert.equal(p.setup, 'actpass');
  assert.equal(p.candidates.length, 2);
  assert.deepEqual(p.candidates[0], ['udp', '192.168.1.5', 54321, 'host']);
});

test('rebuildSdp 生成的 SDP 含必要字段与候选行', () => {
  const sdp = rebuildSdp(packSession(SAMPLE), 'offer');
  assert.match(sdp, /a=ice-ufrag:AbCd/);
  assert.match(sdp, /a=ice-pwd:0123456789abcdef0123456789ab/);
  assert.match(sdp, /a=fingerprint:sha-256 AA:BB:CC:DD/);
  assert.match(sdp, /a=setup:actpass/);
  assert.match(sdp, /m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel/);
  assert.match(sdp, /a=candidate:1 1 udp 2122260223 192\.168\.1\.5 54321 typ host/);
  assert.match(sdp, /a=candidate:2 1 udp 2122260223 8\.8\.8\.8 54321 typ srflx/);
  assert.ok(sdp.endsWith('\r\n'));
});

test('answer 角色固定写 active', () => {
  const sdp = rebuildSdp(packSession(SAMPLE), 'answer');
  assert.match(sdp, /a=setup:active/);
});

test('空候选列表也能生成结构完整的 SDP', () => {
  const sdp = rebuildSdp({ ufrag: 'u', pwd: 'p', fp: 'F', setup: 'actpass', candidates: [] }, 'offer');
  assert.match(sdp, /a=ice-ufrag:u/);
  assert.ok(!sdp.includes('a=candidate'));
});
