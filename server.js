const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RoomManager } = require('./room-manager');

const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const MAX_FRAME_BYTES = 1024 * 1024;
const DIRECT_ROOM_PATTERN = /^direct-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const clients = new Map();
const rateBuckets = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const roomManager = new RoomManager({
  redisUrl: process.env.REDIS_URL,
  send,
  getIceServers,
  logger: console
});
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self' https: wss:; media-src 'self' https: blob:; font-src 'self' https: data:; worker-src 'self' blob:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'Permissions-Policy': 'microphone=(self), camera=(self), display-capture=(self)'
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Caminho inválido'); return; }
  if (pathname === '/config.json') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }).end(JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || ''
    }));
    return;
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end('{"status":"alive"}');
    return;
  }
  if (pathname === '/readyz') {
    const ready = roomManager.isReady;
    const turnProvider = getTurnProvider();
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(JSON.stringify({ status: ready ? 'ready' : 'not-ready', backend: process.env.REDIS_URL ? 'redis' : 'memory', turn: turnProvider }));
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
    res.writeHead(200, { ...SECURITY_HEADERS, 'Cache-Control': 'no-cache', 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
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
  const client = { id: crypto.randomBytes(16).toString('base64url'), socket, room: null, ip, buffer: Buffer.alloc(0), closed: false, awaitingPong: false, lastPing: 0, signalWindow: 0, signalCount: 0, userId: null, authAccessToken: '', authVerifiedAt: 0, voiceChannelId: null, directConversationId: null };
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

async function getIceServers(clientId) {
  const urls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((value) => value.trim()).filter(Boolean);
  const iceServers = urls.map((url) => ({ urls: url }));

  const cloudflareKeyId = (process.env.CLOUDFLARE_TURN_KEY_ID || '').trim();
  const cloudflareKeyToken = (process.env.CLOUDFLARE_TURN_KEY_TOKEN || '').trim();
  if (cloudflareKeyId || cloudflareKeyToken) {
    if (!cloudflareKeyId || !cloudflareKeyToken) {
      console.warn('Cloudflare TURN está incompleto; esta sala usará somente STUN.');
      return iceServers;
    }

    const configuredTtl = Number(process.env.CLOUDFLARE_TURN_TTL_SECONDS || 172_800);
    const ttl = Number.isFinite(configuredTtl) ? Math.max(300, Math.min(configuredTtl, 172_800)) : 172_800;
    const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cloudflareKeyId)}/credentials/generate-ice-servers`;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cloudflareKeyToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ttl }),
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) {
        console.warn(`Cloudflare TURN respondeu HTTP ${response.status}; esta sala usará somente STUN.`);
        return iceServers;
      }

      const payload = await response.json();
      const turnServers = Array.isArray(payload?.iceServers) ? payload.iceServers.filter((entry) => {
        const serverUrls = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
        return typeof entry?.username === 'string' && typeof entry?.credential === 'string' &&
          serverUrls.some((url) => typeof url === 'string' && /^turns?:/i.test(url));
      }) : [];
      if (!turnServers.length) {
        console.warn('Cloudflare TURN não retornou servidores TURN válidos; esta sala usará somente STUN.');
        return iceServers;
      }
      return [...iceServers, ...turnServers];
    } catch {
      console.warn('Não foi possível obter credenciais TURN da Cloudflare; esta sala usará somente STUN.');
      return iceServers;
    }
  }

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

function getTurnProvider() {
  if (process.env.CLOUDFLARE_TURN_KEY_ID?.trim() && process.env.CLOUDFLARE_TURN_KEY_TOKEN?.trim()) return 'cloudflare-configured';
  if ((process.env.TURN_URLS || '').split(',').some((value) => value.trim()) && process.env.TURN_SHARED_SECRET) return 'coturn-configured';
  return 'stun-only';
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
    if (!takeRate(`join:${client.ip}`, 30, 60_000)) { send(client, { type: 'error', message: 'Muitas tentativas. Aguarde um minuto e tente novamente.' }); return; }
    const roomName = String(message.room || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64);
    if (!roomName) { send(client, { type: 'error', message: 'Código de sala inválido.' }); return; }
    const channelId = String(message.channelId || '');
    const uuidRoom = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomName);
    if ((uuidRoom && channelId !== roomName) || (channelId && channelId !== roomName) ||
        (roomName.startsWith('direct-') && !DIRECT_ROOM_PATTERN.test(roomName))) {
      send(client, { type: 'error', message: 'Canal de voz inválido.' });
      return;
    }
    const authorization = await authorizeRoomJoin(roomName, channelId, message.accessToken);
    if (!authorization.user) {
      send(client, { type: 'error', message: authorization.error });
      if (authorization.authenticationRequired) client.socket.end();
      return;
    }
    if (authorization.error) { send(client, { type: 'error', message: authorization.error }); return; }
    client.voiceChannelId = null;
    client.directConversationId = null;
    client.authAccessToken = message.accessToken;
    client.authVerifiedAt = Date.now();
    client.userId = authorization.user.id;
    client.voiceChannelId = authorization.voiceChannelId;
    client.directConversationId = authorization.directConversationId;
    try { await roomManager.join(client, roomName); }
    catch (error) { await roomManager.leave(client); throw error; }
    return;
  }
  if ((message.type === 'auth-refresh' || message.type === 'voice-auth-refresh') && client.room) {
    if (!takeRate(`auth-refresh:${client.id}`, 6, 60_000)) { client.socket.destroy(); return; }
    const accessToken = message.accessToken;
    const user = await getSupabaseUser(accessToken);
    if (!user || user.id !== client.userId) {
      send(client, { type: 'error', message: 'Sua sessão expirou. Entre novamente na sua conta.' });
      client.socket.destroy();
      return;
    }
    if (client.voiceChannelId && (String(message.channelId || '') !== client.voiceChannelId || !(await canJoinVoiceChannel(client.voiceChannelId, accessToken)))) {
      send(client, { type: 'error', message: 'Seu acesso ao canal de voz foi encerrado.' });
      client.socket.destroy();
      return;
    }
    if (client.directConversationId && !(await canJoinDirectConversation(client.directConversationId, accessToken))) {
      send(client, { type: 'error', message: 'O acesso à chamada direta foi encerrado.' });
      client.socket.destroy();
      return;
    }
    client.authAccessToken = accessToken;
    client.authVerifiedAt = Date.now();
    return;
  }
  if (message.type === 'signal' && client.room) {
    const now = Date.now();
    if (now - client.signalWindow >= 10_000) { client.signalWindow = now; client.signalCount = 0; }
    client.signalCount++;
    if (client.signalCount > 800) { client.socket.destroy(); return; }
    if (!message.data || typeof message.data !== 'object' || Array.isArray(message.data)) return;
    await roomManager.signal(client, message.data);
  }
}

async function canJoinVoiceChannel(channelId, accessToken) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(channelId) ||
      typeof accessToken !== 'string' || accessToken.length < 40 || accessToken.length > 8192 ||
      !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return false;
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/can_join_voice_channel`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_channel_id: channelId }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return false;
    return (await response.json()) === true;
  } catch { return false; }
}

async function getSupabaseUser(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length < 40 || accessToken.length > 8192 ||
      !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const user = await response.json();
    return typeof user?.id === 'string' && user.id ? user : null;
  } catch { return null; }
}

async function authorizeRoomJoin(roomName, channelId, accessToken) {
  const user = await getSupabaseUser(accessToken);
  if (!user) return { user: null, error: 'Entre na sua conta CAEMGAMO antes de entrar em uma sala.', authenticationRequired: true };
  if (channelId) {
    if (!(await canJoinVoiceChannel(channelId, accessToken))) {
      return { user, error: 'Você precisa entrar na comunidade e ter acesso a este canal de voz.' };
    }
    return { user, voiceChannelId: channelId, directConversationId: null };
  }
  const directRoom = DIRECT_ROOM_PATTERN.exec(roomName);
  if (directRoom) {
    if (!(await canJoinDirectConversation(directRoom[1], accessToken))) {
      return { user, error: 'Esta chamada exige uma amizade e uma conversa direta ativas.' };
    }
    return { user, voiceChannelId: null, directConversationId: directRoom[1] };
  }
  return { user, voiceChannelId: null, directConversationId: null };
}

async function canJoinDirectConversation(conversationId, accessToken) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(conversationId) ||
      typeof accessToken !== 'string' || accessToken.length < 40 || accessToken.length > 8192 ||
      !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return false;
  try {
    const response = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/can_access_direct_conversation`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_conversation_id: conversationId }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return false;
    return (await response.json()) === true;
  } catch { return false; }
}

setInterval(() => {
  const now = Date.now();
  for (const client of clients.values()) {
    if (client.awaitingPong && now - client.lastPing > 55_000) { client.socket.destroy(); continue; }
    client.awaitingPong = true;
    client.lastPing = now;
    sendFrame(client, 9);
    roomManager.refresh(client).catch((error) => console.warn('Falha ao renovar participante da sala:', error.message));
    if (client.room && now - client.authVerifiedAt > 90_000) {
      send(client, { type: 'error', message: 'A sessão da sala expirou. Entre novamente para continuar.' });
      client.socket.destroy();
      continue;
    }
    if (client.room && client.authAccessToken && (client.voiceChannelId || client.directConversationId)) {
      const accessCheck = client.voiceChannelId
        ? canJoinVoiceChannel(client.voiceChannelId, client.authAccessToken)
        : canJoinDirectConversation(client.directConversationId, client.authAccessToken);
      accessCheck.then((allowed) => {
        if (!allowed && !client.closed) {
          send(client, { type: 'error', message: client.voiceChannelId ? 'Seu acesso ao canal de voz foi encerrado.' : 'O acesso à chamada direta foi encerrado.' });
          client.socket.destroy();
        }
      }).catch(() => {
        if (!client.closed) client.socket.destroy();
      });
    }
  }
  if (rateBuckets.size > 5000) {
    for (const [key, bucket] of rateBuckets) if (now - bucket.startedAt > 120_000) rateBuckets.delete(key);
  }
}, 25_000).unref();

async function start() {
  await roomManager.connect();
  server.listen(PORT, '0.0.0.0', () => console.log(`CAEMGAMO disponível na porta ${PORT}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Não foi possível iniciar o CAEMGAMO:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { server, start, canJoinVoiceChannel, canJoinDirectConversation, getSupabaseUser, authorizeRoomJoin, getIceServers, getTurnProvider, originAllowed, takeRate };
