const ROOM_LIMIT = 15;
const MEMBER_TTL_MS = 90_000;
const HEARTBEAT_TTL_MS = MEMBER_TTL_MS;

const JOIN_SCRIPT = `
  local now = tonumber(ARGV[2])
  local ttl = tonumber(ARGV[3])
  local limit = tonumber(ARGV[4])
  local rows = redis.call('HGETALL', KEYS[1])
  local members = {}
  for i = 1, #rows, 2 do
    if tonumber(rows[i + 1]) and tonumber(rows[i + 1]) > now then
      table.insert(members, rows[i])
    else
      redis.call('HDEL', KEYS[1], rows[i])
    end
  end
  if #members >= limit then return {0, cjson.encode(members)} end
  redis.call('HSET', KEYS[1], ARGV[1], now + ttl)
  redis.call('PEXPIRE', KEYS[1], ttl)
  return {#members + 1, cjson.encode(members)}
`;

const REFRESH_SCRIPT = `
  local ttl = tonumber(ARGV[2])
  redis.call('HSET', KEYS[1], ARGV[1], tonumber(ARGV[3]) + ttl)
  redis.call('PEXPIRE', KEYS[1], ttl)
  return 1
`;

const LEAVE_SCRIPT = `
  redis.call('HDEL', KEYS[1], ARGV[1])
  return redis.call('HLEN', KEYS[1])
`;

class RoomManager {
  constructor({ redisUrl, send, getIceServers, logger = console }) {
    this.redisUrl = redisUrl;
    this.send = send;
    this.getIceServers = getIceServers;
    this.logger = logger;
    this.memoryRooms = new Map();
    this.localRooms = new Map();
    this.roomLocks = new Map();
    this.redis = null;
    this.subscriber = null;
  }

  get isReady() {
    if (!this.redisUrl) return true;
    return Boolean(this.redis?.isReady && this.subscriber?.isReady);
  }

  async connect() {
    if (!this.redisUrl) return;
    const { createClient } = require('redis');
    this.redis = createClient({ url: this.redisUrl });
    this.subscriber = this.redis.duplicate();
    this.redis.on('error', (error) => this.logger.error('Redis command connection:', error.message));
    this.subscriber.on('error', (error) => this.logger.error('Redis subscriber connection:', error.message));
    await Promise.all([this.redis.connect(), this.subscriber.connect()]);
  }

  async join(client, roomName) {
    if (client.room) await this.leave(client);
    if (!this.redisUrl) return this.joinMemory(client, roomName);
    if (!this.isReady) throw new Error('O serviço de salas está reconectando.');

    return this.withRoomLock(roomName, async () => {
      const room = await this.ensureLocalRoom(roomName);
      const roomKey = this.roomKey(roomName);
      let result;
      try {
        result = await this.redis.eval(JOIN_SCRIPT, {
          keys: [roomKey],
          arguments: [client.id, String(Date.now()), String(MEMBER_TTL_MS), String(ROOM_LIMIT)]
        });
      } catch (error) {
        if (room.clients.size === 0) await this.removeLocalRoom(roomName, room);
        throw error;
      }

      const count = Number(result[0]);
      const existing = JSON.parse(result[1] || '[]');
      if (count === 0) {
        if (room.clients.size === 0) await this.removeLocalRoom(roomName, room);
        return { full: true };
      }

      room.clients.set(client.id, client);
      client.room = roomName;
      const iceServers = await this.getIceServers(client.id);
      this.send(client, {
        type: 'joined', room: roomName, clientId: client.id, count,
        participants: existing, iceServers
      });
      if (existing.length) {
        await this.redis.publish(room.channel, JSON.stringify({ type: 'peer-joined', from: client.id }));
      }
      return { full: false };
    });
  }

  async joinMemory(client, roomName) {
    const room = this.memoryRooms.get(roomName) || new Map();
    if (room.size >= ROOM_LIMIT) return { full: true };
    const existing = [...room.values()];
    room.set(client.id, client);
    this.memoryRooms.set(roomName, room);
    client.room = roomName;
    const iceServers = await this.getIceServers(client.id);
    this.send(client, {
      type: 'joined', room: roomName, clientId: client.id, count: room.size,
      participants: existing.map((other) => other.id), iceServers
    });
    for (const other of existing) {
      this.send(other, { type: 'peer-joined', peerId: client.id, initiator: other.id < client.id });
    }
    return { full: false };
  }

  async leave(client) {
    const roomName = client.room;
    if (!roomName) return;
    client.room = null;

    if (!this.redisUrl) {
      const room = this.memoryRooms.get(roomName);
      if (room) {
        room.delete(client.id);
        for (const peer of room.values()) this.send(peer, { type: 'peer-left', peerId: client.id, count: room.size });
        if (room.size === 0) this.memoryRooms.delete(roomName);
      }
      return;
    }

    return this.withRoomLock(roomName, async () => {
      const room = this.localRooms.get(roomName);
      room?.clients.delete(client.id);
      if (this.isReady) {
        try {
          const count = Number(await this.redis.eval(LEAVE_SCRIPT, { keys: [this.roomKey(roomName)], arguments: [client.id] }));
          await this.redis.publish(room?.channel || this.channelName(roomName), JSON.stringify({ type: 'peer-left', from: client.id, count }));
        } catch (error) {
          this.logger.warn('Falha ao remover participante da sala:', error.message);
        }
      }
      if (room && room.clients.size === 0) await this.removeLocalRoom(roomName, room);
    });
  }

  async signal(client, data) {
    if (!client.room) return;
    const targetId = String(data?.to || '');
    const signalData = data?.payload;
    if (!targetId || !signalData || typeof signalData !== 'object' || Array.isArray(signalData)) return;
    if (!this.redisUrl) {
      const room = this.memoryRooms.get(client.room);
      const peer = room?.get(targetId);
      if (peer && peer !== client) this.send(peer, { type: 'signal', from: client.id, data: signalData });
      return;
    }
    if (!this.isReady) throw new Error('O serviço de salas está reconectando.');
    if (!(await this.redis.hExists(this.roomKey(client.room), targetId))) return;
    await this.redis.publish(this.channelName(client.room), JSON.stringify({
      type: 'signal', from: client.id, to: targetId, data: signalData
    }));
  }

  async refresh(client) {
    if (!this.redisUrl || !client.room || !this.isReady) return;
    await this.redis.eval(REFRESH_SCRIPT, {
      keys: [this.roomKey(client.room)],
      arguments: [client.id, String(HEARTBEAT_TTL_MS), String(Date.now())]
    });
  }

  async ensureLocalRoom(roomName) {
    let room = this.localRooms.get(roomName);
    if (room) return room;
    room = { clients: new Map(), channel: this.channelName(roomName) };
    this.localRooms.set(roomName, room);
    try {
      await this.subscriber.subscribe(room.channel, (message) => this.onRoomMessage(roomName, message));
      return room;
    } catch (error) {
      this.localRooms.delete(roomName);
      throw error;
    }
  }

  async removeLocalRoom(roomName, room) {
    if (this.localRooms.get(roomName) !== room) return;
    this.localRooms.delete(roomName);
    try { await this.subscriber.unsubscribe(room.channel); }
    catch (error) { this.logger.warn('Falha ao cancelar inscrição da sala:', error.message); }
  }

  onRoomMessage(roomName, rawMessage) {
    let message;
    try { message = JSON.parse(rawMessage); } catch { return; }
    const room = this.localRooms.get(roomName);
    if (!room) return;
    if (message.type === 'signal') {
      const recipient = room.clients.get(message.to);
      if (recipient && recipient.id !== message.from) this.send(recipient, message);
      return;
    }
    for (const client of room.clients.values()) {
      if (client.id === message.from) continue;
      if (message.type === 'peer-joined') {
        this.send(client, { type: 'peer-joined', peerId: message.from, initiator: client.id < message.from });
      } else if (message.type === 'peer-left') {
        this.send(client, { type: 'peer-left', peerId: message.from, count: message.count });
      }
    }
  }

  roomKey(roomName) { return `caemgamo:room:${roomName}`; }
  channelName(roomName) { return `caemgamo:signal:${roomName}`; }

  async withRoomLock(roomName, action) {
    const previous = this.roomLocks.get(roomName) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.roomLocks.set(roomName, current);
    await previous.catch(() => {});
    try { return await action(); }
    finally {
      release();
      if (this.roomLocks.get(roomName) === current) this.roomLocks.delete(roomName);
    }
  }
}

module.exports = { RoomManager };
