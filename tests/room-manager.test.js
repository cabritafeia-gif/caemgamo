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
