/**
 * BeamDrop Automated Multi-Client E2E Signaling & Discovery Test
 * Uses isolated custom room to prevent interference with real user sessions.
 */

import { WebSocket } from 'ws';

async function runTest() {
  console.log('[Test] Starting 2-client automated signaling test...');

  const wsUrl = 'ws://localhost:3000/ws?room=automated-test-sandbox';
  let c1Id = null;
  let c2Id = null;

  const results = {
    c1Welcomed: false,
    c2Welcomed: false,
    c1SawC2Join: false,
    c2ReceivedPeerList: false,
    c2ReceivedTransferRequest: false,
    c1ReceivedTransferAccept: false
  };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test timed out after 10s')), 10000);

    const client1 = new WebSocket(wsUrl);

    client1.on('open', () => {
      console.log('[Test] Client 1 (iPhone) connected.');
      client1.send(JSON.stringify({
        type: 'join',
        deviceName: 'Alice iPhone',
        deviceType: 'ios'
      }));
    });

    client1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome') {
        c1Id = msg.peerId;
        results.c1Welcomed = true;
        console.log(`[Test] Client 1 welcomed with id: ${c1Id}`);

        // Now connect Client 2
        connectClient2();
      }

      if (msg.type === 'peer-joined' && msg.peer.deviceName === 'Bob Pixel') {
        c2Id = msg.peer.id;
        results.c1SawC2Join = true;
        console.log(`[Test] Client 1 saw peer-joined from: ${msg.peer.deviceName} (${c2Id})`);

        // Send transfer-request from Client 1 to Client 2
        console.log('[Test] Client 1 sending transfer-request to Client 2...');
        client1.send(JSON.stringify({
          type: 'signal',
          targetPeerId: c2Id,
          data: {
            type: 'transfer-request',
            transferId: 'test_tx_001',
            files: [{ id: 'f_1', name: 'photo.jpg', size: 1048576, type: 'image/jpeg' }],
            totalSize: 1048576,
            senderName: 'Alice iPhone',
            senderType: 'ios'
          }
        }));
      }

      if (msg.type === 'signal') {
        if (msg.data.type === 'transfer-response' && msg.data.accepted === true) {
          results.c1ReceivedTransferAccept = true;
          console.log('[Test] Client 1 received transfer acceptance from Client 2! Success!');
          clearTimeout(timeout);
          client1.close();
          resolve();
        }
      }
    });

    function connectClient2() {
      const client2 = new WebSocket(wsUrl);

      client2.on('open', () => {
        console.log('[Test] Client 2 (Pixel) connected.');
        client2.send(JSON.stringify({
          type: 'join',
          deviceName: 'Bob Pixel',
          deviceType: 'android'
        }));
      });

      client2.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'welcome') {
          results.c2Welcomed = true;
          console.log(`[Test] Client 2 welcomed with id: ${msg.peerId}`);
        }

        if (msg.type === 'peer-list') {
          if (msg.peers.some(p => p.id === c1Id)) {
            results.c2ReceivedPeerList = true;
            console.log(`[Test] Client 2 peer-list correctly contains Client 1: ${msg.peers.map(p => p.deviceName)}`);
          }
        }

        if (msg.type === 'signal') {
          if (msg.data.type === 'transfer-request') {
            results.c2ReceivedTransferRequest = true;
            console.log(`[Test] Client 2 received transfer-request from ${msg.fromDeviceName} for ${msg.data.files[0].name}`);

            // Send back acceptance
            console.log('[Test] Client 2 accepting transfer...');
            client2.send(JSON.stringify({
              type: 'signal',
              targetPeerId: c1Id,
              data: {
                type: 'transfer-response',
                transferId: msg.data.transferId,
                accepted: true
              }
            }));
            client2.close();
          }
        }
      });
    }
  });

  console.log('====================================================');
  console.log('[Test Results]:');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k}: ${v ? 'PASS' : 'FAIL'}`);
  }
  console.log('====================================================');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('[Test Failed]:', err);
  process.exit(1);
});
