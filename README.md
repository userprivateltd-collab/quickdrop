# BeamDrop ⚡ — High-Speed Local WiFi P2P File Sharing

**BeamDrop** is a clean, production-ready, peer-to-peer web application for sharing files directly between devices on the same WiFi network (similar to PairDrop, LocalSend, and Google Nearby Share).

Files transfer **directly device-to-device via WebRTC RTCDataChannel** at the maximum speed your local network hardware permits. Files **never** pass through, touch, or get stored on any cloud server.

---

## 🌟 Key Features

- **Zero Fake Data**: Every device, file size, transfer speed (MB/s), ETA, and progress bar is calculated from live WebRTC SCTP packets and stream timers in real time.
- **Same-WiFi Zero-Config Discovery**: Automatically groups devices sharing the same local private network or public router NAT IP into a shared discovery room without requiring account logins.
- **Direct P2P WebRTC DataChannel**: Ordered, reliable SCTP data channel with backpressure control (`bufferedAmount` & `bufferedAmountLowThreshold`) and 256 KB memory-efficient chunk slicing.
- **Large File Streaming**:
  - **Chromium (Windows, Mac, Linux, Android)**: Uses the **File System Access API** (`showSaveFilePicker` / writable streams) to stream incoming files directly to disk without consuming browser RAM.
  - **iOS Safari / Mobile**: Safe chunk-to-blob assembly with active memory monitoring and honest warnings if a transfer approaches Safari's tab memory limits.
- **Screen Wake Lock API**: Automatically acquires `navigator.wakeLock` during active transfers so phones don't sleep and drop the connection.
- **Material 3 + Apple iOS Design System**:
  - 16–28px soft border radii, clean subtle shadows, Google Blue (`#1A73E8`) accent.
  - Bottom sheets on mobile, centered dialogs on desktop.
  - Complete Light & Dark mode (follows `prefers-color-scheme` with manual toggle).
  - Mobile-first, responsive from 360px phones up to 4K displays.
- **PWA Ready**: Web app manifest + offline caching Service Worker for home-screen installation.
- **Session History**: Local in-memory / session history tracking sent and received files.
- **QR Code Pairing**: Instant canvas QR code generator for scanning and pairing mobile devices.

---

## 📁 Project Folder Structure

```
├── package.json               # Node.js project configuration (type: module, ws dependency)
├── server.js                  # Lightweight HTTP & WebSocket signaling server (Node.js + ws)
├── test-e2e-signaling.js      # Automated multi-client discovery & signaling verification test
├── public/                    # Frontend static web application
│   ├── index.html             # Semantic, accessible, mobile-first HTML5 single page app
│   ├── manifest.webmanifest   # Progressive Web App (PWA) manifest
│   ├── sw.js                  # Service Worker for offline app shell caching
│   ├── css/
│   │   ├── variables.css      # Design tokens, color palette, dark mode, radii, safe areas
│   │   ├── main.css           # Core typography, radar, cards, modals, bottom sheets
│   │   └── animations.css     # Radar pulse waves, sheet transitions, spring motion
│   ├── js/
│   │   ├── app.js             # Main orchestrator, UI state controller & event coordinator
│   │   ├── signaling.js       # WebSocket client, room discovery, peer lifecycle events
│   │   ├── webrtc.js          # WebRTC RTCPeerConnection & DataChannel lifecycle manager
│   │   ├── transfer.js        # File chunking engine, backpressure control & live metrics
│   │   ├── fs-stream.js       # File System Access API disk streaming & memory safeguards
│   │   ├── storage.js         # LocalStorage profile persistence & session history
│   │   ├── wake-lock.js       # Screen Wake Lock API wrapper
│   │   ├── qr-code.js         # Zero-dependency offline Canvas QR code generator
│   │   └── ui-utils.js        # Byte formatters, live MB/s, ETA, audio chimes, toast alerts
│   └── assets/
│       └── icons/
│           ├── app-icon.svg   # Scalable vector application logo
│           ├── ios.svg        # Apple / iOS device icon
│           ├── android.svg    # Android robot device icon
│           └── windows.svg    # Windows / PC device icon
└── README.md                  # Complete documentation and deployment guide
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** v18.0.0 or higher
- **npm** v8.0.0 or higher

### Installation

1. Clone or copy the repository to your local machine:
   ```bash
   cd "ios to android shring platform"
   ```

2. Install the single dependency (`ws`):
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

   The server will print its local and LAN addresses:
   ```
   ====================================================
     BeamDrop Server is running!
     Local:    http://localhost:3000
     Network:  http://192.168.1.64:3000 (Wi-Fi)
     Room IP discovery: ON (Private LAN grouped automatically)
     WebRTC DataChannel chunk size: 256 KB
   ====================================================
   ```

---

## 📱 How to Test on Phone + Laptop on the Same WiFi

To share files between a laptop and a mobile phone on the same WiFi:

1. **Start the server** on your computer (`npm start`).
2. Notice the network URL printed in the terminal (e.g., `http://192.168.1.64:3000`).
3. **Open that address on your computer browser**: `http://localhost:3000`.
4. **Open that address on your phone**:
   - Either type `http://192.168.1.64:3000` into Chrome/Safari on your phone,
   - Or click **Scan QR** on your computer screen and scan it with your phone camera!
5. Both devices will automatically detect each other in the **Same WiFi** radar screen!
6. Tap the device card, pick one or more files, tap **Send Files**, accept on the other device, and watch them stream directly at maximum WiFi speed.

> ### ⚠️ Note on HTTPS, Localhost, and Mobile Browsers
> - **Localhost**: Browsers treat `localhost` and `127.0.0.1` as a **secure context** by default.
> - **LAN IPs (`http://192.168.x.x:3000`)**:
>   - WebRTC DataChannels work across LAN IP addresses on most mobile browsers.
>   - However, **Service Workers** and **Screen Wake Lock** require a **Secure Context (HTTPS)** when accessed via non-localhost IP addresses.
>   - **For testing with full HTTPS on your LAN**:
>     1. You can generate a free local certificate using [`mkcert`](https://github.com/FiloSottile/mkcert):
>        ```bash
>        mkcert -install
>        mkcert 192.168.1.64 localhost
>        ```
>     2. Start the server with the certificates:
>        ```bash
>        $env:SSL_KEY="192.168.1.64+1-key.pem"; $env:SSL_CERT="192.168.1.64+1.pem"; node server.js
>        ```
>     3. On Android Chrome, you can also enable `chrome://flags/#unsafely-treat-insecure-origin-as-secure` and add `http://192.168.1.64:3000`.

---

## ⚙️ Environment Variables

The server is configured entirely via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for the HTTP and WebSocket server. |
| `HOST` | `0.0.0.0` | Network binding interface. |
| `STUN_SERVERS` | Google & Cloudflare STUN | Comma-separated list of STUN servers (e.g. `stun:stun.l.google.com:19302`). |
| `ICE_SERVERS` | *(Optional)* | Full JSON array of STUN/TURN configurations (e.g. `[{"urls":"turn:turn.example.com:3478","username":"...","credential":"..."}]`). |
| `SSL_KEY` | *(Optional)* | Path to SSL private key file for native HTTPS mode. |
| `SSL_CERT` | *(Optional)* | Path to SSL certificate file for native HTTPS mode. |

---

## 🌐 Production Deployment

BeamDrop can be deployed to any platform supporting WebSockets and Node.js.

### 1. Render.com / Railway / Fly.io (Recommended)
1. Push your repository to GitHub.
2. In Render / Railway / Fly.io:
   - **Environment**: Node.js
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/health`
3. These platforms automatically terminate SSL/TLS with free HTTPS certificates. When users on the same WiFi open the production HTTPS URL, their public IP matches and they discover each other instantly.

### 2. VPS (Ubuntu/Debian) with Caddy / Nginx Reverse Proxy
Install Caddy for automatic HTTPS:
```caddy
beamdrop.yourdomain.com {
    reverse_proxy localhost:3000
}
```
Run BeamDrop via systemd or PM2:
```bash
npm install -g pm2
pm2 start server.js --name beamdrop
pm2 save
pm2 startup
```

---

## 🔍 Platform Limitations & Capabilities (Stated Honestly)

| Feature / Limit | Windows / Mac (Chrome & Edge) | Android (Chrome) | iOS (Safari / WebKit) |
|---|---|---|---|
| **Max File Size** | **Unlimited** (Multi-GB) | **Multi-GB** | **~800 MB – 1 GB** |
| **Disk Streaming API** | **Yes** (File System Access API) | **Yes** (Native Download Stream) | **No** (WebKit in-memory only) |
| **Tab Memory Limits** | Multi-GB heap | Dependent on device RAM (~2 GB) | **Strict 1 GB – 1.4 GB tab memory cap** |
| **Screen Wake Lock** | Supported | Supported | Supported in iOS 16.4+ (when in foreground) |
| **Background Transfers** | Active tab or background window | Must keep tab active / foreground | Must keep Safari active on screen |

### Honest Technical Notes:
1. **iOS Safari RAM Constraint**: WebKit on iOS terminates browser tabs that exceed device memory ceilings (typically 1 GB – 1.4 GB per tab). BeamDrop monitors incoming transfer sizes and presents a proactive warning notice on iOS when receiving transfers exceeding 800 MB.
2. **Chromium File System Access Advantage**: On Chrome/Edge (Windows/Mac), BeamDrop streams incoming binary chunks directly into a `FileSystemWritableFileStream`. This uses near-zero RAM regardless of whether the file is 500 MB or 50 GB.
3. **NAT Traversal**: Over 95% of devices on the same home or office WiFi establish a direct local peer-to-peer connection via STUN candidates. For symmetric enterprise NATs or complex VLAN networks, a TURN server can be added via the `ICE_SERVERS` environment variable.

---

## 🧪 Verification & Automated Testing

Run the included automated multi-client discovery and signaling verification test:
```bash
node test-e2e-signaling.js
```
This tests:
- Simultaneous client connections
- Room assignment and welcome handshakes
- Real-time peer-joined and peer-list events
- Direct transfer requests and accept/deny signal routing
