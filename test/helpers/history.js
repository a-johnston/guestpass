import assert from 'node:assert/strict';

/** Shared wire invariants: tool batches are contiguous, paired and uniquely identified. */
export function assertWireHistory(messages) {
  const calls = new Set(), results = new Set(), pending = new Set();
  let previous;
  for (const message of messages) {
    if (message.role === 'tool') {
      assert.ok(pending.delete(message.tool_call_id), `orphan or duplicate result ${message.tool_call_id}`);
      assert.ok(!results.has(message.tool_call_id), `repeated result ${message.tool_call_id}`);
      results.add(message.tool_call_id);
    } else {
      assert.equal(pending.size, 0, 'every tool batch must be answered before the next dialogue message');
      if (message.role === 'user' || message.role === 'assistant') {
        assert.notEqual(previous?.role, message.role, `adjacent ${message.role} messages`);
      }
      for (const call of message.tool_calls || []) {
        assert.ok(!calls.has(call.id), `repeated call ${call.id}`);
        calls.add(call.id);
        pending.add(call.id);
      }
    }
    previous = message;
  }
  assert.equal(pending.size, 0, 'all calls have exactly one result');
  assert.deepEqual([...calls].sort(), [...results].sort());
}
