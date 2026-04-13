/**
 * ──────────────────────────────────────────
 *  DRIFT — Random Chat Server
 *  https://github.com/yourname/drift
 * ──────────────────────────────────────────
 *
 * SETUP:
 *   npm install ws
 *   node drift-server.js
 *
 * OPTIONS (env vars):
 *   PORT=3000         WebSocket port  (default: 3000)
 *   MATCH_TIMEOUT=30  Seconds before solo match (default: 30)
 *
 * STATS:
 *   GET http://localhost:3000/ → JSON stats
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = parseInt(process.env.PORT) || 3000;
const MATCH_TIMEOUT = parseInt(process.env.MATCH_TIMEOUT) || 30;
const PING_INTERVAL = 25000;

// ─── State ───────────────────────────────────────────────────────────────────

const clients = new Map();   // ws → ClientData
const queue   = [];          // ws[] waiting to be matched
const pairs   = new Map();   // ws → partner ws

let totalConnections = 0;
let totalMatches = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch (_) {}
  }
}

function broadcast(payload) {
  wss.clients.forEach(ws => send(ws, payload));
}

function interestScore(a, b) {
  if (!a?.length || !b?.length) return 0;
  return a.filter(x => b.includes(x)).length;
}

function commonInterests(a, b) {
  if (!a?.length || !b?.length) return [];
  return a.filter(x => b.includes(x));
}

function removeFromQueue(ws) {
  const idx = queue.indexOf(ws);
  if (idx !== -1) queue.splice(idx, 1);
}

function unpair(ws) {
  const partner = pairs.get(ws);
  if (partner) {
    send(partner, { event: 'peer_left' });
    const pd = clients.get(partner);
    if (pd) { pd.partnerId = null; }
    pairs.delete(partner);
  }
  pairs.delete(ws);
  const cd = clients.get(ws);
  if (cd) { cd.partnerId = null; }
}

function tryMatch() {
  // Need at least 2 users
  while (queue.length >= 2) {
    // Find best interest overlap in first N candidates
    const window = Math.min(queue.length, 12);
    let bestI = 0, bestJ = 1, bestScore = -1;

    for (let i = 0; i < window; i++) {
      for (let j = i + 1; j < window; j++) {
        const ci = clients.get(queue[i]);
        const cj = clients.get(queue[j]);
        if (!ci || !cj) continue;
        // Must match on chat type
        if (ci.chatType !== cj.chatType) continue;
        const score = interestScore(ci.interests, cj.interests);
        if (score > bestScore) {
          bestScore = score;
          bestI = i;
          bestJ = j;
        }
      }
    }

    // If no type-compatible pair, try any pair
    let wsA, wsB;
    const wsCandA = queue[bestI];
    const wsCandB = queue[bestJ];
    const cA = clients.get(wsCandA);
    const cB = clients.get(wsCandB);

    if (!cA || !cB) {
      // Stale entries — clean up
      removeFromQueue(wsCandA);
      removeFromQueue(wsCandB);
      continue;
    }

    // Remove from queue (higher index first to avoid index shifting)
    if (bestI < bestJ) {
      queue.splice(bestJ, 1);
      queue.splice(bestI, 1);
    } else {
      queue.splice(bestI, 1);
      queue.splice(bestJ, 1);
    }
    wsA = wsCandA;
    wsB = wsCandB;

    // Link them
    pairs.set(wsA, wsB);
    pairs.set(wsB, wsA);
    const connId = Math.random().toString(36).slice(2, 10);
    cA.partnerId = connId;
    cB.partnerId = connId;
    totalMatches++;

    const shared = commonInterests(cA.interests, cB.interests);

    // A makes the offer
    send(wsA, { event: 'matched', offerer: true,  connId, shared, chatType: cA.chatType });
    send(wsB, { event: 'matched', offerer: false, connId, shared, chatType: cB.chatType });

    console.log(`[match] ${connId} | type=${cA.chatType} | shared=[${shared.join(',')}] | total=${totalMatches}`);
  }
}

// ─── HTTP server (stats endpoint + CORS for local dev) ───────────────────────

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const stats = {
    name: 'Drift Server',
    version: '1.0.0',
    uptime: process.uptime(),
    online: clients.size,
    searching: queue.length,
    activePairs: pairs.size / 2,
    totalConnections,
    totalMatches,
  };

  res.writeHead(200);
  res.end(JSON.stringify(stats, null, 2));
});

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  totalConnections++;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  clients.set(ws, {
    ip,
    interests: [],
    chatType:  'text',
    partnerId: null,
    alive:     true,
    connectedAt: Date.now(),
  });

  console.log(`[+] ${ip} connected (${clients.size} total)`);

  // ── Ping/pong to detect dead connections
  const pingTimer = setInterval(() => {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    ws.ping();
  }, PING_INTERVAL);

  ws.on('pong', () => { ws.alive = true; });

  // ── Message handler
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const client = clients.get(ws);
    if (!client) return;

    switch (msg.event) {

      // Client wants to search for a match
      case 'search': {
        unpair(ws);
        removeFromQueue(ws);
        client.interests = (msg.interests || [])
          .map(s => s.toLowerCase().trim())
          .filter(Boolean)
          .slice(0, 20);
        client.chatType = msg.chatType === 'video' ? 'video' : 'text';
        queue.push(ws);
        send(ws, { event: 'searching', position: queue.length });
        console.log(`[search] ${ip} | type=${client.chatType} | queue=${queue.length}`);
        tryMatch();
        break;
      }

      // Client stops searching / leaves chat
      case 'stop': {
        unpair(ws);
        removeFromQueue(ws);
        send(ws, { event: 'stopped' });
        break;
      }

      // Client skips current partner and searches again
      case 'skip': {
        unpair(ws);
        removeFromQueue(ws);
        queue.push(ws);
        send(ws, { event: 'searching', position: queue.length });
        tryMatch();
        break;
      }

      // WebRTC signaling — relay to partner
      case 'offer':
      case 'answer':
      case 'ice': {
        const partner = pairs.get(ws);
        if (partner) send(partner, msg);
        break;
      }

      // Chat messages / media — relay to partner
      case 'message':
      case 'gif':
      case 'typing':
      case 'stop_typing': {
        const partner = pairs.get(ws);
        if (partner) send(partner, msg);
        break;
      }

      // Heartbeat ack
      case 'ping': {
        send(ws, { event: 'pong' });
        break;
      }

      default:
        break;
    }
  });

  // ── Disconnect handler
  ws.on('close', () => {
    clearInterval(pingTimer);
    unpair(ws);
    removeFromQueue(ws);
    clients.delete(ws);
    console.log(`[-] ${ip} disconnected (${clients.size} total)`);
  });

  ws.on('error', (err) => {
    console.error(`[err] ${ip}:`, err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log('');
  console.log('  🌊  DRIFT SERVER');
  console.log('  ─────────────────');
  console.log(`  Port   : ${PORT}`);
  console.log(`  Stats  : http://localhost:${PORT}/`);
  console.log(`  WS     : ws://localhost:${PORT}/`);
  console.log('');
  console.log('  Open drift.html in a browser to connect.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  broadcast({ event: 'server_shutdown', message: 'Server is restarting. Please reconnect.' });
  process.exit(0);
});
