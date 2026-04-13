/**
 * DRIFT SERVER v2 — stabilized matchmaking
 */

const WebSocket = require('ws');
const http = require('http');

const PORT = parseInt(process.env.PORT) || 3000;
const MATCH_TIMEOUT = parseInt(process.env.MATCH_TIMEOUT) || 30;

const PING_INTERVAL = 30000;
const PING_MAX_MISSES = 3;

// ─── State ───────────────────────────────

const clients = new Map();   // ws -> data
const queue = new Set();     // prevents duplicates
const pairs = new Map();     // ws -> ws

let totalConnections = 0;
let totalMatches = 0;

// ─── Helpers ─────────────────────────────

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(data) {
  for (const ws of clients.keys()) {
    send(ws, data);
  }
}

function removeFromQueue(ws) {
  queue.delete(ws);
}

function unpair(ws) {
  const partner = pairs.get(ws);

  if (partner) {
    pairs.delete(partner);
    pairs.delete(ws);

    const pd = clients.get(partner);
    if (pd) pd.partnerId = null;

    send(partner, { event: 'peer_left' });
  }

  const cd = clients.get(ws);
  if (cd) cd.partnerId = null;
}

function interestScore(a = [], b = []) {
  let score = 0;
  for (const x of a) if (b.includes(x)) score++;
  return score;
}

function commonInterests(a = [], b = []) {
  return a.filter(x => b.includes(x));
}

// ─── Matching ────────────────────────────

function tryMatch() {
  const list = [...queue];

  if (list.length < 2) return;

  let bestA = null;
  let bestB = null;
  let bestScore = -1;

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = clients.get(list[i]);
      const B = clients.get(list[j]);

      if (!A || !B) continue;
      if (A.chatType !== B.chatType) continue;

      const score = interestScore(A.interests, B.interests);

      if (score > bestScore) {
        bestScore = score;
        bestA = list[i];
        bestB = list[j];
      }
    }
  }

  if (!bestA || !bestB) return;

  queue.delete(bestA);
  queue.delete(bestB);

  const A = clients.get(bestA);
  const B = clients.get(bestB);

  if (!A || !B) return;

  const connId = Math.random().toString(36).slice(2, 10);

  pairs.set(bestA, bestB);
  pairs.set(bestB, bestA);

  A.partnerId = connId;
  B.partnerId = connId;

  totalMatches++;

  const shared = commonInterests(A.interests, B.interests);

  send(bestA, {
    event: 'matched',
    offerer: true,
    connId,
    shared,
    chatType: A.chatType
  });

  send(bestB, {
    event: 'matched',
    offerer: false,
    connId,
    shared,
    chatType: B.chatType
  });

  console.log(`[match] ${connId} | shared=${shared.join(',')}`);
}

// ─── HTTP ────────────────────────────────

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  res.end(JSON.stringify({
    online: clients.size,
    queue: queue.size,
    pairs: pairs.size / 2,
    totalConnections,
    totalMatches
  }, null, 2));
});

// ─── WebSocket Server ────────────────────

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  totalConnections++;

  const ip =
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket.remoteAddress;

  clients.set(ws, {
    ip,
    interests: [],
    chatType: 'text',
    partnerId: null,
    alive: true,
    misses: 0,
    connectedAt: Date.now()
  });

  console.log(`[+] connected ${ip} (${clients.size})`);

  // ── HEARTBEAT ──
  const pingTimer = setInterval(() => {
    const c = clients.get(ws);
    if (!c) return;

    if (c.misses >= PING_MAX_MISSES) {
      console.log(`[timeout] ${ip}`);
      ws.terminate();
      return;
    }

    c.misses++;
    ws.ping();
  }, PING_INTERVAL);

  ws.on('pong', () => {
    const c = clients.get(ws);
    if (c) c.misses = 0;
  });

  // ── MESSAGE ──
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const client = clients.get(ws);
    if (!client) return;

    switch (msg.event) {

      case 'search': {
        unpair(ws);
        removeFromQueue(ws);

        client.interests = (msg.interests || [])
          .map(x => x.toLowerCase().trim())
          .filter(Boolean)
          .slice(0, 20);

        client.chatType = msg.chatType === 'video' ? 'video' : 'text';

        queue.add(ws);

        send(ws, {
          event: 'searching',
          position: queue.size
        });

        tryMatch();
        break;
      }

      case 'stop': {
        unpair(ws);
        removeFromQueue(ws);
        break;
      }

      case 'skip': {
        unpair(ws);
        removeFromQueue(ws);
        queue.add(ws);
        tryMatch();
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice':
      case 'message':
      case 'gif':
      case 'typing':
      case 'stop_typing': {
        const partner = pairs.get(ws);
        if (partner) send(partner, msg);
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(pingTimer);

    unpair(ws);
    removeFromQueue(ws);
    clients.delete(ws);

    console.log(`[-] disconnected ${ip} (${clients.size})`);
  });

  ws.on('error', (err) => {
    console.log(`[err] ${ip}`, err.message);
  });
});

// ─── START ──────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\nDRIFT v2 running on ${PORT}\n`);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  broadcast({ event: 'server_shutdown' });
  process.exit(0);
});
