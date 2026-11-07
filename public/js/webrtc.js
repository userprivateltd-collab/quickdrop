/**
 * BeamDrop WebRTC PeerConnection & DataChannel Manager
 * Direct peer-to-peer connection lifecycle, ICE handling, and state tracking.
 */

export class WebRTCConnection {
  /**
   * @param {string} targetPeerId
   * @param {Array} iceServers
   * @param {Function} signalSender - (targetPeerId, data) => void
   */
  constructor(targetPeerId, iceServers = [], signalSender) {
    this.targetPeerId = targetPeerId;
    this.iceServers = iceServers.length > 0 ? iceServers : [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ];
    this.signalSender = signalSender;

    this.pc = null;
    this.dataChannel = null;
    this.isInitiator = false;
    this.pendingIceCandidates = [];
    this.isClosed = false;

    // Callbacks
    this.onChannelOpen = () => {};
    this.onChannelMessage = () => {};
    this.onChannelClose = () => {};
    this.onError = () => {};
    this.onConnectionStateChange = () => {};
  }

  initPeerConnection() {
    if (this.pc) return;

    const rtcConfig = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2
    };

    this.pc = new RTCPeerConnection(rtcConfig);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalSender(this.targetPeerId, {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON()
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc ? this.pc.connectionState : 'closed';
      console.log(`[BeamDrop WebRTC] Connection state: ${state}`);
      this.onConnectionStateChange(state);

      if (state === 'failed' || state === 'closed') {
        this.onError(new Error(`WebRTC connection ${state}`));
      }
    };

    this.pc.ondatachannel = (event) => {
      console.log('[BeamDrop WebRTC] DataChannel received from remote peer.');
      this.setupDataChannel(event.channel);
    };
  }

  setupDataChannel(channel) {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen = () => {
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

    // Create ordered reliable data channel
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
