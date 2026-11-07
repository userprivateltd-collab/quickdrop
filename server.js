/**
 * BeamDrop Signaling & Static Web Server
 * Production-ready WebRTC signaling and static asset server for local/P2P file sharing.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// Configuration from environment variables
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SSL_KEY = process.env.SSL_KEY;
const SSL_CERT = process.env.SSL_CERT;

// Parse ICE servers from environment
function getIceServers() {
  if (process.env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      console.warn('[BeamDrop] Failed to parse ICE_SERVERS environment variable, falling back to STUN defaults.');
    }
  }

  const stunList = (process.env.STUN_SERVERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (stunList.length > 0) {
    return stunList.map(url => ({ urls: url.startsWith('stun:') ? url : `stun:${url}` }));
  }

  // High-reliability public STUN servers
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
}

const ICE_SERVERS = getIceServers();
const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 KB

/**
 * Determine if an IP address is a private / local / loopback LAN address
 */
function isPrivateOrLocalIp(rawIp) {
  if (!rawIp) return true;
  const ip = rawIp.replace(/^::ffff:/, '').trim();

  // Loopback
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;

  // RFC 1918 Private IPv4 ranges
  // 10.0.0.0 - 10.255.255.255
  if (/^10\./.test(ip)) return true;
  // 172.16.0.0 - 172.31.255.255
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  // 192.168.0.0 - 192.168.255.255
  if (/^192\.168\./.test(ip)) return true;
  // Link-local 169.254.0.0/16
  if (/^169\.254\./.test(ip)) return true;

  // IPv6 Unique Local (fc00::/7) and Link-Local (fe80::/10)
  if (/^(fc|fd|fe80)/i.test(ip)) return true;

  return false;
}

/**
 * Compute the discovery Room ID for a client based on IP or explicit query override
 */
function resolveRoomId(req, urlParams) {
  // Explicit room override if provided (useful for cross-subnet pairing or custom codes)
  const explicitRoom = urlParams.get('room');
  if (explicitRoom && explicitRoom.trim().length > 0) {
    return `custom-${explicitRoom.trim().toLowerCase().slice(0, 32)}`;
  }

  const xForwardedFor = req.headers['x-forwarded-for'];
  let clientIp = '';

  if (xForwardedFor) {
    // Take the first IP if behind proxy/load-balancer
    const parts = xForwardedFor.split(',');
    clientIp = parts[0].trim();
  } else if (req.socket && req.socket.remoteAddress) {
    clientIp = req.socket.remoteAddress;
  }

  const cleanIp = (clientIp || '').replace(/^::ffff:/, '').trim();

  // If client is on a local private network or loopback, group into shared LAN room
  if (isPrivateOrLocalIp(cleanIp)) {
    return 'lan-network';
  }

  // For public IPs (clients behind the same NAT / external public router IP):
  // Hash the public IP so real IP is never broadcasted to peers
  const ipHash = crypto.createHash('sha256').update(cleanIp).digest('hex').slice(0, 16);
  return `pub-${ipHash}`;
}

/**
 * Get all available network interface IPv4 addresses on the host machine
 */
function getLocalNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      // Skip over internal (127.0.0.1) and non-IPv4 addresses
      if (net.family === 'IPv4' && !net.internal) {
        addresses.push({
          interface: name,
          address: net.address
        });
      }
    }
  }

  return addresses;
}

// MIME types map
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * HTTP request handler
 */
function handleHttpRequest(req, res) {
  // CORS & Security Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 1. Health check endpoint
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: Date.now(),
      connectedPeers: clients.size,
      activeRooms: rooms.size
    }));
    return;
  }

  // 2. Client configuration endpoint
  if (pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      iceServers: ICE_SERVERS,
      defaultChunkSize: DEFAULT_CHUNK_SIZE
    }));
    return;
  }

  // 3. Network info endpoint
  if (pathname === '/api/info') {
    const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const cleanIp = rawIp.replace(/^::ffff:/, '');
    const isLan = isPrivateOrLocalIp(cleanIp);
    const roomId = resolveRoomId(req, parsedUrl.searchParams);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      clientIp: cleanIp,
      isLan,
      roomId,
      localAddresses: getLocalNetworkAddresses(),
      port: PORT
    }));
    return;
  }

  // 4. Static File Serving
  let safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  let filePath = path.join(PUBLIC_DIR, safePath);

  // If path doesn't have an extension, try adding .html
  if (!path.extname(filePath)) {
    if (fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    }
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA routing if requested non-asset
      if (!path.extname(safePath)) {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexPath, (readErr, content) => {
          if (readErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(content);
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Disable aggressive caching to ensure live CSS/JS updates apply immediately
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
}

// Create HTTP or HTTPS server
let server;
if (SSL_KEY && SSL_CERT && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
  const options = {
    key: fs.readFileSync(SSL_KEY),
    cert: fs.readFileSync(SSL_CERT)
  };
  server = https.createServer(options, handleHttpRequest);
  console.log('[BeamDrop] HTTPS Mode Enabled with custom certificates.');
} else {
  server = http.createServer(handleHttpRequest);
}

// Set up WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server });

/**
 * State Management:
 * clients: Map<peerId, { id, ws, roomId, deviceName, deviceType, joinedAt, isAlive }>
 * rooms: Map<roomId, Set<peerId>>
 */
const clients = new Map();
const rooms = new Map();

/**
 * Broadcast an event to all peers in a room except the sender
 */
function broadcastToRoom(roomId, message, excludePeerId = null) {
  const peerIds = rooms.get(roomId);
  if (!peerIds) return;

  const payload = JSON.stringify(message);
  for (const peerId of peerIds) {
    if (peerId === excludePeerId) continue;
    const client = clients.get(peerId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

/**
 * Get sanitized peer list for a room
 */
function getRoomPeerList(roomId, excludePeerId = null) {
  const peerIds = rooms.get(roomId);
  if (!peerIds) return [];

  const list = [];
  for (const peerId of peerIds) {
    if (peerId === excludePeerId) continue;
    const client = clients.get(peerId);
    if (client) {
      list.push({
        id: client.id,
        deviceName: client.deviceName,
        deviceType: client.deviceType,
        joinedAt: client.joinedAt
      });
    }
  }
  return list;
}

/**
 * Remove client cleanly from memory and notify peers
 */
function removeClient(peerId) {
  const client = clients.get(peerId);
  if (!client) return;

  const roomId = client.roomId;
  clients.delete(peerId);

  const room = rooms.get(roomId);
  if (room) {
    room.delete(peerId);
    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      broadcastToRoom(roomId, {
        type: 'peer-left',
        peerId
      });
    }
  }

  console.log(`[BeamDrop] Peer disconnected: ${client.deviceName} (${peerId}) from room ${roomId}. Active peers in room: ${room ? room.size : 0}`);
}

// WebSocket Connection Handler
wss.on('connection', (ws, req) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const roomId = resolveRoomId(req, parsedUrl.searchParams);
  const peerId = crypto.randomUUID();

  const clientInfo = {
    id: peerId,
    ws,
    roomId,
    deviceName: 'Unnamed Device',
    deviceType: 'desktop',
    joinedAt: Date.now(),
    isAlive: true
  };

  clients.set(peerId, clientInfo);

  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }
  rooms.get(roomId).add(peerId);

  // Setup heartbeat listener
  ws.on('pong', () => {
    clientInfo.isAlive = true;
  });

  // Handle incoming messages from client
  ws.on('message', (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());
      const type = message.type;

      switch (type) {
        case 'join': {
          clientInfo.deviceName = (message.deviceName || 'Unnamed Device').slice(0, 48);
          clientInfo.deviceType = ['ios', 'android', 'windows', 'desktop'].includes(message.deviceType)
            ? message.deviceType
            : 'desktop';

          console.log(`[BeamDrop] Peer joined: "${clientInfo.deviceName}" [${clientInfo.deviceType}] (id: ${peerId}) into room: ${roomId}`);

          // 1. Send welcome message to the newly joined peer with room info and ICE servers
          ws.send(JSON.stringify({
            type: 'welcome',
            peerId: clientInfo.id,
            roomId: clientInfo.roomId,
            deviceName: clientInfo.deviceName,
            deviceType: clientInfo.deviceType,
            iceServers: ICE_SERVERS
          }));

          // 2. Send current peer list in this room to the new peer
          const currentPeers = getRoomPeerList(roomId, peerId);
          ws.send(JSON.stringify({
            type: 'peer-list',
            peers: currentPeers
          }));

          // 3. Broadcast to all other peers in the room that a new peer joined
          broadcastToRoom(roomId, {
            type: 'peer-joined',
            peer: {
              id: clientInfo.id,
              deviceName: clientInfo.deviceName,
              deviceType: clientInfo.deviceType,
              joinedAt: clientInfo.joinedAt
            }
          }, peerId);

          break;
        }

        case 'update-profile': {
          if (message.deviceName) {
            clientInfo.deviceName = message.deviceName.slice(0, 48);
          }
          if (message.deviceType && ['ios', 'android', 'windows', 'desktop'].includes(message.deviceType)) {
            clientInfo.deviceType = message.deviceType;
          }

          console.log(`[BeamDrop] Profile updated for ${peerId}: "${clientInfo.deviceName}" [${clientInfo.deviceType}]`);

          // Notify all other peers in the room of profile change
          broadcastToRoom(roomId, {
            type: 'peer-updated',
            peer: {
              id: clientInfo.id,
              deviceName: clientInfo.deviceName,
              deviceType: clientInfo.deviceType
            }
          }, peerId);

          break;
        }

        case 'signal': {
          // Relaying WebRTC signal (offer, answer, ICE candidate, transfer-request, accept, deny)
          const targetPeerId = message.targetPeerId;
          const targetClient = clients.get(targetPeerId);

          if (!targetClient) {
            ws.send(JSON.stringify({
              type: 'signal-error',
              targetPeerId,
              message: 'Recipient peer is no longer online.'
            }));
            return;
          }

          if (targetClient.roomId !== roomId) {
            ws.send(JSON.stringify({
              type: 'signal-error',
              targetPeerId,
              message: 'Peer is in a different network room.'
            }));
            return;
          }

          if (targetClient.ws.readyState === WebSocket.OPEN) {
            targetClient.ws.send(JSON.stringify({
              type: 'signal',
              fromPeerId: peerId,
              fromDeviceName: clientInfo.deviceName,
              fromDeviceType: clientInfo.deviceType,
              data: message.data
            }));
          }
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        }

        default:
          console.warn(`[BeamDrop] Unknown message type: ${type}`);
      }
    } catch (err) {
      console.error('[BeamDrop] Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    removeClient(peerId);
  });

  ws.on('error', (err) => {
    console.error(`[BeamDrop] WebSocket error on peer ${peerId}:`, err);
    removeClient(peerId);
  });
});

// Periodic heartbeat to detect and sweep dead sockets (every 25 seconds)
const heartbeatInterval = setInterval(() => {
  for (const [peerId, client] of clients.entries()) {
    if (!client.isAlive) {
      console.log(`[BeamDrop] Peer heartbeat timed out: ${peerId}`);
      client.ws.terminate();
      removeClient(peerId);
      continue;
    }
    client.isAlive = false;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.ping();
    }
  }
}, 25000);

server.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Start listening
server.listen(PORT, HOST, () => {
  const protocol = server instanceof https.Server ? 'https' : 'http';
  const networkAddresses = getLocalNetworkAddresses();

  console.log('====================================================');
  console.log(`  BeamDrop Server is running!`);
  console.log(`  Local:    ${protocol}://localhost:${PORT}`);
  for (const net of networkAddresses) {
    console.log(`  Network:  ${protocol}://${net.address}:${PORT} (${net.interface})`);
  }
  console.log(`  Room IP discovery: ON (Private LAN grouped automatically)`);
  console.log(`  WebRTC DataChannel chunk size: ${DEFAULT_CHUNK_SIZE / 1024} KB`);
  console.log('====================================================');
});
