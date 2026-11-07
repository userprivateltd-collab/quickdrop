/**
 * Automated Test: Essential Features Verification
 * 1. P2P Direct Text Message & Link Sharing Relay
 * 2. Custom Room & Pair Code Isolation
 */

import { WebSocket } from 'ws';
import assert from 'assert';

const WS_PORT = 3000;

async function run() {
  console.log('[Test] Starting Essential Features Test...');

  const results = {
    textRelaySuccess: false,
    pairCodeIsolationSuccess: false
  };

  // 1. Text Relay Test: Two peers in same custom room "test-text-room"
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Text relay test timed out')), 6000);
    const ws1 = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws?room=test-text-room`);
    let ws2 = null;
    let id1 = null;
    let id2 = null;

    ws1.on('open', () => {
      ws1.send(JSON.stringify({
        type: 'join',
        deviceName: 'Sender Phone',
        deviceType: 'ios'
      }));
    });

    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome') {
        id1 = msg.peerId;
        // Connect ws2 now
        ws2 = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws?room=test-text-room`);

        ws2.on('open', () => {
          ws2.send(JSON.stringify({
            type: 'join',
            deviceName: 'Receiver Laptop',
            deviceType: 'windows'
          }));
        });

        ws2.on('message', (raw2) => {
          const msg2 = JSON.parse(raw2.toString());
          if (msg2.type === 'welcome') {
            id2 = msg2.peerId;
          }
          if (msg2.type === 'signal' && msg2.data && msg2.data.type === 'text-message') {
            console.log('[Test] Receiver received text message:', msg2.data.text);
            assert.strictEqual(msg2.data.text, 'https://github.com/google - WiFi password: SecretPassword123');
            assert.strictEqual(msg2.fromDeviceName, 'Sender Phone');
            results.textRelaySuccess = true;
            clearTimeout(timeout);
            ws1.close();
            ws2.close();
            resolve();
          }
        });
      }

      if (msg.type === 'peer-joined' && msg.peer.deviceName === 'Receiver Laptop') {
        console.log('[Test] Sender sees Receiver joined, dispatching text-message signal...');
        ws1.send(JSON.stringify({
          type: 'signal',
          targetPeerId: msg.peer.id,
          data: {
            type: 'text-message',
            text: 'https://github.com/google - WiFi password: SecretPassword123',
            timestamp: Date.now()
          }
        }));
      }
    });
  });

  // 2. Pair Code Isolation Test: Client in "room-alpha" should NOT see Client in "room-beta"
  await new Promise((resolve, reject) => {
    const wsAlpha = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws?room=room-alpha`);
    const wsBeta = new WebSocket(`ws://127.0.0.1:${WS_PORT}/ws?room=room-beta`);

    let alphaSawBeta = false;

    wsAlpha.on('open', () => {
      wsAlpha.send(JSON.stringify({ type: 'join', deviceName: 'Alpha Device', deviceType: 'android' }));
    });

    wsBeta.on('open', () => {
      wsBeta.send(JSON.stringify({ type: 'join', deviceName: 'Beta Device', deviceType: 'ios' }));
    });

    wsAlpha.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'peer-joined' || msg.type === 'peer-list') {
        const peers = msg.peers || [msg.peer];
        if (peers.some(p => p && p.deviceName === 'Beta Device')) {
          alphaSawBeta = true;
        }
      }
    });

    setTimeout(() => {
      wsAlpha.close();
      wsBeta.close();
      if (!alphaSawBeta) {
        console.log('[Test] Room isolation verified: Alpha Device did not see Beta Device.');
        results.pairCodeIsolationSuccess = true;
        resolve();
      } else {
        reject(new Error('Room isolation failed: Alpha saw Beta across different rooms!'));
      }
    }, 1500);
  });

  console.log('====================================================');
  console.log('[Essential Features Test Results]:');
  console.log('  textRelaySuccess:', results.textRelaySuccess ? 'PASS' : 'FAIL');
  console.log('  pairCodeIsolationSuccess:', results.pairCodeIsolationSuccess ? 'PASS' : 'FAIL');
  console.log('====================================================');
}

run().catch(err => {
  console.error('[Test Failed]:', err);
  process.exit(1);
});
