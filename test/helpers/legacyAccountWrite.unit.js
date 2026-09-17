'use strict';

const chai = require('chai');
const mongoose = require('mongoose');
const { createLegacyAccountWrite } = require('../../api/helpers/legacyAccountWrite');

const expect = chai.expect;
const actorId = '507f1f77bcf86cd799439011';
const ownerId = '507f1f77bcf86cd799439012';

function createHarness(users = []) {
  const calls = [];
  const collection = {
    find(query) {
      calls.push({ op: 'find', query });
      return {
        limit(value) {
          calls.push({ op: 'limit', value });
          return this;
        },
        async toArray() {
          return users.filter(user => user.email === query.email).slice(0, 2);
        }
      };
    },
    async findOne(query, options) {
      calls.push({ op: 'findOne', query, options });
      if (query._id && String(query._id) === actorId) {
        return users.find(user => String(user._id) === actorId) || null;
      }
      return users.find(
        user =>
          String(user._id) === String(query._id) && user.email === query.email
      ) || null;
    }
  };
  return { calls, connection: { collection: () => collection } };
}

function createLifecycle(calls, result = 'callback-result') {
  return {
    async withOpenFamilyAccounts(familyId, accountIds, callback) {
      calls.push({ op: 'lock', familyId, accountIds });
      return callback({ id: 'legacy-session' });
    }
  };
}

describe('legacy account write gate', function() {
  it('is a no-op callback with null session when disabled', async function() {
    const harness = createHarness();
    let received;
    const service = createLegacyAccountWrite({
      connection: harness.connection,
      enabled: () => false
    });
    const result = await service.withLegacyAccountWrite(
      'bad-id',
      [],
      async session => {
        received = session;
        return 'ok';
      }
    );
    expect(result).to.equal('ok');
    expect(received).to.equal(null);
    expect(harness.calls).to.deep.equal([]);
  });

  it('resolves each unique owner email with a limit-two query and locks actor plus owners', async function() {
    const users = [
      { _id: new mongoose.Types.ObjectId(actorId), email: 'actor@example.com' },
      { _id: new mongoose.Types.ObjectId(ownerId), email: 'owner@example.com' }
    ];
    const harness = createHarness(users);
    const calls = [];
    const service = createLegacyAccountWrite({
      connection: harness.connection,
      lifecycle: createLifecycle(calls),
      enabled: () => true
    });
    let callbackSession;
    const result = await service.withLegacyAccountWrite(
      actorId,
      ['owner@example.com', 'owner@example.com'],
      async session => {
        callbackSession = session;
        return 'done';
      }
    );
    expect(result).to.equal('done');
    expect(callbackSession).to.deep.equal({ id: 'legacy-session' });
    expect(calls[0]).to.deep.equal({
      op: 'lock',
      familyId: null,
      accountIds: [actorId, ownerId]
    });
    expect(harness.calls.filter(call => call.op === 'find')).to.have.length(1);
    expect(harness.calls.filter(call => call.op === 'limit')[0].value).to.equal(2);
    expect(harness.calls.filter(call => call.op === 'findOne')).to.have.length(2);
    expect(harness.calls.filter(call => call.op === 'findOne').every(call => call.options.session)).to.equal(true);
  });

  it('rejects invalid actor ids and owner email values before any collection access', async function() {
    const harness = createHarness();
    const service = createLegacyAccountWrite({
      connection: harness.connection,
      enabled: () => true,
      lifecycle: createLifecycle([])
    });
    for (const input of [
      ['not-an-object-id', ['owner@example.com']],
      [actorId, []],
      [actorId, ['']]
    ]) {
      try {
        await service.withLegacyAccountWrite(input[0], input[1], async () => true);
        throw new Error('expected validation failure');
      } catch (error) {
        expect(error.status).to.equal(400);
      }
    }
    expect(harness.calls).to.deep.equal([]);
  });

  it('rejects a missing or ambiguous owner without taking the account lock', async function() {
    for (const users of [
      [],
      [
        { _id: new mongoose.Types.ObjectId(ownerId), email: 'owner@example.com' },
        { _id: new mongoose.Types.ObjectId(actorId), email: 'owner@example.com' }
      ]
    ]) {
      const harness = createHarness(users);
      const calls = [];
      const service = createLegacyAccountWrite({
        connection: harness.connection,
        lifecycle: createLifecycle(calls),
        enabled: () => true
      });
      try {
        await service.withLegacyAccountWrite(actorId, ['owner@example.com'], async () => true);
        throw new Error('expected owner failure');
      } catch (error) {
        expect(error.code).to.equal('LEGACY_OWNER_UNAVAILABLE');
        expect(error.status).to.equal(409);
      }
      expect(calls).to.deep.equal([]);
    }
  });

  it('fails closed when the actor disappears or an owner changes before the lock callback', async function() {
    const users = [
      { _id: new mongoose.Types.ObjectId(ownerId), email: 'owner@example.com' }
    ];
    const harness = createHarness(users);
    const service = createLegacyAccountWrite({
      connection: harness.connection,
      lifecycle: createLifecycle([]),
      enabled: () => true
    });
    try {
      await service.withLegacyAccountWrite(actorId, ['owner@example.com'], async () => true);
      throw new Error('expected actor failure');
    } catch (error) {
      expect(error.code).to.equal('ACCOUNT_UNAVAILABLE');
      expect(error.status).to.equal(409);
    }
  });

  it('rejects an owner whose email changes after the preflight lookup', async function() {
    const users = [
      { _id: new mongoose.Types.ObjectId(actorId), email: 'actor@example.com' },
      { _id: new mongoose.Types.ObjectId(ownerId), email: 'owner@example.com' }
    ];
    const harness = createHarness(users);
    const service = createLegacyAccountWrite({
      connection: harness.connection,
      lifecycle: {
        async withOpenFamilyAccounts(familyId, accountIds, callback) {
          users[1].email = 'changed@example.com';
          return callback({ id: 'legacy-session' });
        }
      },
      enabled: () => true
    });
    try {
      await service.withLegacyAccountWrite(actorId, ['owner@example.com'], async () => true);
      throw new Error('expected owner change failure');
    } catch (error) {
      expect(error.code).to.equal('LEGACY_OWNER_CHANGED');
      expect(error.status).to.equal(409);
    }
  });

  it('propagates lifecycle closure errors and never invokes the callback', async function() {
    const harness = createHarness([
      { _id: new mongoose.Types.ObjectId(ownerId), email: 'owner@example.com' }
    ]);
    const closure = Object.assign(new Error('closing'), {
      code: 'ACCOUNT_CLOSING',
      status: 409
    });
    let callbackCalled = false;
    const service = createLegacyAccountWrite({
      connection: harness.connection,
      lifecycle: {
        async withOpenFamilyAccounts() {
          throw closure;
        }
      },
      enabled: () => true
    });
    try {
      await service.withLegacyAccountWrite(actorId, ['owner@example.com'], async () => {
        callbackCalled = true;
      });
      throw new Error('expected closure failure');
    } catch (error) {
      expect(error).to.equal(closure);
    }
    expect(callbackCalled).to.equal(false);
  });
});
