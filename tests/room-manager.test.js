const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../room-manager');

test('voice room accepts at most 15 participants', () => {
  const sent = [];
  const manager = new RoomManager({ redisUrl: '', send: (client, message) => sent.push({ id: client.id, message }), getIceServers: () => [] });
  const joins = Array.from({ length: 15 }, (_, index) => {
    const client = { id: `participant-${index}`, room: null };
    return { client, result: manager.joinMemory(client, 'capacity-test') };
  });
  assert.ok(joins.every((join) => !join.result.full));
  assert.equal(manager.memoryRooms.get('capacity-test').size, 15);
  const overflow = manager.joinMemory({ id: 'participant-16', room: null }, 'capacity-test');
  assert.deepEqual(overflow, { full: true });
});

test('two participants exchange WebRTC signaling and leave notifications', async () => {
  const delivered = [];
  const manager = new RoomManager({ send: (client, message) => delivered.push({ id: client.id, message }), getIceServers: () => [] });
  const first = { id: 'participant-a', room: null };
  const second = { id: 'participant-b', room: null };

  assert.deepEqual(manager.joinMemory(first, 'signaling-test'), { full: false });
  assert.deepEqual(manager.joinMemory(second, 'signaling-test'), { full: false });
  assert.ok(delivered.some(({ id, message }) => id === first.id && message.type === 'peer-joined' && message.peerId === second.id));

  const offer = { description: { type: 'offer', sdp: 'test-sdp' } };
  await manager.signal(first, { to: second.id, payload: offer });
  assert.ok(delivered.some(({ id, message }) => id === second.id && message.type === 'signal' && message.from === first.id && message.data.description.sdp === 'test-sdp'));

  await manager.leave(second);
  assert.ok(delivered.some(({ id, message }) => id === first.id && message.type === 'peer-left' && message.peerId === second.id));
  assert.equal(manager.memoryRooms.get('signaling-test').size, 1);
});
