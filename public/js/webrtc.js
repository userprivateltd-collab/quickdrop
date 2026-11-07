/**
 * BeamDrop WebRTC PeerConnection & DataChannel Manager
 * Ultra-fast direct peer-to-peer connection lifecycle, ICE handling, and state tracking.
 */

export class WebRTCConnection {
  /**
   * @param {string} targetPeerId
   * @param {Array} iceServers
   * @param {Function} signalSender - (targetPeerId, data) => void
   */
  constructor(targetPeerId, iceServers = [], signalSender) {
    this.targetPeerId = targetPeerId;
    // Use the 2 fastest STUN servers to avoid parallel query congestion and timeouts
    this.iceServers = iceServers.length > 0 ? iceServers.slice(0, 2) : [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
    this.signalSender = signalSender;

    this.pc = null;
    this.dataChannel = null;
    this.isInitiator = false;
    this.pendingIceCandidates = [];
    this.isClosed = false;
    this.connectionWatchdog = null;

    // Callbacks
    this.onChannelOpen = () => {};
    this.onChannelMessage = () => {};
    this.onChannelClose = () => {};
    this.onError = () => {};
    this.onConnectionStateChange = () => {};
    this.onStatusText = () => {};
  }

  initPeerConnection() {
    if (this.pc) return;

    const rtcConfig = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 0 // Avoid pre-allocated candidate pools which cause stale sockets
    };

    this.pc = new RTCPeerConnection(rtcConfig);

    this.pc.onicecandidate = (event) => {
      if (event.candidate && event.candidate.candidate) {
        this.signalSender(this.targetPeerId, {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON()
        });
      }
    };

    // Both iceConnectionState and connectionState for complete cross-browser support (iOS Safari)
    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc ? this.pc.iceConnectionState : 'closed';
      console.log(`[BeamDrop WebRTC] ICE state: ${iceState}`);
      this.evaluateState(iceState);
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc ? this.pc.connectionState : 'closed';
      console.log(`[BeamDrop WebRTC] Connection state: ${state}`);
      this.evaluateState(state);
    };

    this.pc.ondatachannel = (event) => {
      console.log('[BeamDrop WebRTC] DataChannel received from remote peer.');
      this.setupDataChannel(event.channel);
    };

    this.startWatchdog();
  }

  evaluateState(state) {
    this.onConnectionStateChange(state);

    if (state === 'connected') {
      this.clearWatchdog();
      if (this.onStatusText) this.onStatusText('Direct P2P Link Established');
    } else if (state === 'checking') {
      if (this.onStatusText) this.onStatusText('Finding optimal local Wi-Fi route...');
    } else if (state === 'failed') {
      console.warn('[BeamDrop WebRTC] Connection failed, attempting ICE restart...');
      if (this.isInitiator && !this.isClosed) {
        this.restartIce().catch(() => {});
      } else {
        this.onError(new Error('Direct P2P link failed. Verify both devices are on the same Wi-Fi and router does not isolate clients.'));
      }
    }
  }

  startWatchdog() {
    this.clearWatchdog();
    // 9-second connection watchdog: if still not open, trigger ICE restart or notify
    this.connectionWatchdog = setTimeout(() => {
      if (this.dataChannel && this.dataChannel.readyState === 'open') return;
      if (this.pc && (this.pc.iceConnectionState === 'connected' || this.pc.connectionState === 'connected')) return;

      console.warn('[BeamDrop WebRTC] Connection handshake taking long, kicking ICE restart...');
      if (this.onStatusText) this.onStatusText('Re-routing local connection...');
      if (this.isInitiator && !this.isClosed) {
        this.restartIce().catch(err => {
          console.warn('[BeamDrop WebRTC] Watchdog ICE restart error:', err);
        });
      }
    }, 9000);
  }

  clearWatchdog() {
    if (this.connectionWatchdog) {
      clearTimeout(this.connectionWatchdog);
      this.connectionWatchdog = null;
    }
  }

  async restartIce() {
    if (!this.pc || this.isClosed || !this.isInitiator) return;
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.signalSender(this.targetPeerId, {
        type: 'offer',
        sdp: offer
      });
    } catch (e) {
      console.warn('[BeamDrop WebRTC] Failed to restart ICE:', e);
    }
  }

  setupDataChannel(channel) {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';

    try {
      // 4 MB threshold to maintain high transmission queue without stalling
      this.dataChannel.bufferedAmountLowThreshold = 4 * 1024 * 1024;
    } catch (e) {}

    this.dataChannel.onopen = () => {
      this.clearWatchdog();
      console.log('[BeamDrop WebRTC] DataChannel open & ready for file transfer.');
      this.onChannelOpen(this.dataChannel);
    };

    this.dataChannel.onmessage = (event) => {
      this.onChannelMessage(event);
    };

    this.dataChannel.onclose = () => {
      console.log('[BeamDrop WebRTC] DataChannel closed.');
      this.onChannelClose();
    };

    this.dataChannel.onerror = (err) => {
      console.error('[BeamDrop WebRTC] DataChannel error:', err);
      this.onError(err);
    };
  }

  /**
   * Connect as initiator (creates offer and local data channel)
   */
  async createOffer() {
    this.isInitiator = true;
    this.initPeerConnection();

    // Create ordered reliable data channel for file transfer
    const channel = this.pc.createDataChannel('beam-file-transfer', {
      ordered: true
    });
    this.setupDataChannel(channel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    this.signalSender(this.targetPeerId, {
      type: 'offer',
      sdp: offer
    });
  }

  /**
   * Handle incoming offer from remote peer
   */
  async handleOffer(offerSdp) {
    this.isInitiator = false;
    this.initPeerConnection();

    await this.pc.setRemoteDescription(new RTCSessionDescription(offerSdp));

    // Process queued ICE candidates
    await this.flushPendingCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    this.signalSender(this.targetPeerId, {
      type: 'answer',
      sdp: answer
    });
  }

  /**
   * Handle incoming answer from remote peer
   */
  async handleAnswer(answerSdp) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
    await this.flushPendingCandidates();
  }

  /**
   * Handle incoming ICE candidate
   */
  async handleCandidate(candidateData) {
    if (!candidateData || !candidateData.candidate) return;
    const candidate = new RTCIceCandidate(candidateData);
    if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[BeamDrop WebRTC] Failed to add ICE candidate:', err);
      }
    } else {
      this.pendingIceCandidates.push(candidate);
    }
  }

  async flushPendingCandidates() {
    while (this.pendingIceCandidates.length > 0) {
      const candidate = this.pendingIceCandidates.shift();
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[BeamDrop WebRTC] Error adding queued ICE candidate:', err);
      }
    }
  }

  close() {
    this.isClosed = true;
    this.clearWatchdog();
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch (e) {}
      this.dataChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {}
      this.pc = null;
    }
  }
}
