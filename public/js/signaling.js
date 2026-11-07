/**
 * BeamDrop WebSocket Signaling Client
 * Handles connection, WiFi room discovery, profile updates, and WebRTC signal relay.
 */

export class SignalingClient {
  constructor() {
    this.ws = null;
    this.peerId = null;
    this.roomId = null;
    this.iceServers = [];
    this.isConnected = false;
    this.profile = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.explicitClose = false;

    // Callbacks
    this.onWelcome = () => {};
    this.onPeerList = () => {};
    this.onPeerJoined = () => {};
    this.onPeerLeft = () => {};
    this.onPeerUpdated = () => {};
    this.onSignal = () => {};
    this.onSignalError = () => {};
    this.onStatusChange = () => {};
  }

  /**
   * Connect to WebSocket server
   * @param {{ deviceName: string, deviceType: string }} profile
   */
  connect(profile) {
    this.profile = profile;
    this.explicitClose = false;

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws${window.location.search}`;

    this.onStatusChange({ connected: false, reconnecting: this.reconnectAttempts > 0 });

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('[BeamDrop] Connected to signaling server.');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.onStatusChange({ connected: true, reconnecting: false });

        // Join room with current profile
        this.send({
          type: 'join',
          deviceName: this.profile.deviceName,
          deviceType: this.profile.deviceType
        });
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.handleMessage(msg);
        } catch (e) {
          console.error('[BeamDrop] Error parsing signaling message:', e);
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        this.onStatusChange({ connected: false, reconnecting: !this.explicitClose });
        console.log('[BeamDrop] Disconnected from signaling server.');

        if (!this.explicitClose) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        console.warn('[BeamDrop] WebSocket error:', err);
      };
    } catch (e) {
      console.error('[BeamDrop] Failed to construct WebSocket:', e);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
    this.reconnectAttempts++;
    console.log(`[BeamDrop] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => {
      if (this.profile && !this.explicitClose) {
        this.connect(this.profile);
      }
    }, delay);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        this.peerId = msg.peerId;
        this.roomId = msg.roomId;
        this.iceServers = msg.iceServers || [];
        this.onWelcome(msg);
        break;

      case 'peer-list':
        this.onPeerList(msg.peers || []);
        break;

      case 'peer-joined':
        this.onPeerJoined(msg.peer);
        break;

      case 'peer-left':
        this.onPeerLeft(msg.peerId);
        break;

      case 'peer-updated':
        this.onPeerUpdated(msg.peer);
        break;

      case 'signal':
        this.onSignal(msg.fromPeerId, msg.fromDeviceName, msg.fromDeviceType, msg.data);
        break;

      case 'signal-error':
        this.onSignalError(msg);
        break;

      case 'pong':
        break;

      default:
        console.log('[BeamDrop] Unhandled signaling message:', msg);
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  updateProfile(profile) {
    this.profile = profile;
    this.send({
      type: 'update-profile',
      deviceName: profile.deviceName,
      deviceType: profile.deviceType
    });
  }

  sendSignal(targetPeerId, data) {
    this.send({
      type: 'signal',
      targetPeerId,
      data
    });
  }

  disconnect() {
    this.explicitClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
