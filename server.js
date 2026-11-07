const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RoomManager } = require('./room-manager');

const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const MAX_FRAME_BYTES = 1024 * 1024;
const clients = new Map();
const rateBuckets = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const roomManager = new RoomManager({
  redisUrl: process.env.REDIS_URL,
  send,
  getIceServers,
  logger: console
});

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end('{"status":"alive"}');
    return;
  }
  if (pathname === '/readyz') {
    const ready = roomManager.isReady;
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ status: ready ? 'ready' : 'not-ready', backend: process.env.REDIS_URL ? 'redis' : 'memory' }));
    return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(ROOT, `.${requested}`);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Não encontrado');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const ip = clientIp(req);
  const connectionHeader = String(req.headers.connection || '').toLowerCase();
  if (new URL(req.url, 'http://localhost').pathname !== '/ws' ||
      String(req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
      !connectionHeader.split(',').map((value) => value.trim()).includes('upgrade') ||
      req.headers['sec-websocket-version'] !== '13' ||
      !req.headers['sec-websocket-key'] || !originAllowed(req)) {
    socket.destroy();
    return;
  }
  if (!takeRate(`connect:${ip}`, 30, 60_000)) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const client = { id: crypto.randomBytes(16).toString('base64url'), socket, room: null, ip, buffer: Buffer.alloc(0), closed: false, awaitingPong: false, lastPing: 0, signalWindow: 0, signalCount: 0 };
  clients.set(client.id, client);
  socket.on('data', (chunk) => consume(client, chunk));
  socket.on('close', () => disconnect(client));
  socket.on('error', () => disconnect(client));
});

function sendFrame(client, opcode, payload = Buffer.alloc(0)) {
  if (client.closed || client.socket.destroyed) return;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  client.socket.write(Buffer.concat([header, body]));
}

function send(client, value) { sendFrame(client, 1, JSON.stringify(value)); }

function getIceServers(clientId) {
  const urls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((value) => value.trim()).filter(Boolean);
  const iceServers = urls.map((url) => ({ urls: url }));
  const turnUrls = (process.env.TURN_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
  const sharedSecret = process.env.TURN_SHARED_SECRET;
  if (turnUrls.length && sharedSecret) {
    const configuredLifetime = Number(process.env.TURN_TTL_SECONDS || 3600);
    const lifetime = Number.isFinite(configuredLifetime) ? Math.max(300, Math.min(configuredLifetime, 86_400)) : 3600;
    const username = `${Math.floor(Date.now() / 1000) + lifetime}:${clientId}`;
    const credential = crypto.createHmac('sha1', sharedSecret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }
  return iceServers;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return process.env.ALLOW_MISSING_WS_ORIGIN === 'true';
  const configured = (process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (configured.length) return configured.includes(origin);
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch { return false; }
}

function clientIp(req) {
  if (process.env.TRUST_PROXY_HEADERS === 'true' && req.headers['x-forwarded-for']) {
    const forwarded = String(req.headers['x-forwarded-for']).split(',').map((value) => value.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[forwarded.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function takeRate(key, limit, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= windowMs) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

async function disconnect(client) {
  if (client.closed) return;
  client.closed = true;
  clients.delete(client.id);
  try { await roomManager.leave(client); }
  catch (error) { console.warn('Falha ao sair da sala:', error.message); }
}

function consume(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk]);
  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (client.buffer.length < 4) return;
      length = client.buffer.readUInt16BE(2); offset = 4;
    } else if (length === 127) {
      if (client.buffer.length < 10) return;
      const big = client.buffer.readBigUInt64BE(2);
      if (big > 1048576n) { client.socket.destroy(); return; }
      length = Number(big); offset = 10;
    }
    const masked = Boolean(second & 0x80);
    if (!masked) { client.socket.destroy(); return; }
    const maskBytes = masked ? 4 : 0;
    if (length > MAX_FRAME_BYTES) { client.socket.destroy(); return; }
    if (client.buffer.length < offset + maskBytes + length) return;
    let payload = client.buffer.subarray(offset + maskBytes, offset + maskBytes + length);
    if (masked) {
      payload = Buffer.from(payload);
      const mask = client.buffer.subarray(offset, offset + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    client.buffer = client.buffer.subarray(offset + maskBytes + length);
    if (opcode === 8) { sendFrame(client, 8); client.socket.end(); return; }
    if (opcode === 9) { sendFrame(client, 10, payload); continue; }
    if (opcode === 10) { client.awaitingPong = false; continue; }
    if (opcode !== 1) continue;
    try { handleMessage(client, JSON.parse(payload.toString('utf8'))).catch((error) => {
      console.warn('Falha ao processar mensagem:', error.message);
      if (!client.closed) send(client, { type: 'error', message: 'A sala está reconectando. Tente novamente em instantes.' });
    }); }
    catch { send(client, { type: 'error', message: 'Mensagem inválida.' }); }
  }
}

async function handleMessage(client, message) {
  if (message.type === 'join') {
    if (!takeRate(`join:${client.ip}`, 12, 60_000)) { send(client, { type: 'error', message: 'Muitas tentativas. Aguarde um minuto e tente novamente.' }); return; }
    const roomName = String(message.room || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    if (!roomName) { send(client, { type: 'error', message: 'Código de sala inválido.' }); return; }
    let result;
    try { result = await roomManager.join(client, roomName); }
    catch (error) { await roomManager.leave(client); throw error; }
    if (result.full) send(client, { type: 'full' });
    return;
  }
  if (message.type === 'signal' && client.room) {
    const now = Date.now();
    if (now - client.signalWindow >= 10_000) { client.signalWindow = now; client.signalCount = 0; }
    client.signalCount++;
    if (client.signalCount > 120) { client.socket.destroy(); return; }
    if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) return;
    await roomManager.signal(client, message.data);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const client of clients.values()) {
    if (client.awaitingPong && now - client.lastPing > 55_000) { client.socket.destroy(); continue; }
    client.awaitingPong = true;
    client.lastPing = now;
    sendFrame(client, 9);
    roomManager.refresh(client).catch((error) => console.warn('Falha ao renovar participante da sala:', error.message));
  }
  if (rateBuckets.size > 5000) {
    for (const [key, bucket] of rateBuckets) if (now - bucket.startedAt > 120_000) rateBuckets.delete(key);
  }
}, 25_000).unref();

async function start() {
  await roomManager.connect();
  server.listen(PORT, '0.0.0.0', () => console.log(`CAEMGAMO disponível na porta ${PORT}`));
}

start().catch((error) => {
  console.error('Não foi possível iniciar o CAEMGAMO:', error.message);
  process.exitCode = 1;
});
