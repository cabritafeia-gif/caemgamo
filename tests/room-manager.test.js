const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../room-manager');

test('voice room does not impose a fixed participant cap', async () => {
  const sent = [];
  const manager = new RoomManager({ redisUrl: '', send: (client, message) => sent.push({ id: client.id, message }), getIceServers: () => [] });
  const joins = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const client = { id: `participant-${index}`, room: null };
    return { client, result: await manager.joinMemory(client, 'capacity-test') };
  }));
  assert.ok(joins.every((join) => join.result.count >= 1));
  assert.equal(manager.memoryRooms.get('capacity-test').size, 20);
  const additional = await manager.joinMemory({ id: 'participant-21', room: null }, 'capacity-test');
  assert.deepEqual(additional, { count: 21 });
  assert.equal(manager.memoryRooms.get('capacity-test').size, 21);
});

test('two participants exchange WebRTC signaling and leave notifications', async () => {
  const delivered = [];
  const manager = new RoomManager({ send: (client, message) => delivered.push({ id: client.id, message }), getIceServers: () => [] });
  const first = { id: 'participant-a', room: null };
  const second = { id: 'participant-b', room: null };

  assert.deepEqual(await manager.joinMemory(first, 'signaling-test'), { count: 1 });
  assert.deepEqual(await manager.joinMemory(second, 'signaling-test'), { count: 2 });
  assert.equal(delivered.find(({ id, message }) => id === first.id && message.type === 'joined').message.turnAvailable, false);
  assert.ok(delivered.some(({ id, message }) => id === first.id && message.type === 'peer-joined' && message.peerId === second.id && message.initiator));

  const offer = { description: { type: 'offer', sdp: 'test-sdp' } };
  await manager.signal(first, { to: second.id, payload: offer });
  assert.ok(delivered.some(({ id, message }) => id === second.id && message.type === 'signal' && message.from === first.id && message.data.description.sdp === 'test-sdp'));
  const answer = { description: { type: 'answer', sdp: 'test-answer' } };
  await manager.signal(second, { to: first.id, payload: answer });
  assert.ok(delivered.some(({ id, message }) => id === first.id && message.type === 'signal' && message.from === second.id && message.data.description.sdp === 'test-answer'));
  const candidate = { candidate: { candidate: 'candidate:test' } };
  await manager.signal(first, { to: second.id, payload: candidate });
  assert.ok(delivered.some(({ id, message }) => id === second.id && message.type === 'signal' && message.data?.candidate?.candidate === 'candidate:test'));

  await manager.leave(second);
  assert.ok(delivered.some(({ id, message }) => id === first.id && message.type === 'peer-left' && message.peerId === second.id));
  assert.equal(manager.memoryRooms.get('signaling-test').size, 1);
});

test('room signals that authenticated relay credentials are available', async () => {
  const sent = [];
  const manager = new RoomManager({
    send: (client, message) => sent.push(message),
    getIceServers: async () => [
      { urls: 'stun:stun.example.test:3478' },
      { urls: 'turns:turn.example.test:443', username: 'temporary', credential: 'short-lived' }
    ]
  });
  await manager.joinMemory({ id: 'relay-test', room: null }, 'relay-test');
  assert.equal(sent.find((message) => message.type === 'joined').turnAvailable, true);
});
