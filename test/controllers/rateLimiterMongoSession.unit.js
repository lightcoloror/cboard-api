'use strict';

const chai = require('chai');
const { RateLimiterMongo } = require('rate-limiter-flexible');
const { withMongoSession } = require('../../api/helpers/rateLimiterMongoSession');

const expect = chai.expect;

function createLimiter(collection, options = {}) {
  return new RateLimiterMongo({
    storeClient: { collection: () => collection },
    keyPrefix: 'test',
    tableName: 'test-limits',
    points: 100,
    duration: 60,
    disableIndexesCreation: true,
    ...options
  });
}

describe('RateLimiterMongo transaction session adapter', function() {
  it('passes the session to consume, get, and delete without mutating the limiter', async function() {
    const calls = [];
    const collection = {
      findOneAndUpdate(filter, update, options) {
        calls.push({ op: 'findOneAndUpdate', filter, update, options });
        return Promise.resolve({ value: { key: filter.key, points: 2, expire: null } });
      },
      findOne(filter, options) {
        calls.push({ op: 'findOne', filter, options });
        return Promise.resolve({ key: filter.key, points: 2, expire: null });
      },
      deleteOne(filter, options) {
        calls.push({ op: 'deleteOne', filter, options });
        return Promise.resolve({ deletedCount: 1 });
      }
    };
    const limiter = createLimiter(collection);
    const originalCollection = limiter._collection;
    const session = { id: 'session-a' };
    const view = withMongoSession(limiter, session);
    await view.consume('key', 2);
    await view.get('key');
    await view.delete('key');
    expect(view).not.to.equal(limiter);
    expect(limiter._collection).to.equal(originalCollection);
    expect(calls).to.have.length(3);
    expect(calls.every(call => call.options.session === session)).to.equal(true);
  });

  it('keeps separate session views isolated', async function() {
    const calls = [];
    const collection = {
      findOneAndUpdate(filter, update, options) {
        calls.push(options.session);
        return Promise.resolve({ value: { key: filter.key, points: 1, expire: null } });
      }
    };
    const limiter = createLimiter(collection);
    const first = { id: 'first' };
    const second = { id: 'second' };
    await withMongoSession(limiter, first).consume('key', 1);
    await withMongoSession(limiter, second).consume('key', 1);
    expect(calls).to.deep.equal([first, second]);
  });

  it('turns duplicate key into a transaction conflict and prevents fallback writes', async function() {
    let writes = 0;
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
    const collection = {
      findOneAndUpdate() {
        writes += 1;
        return Promise.reject(duplicate);
      }
    };
    const limiter = createLimiter(collection);
    try {
      await withMongoSession(limiter, { id: 'session' }).consume('key', 1);
      throw new Error('expected conflict');
    } catch (error) {
      expect(error.code).to.equal('RATE_LIMIT_TRANSACTION_CONFLICT');
      expect(error.cause).to.equal(duplicate);
    }
    expect(writes).to.equal(1);
  });

  it('preserves non-duplicate and transient errors', async function() {
    const transient = Object.assign(new Error('transient'), { errorLabels: ['TransientTransactionError'] });
    const collection = {
      findOneAndUpdate() { return Promise.reject(transient); }
    };
    try {
      await withMongoSession(createLimiter(collection), { id: 'session' }).consume('key', 1);
      throw new Error('expected transient error');
    } catch (error) {
      expect(error).to.equal(transient);
      expect(error.errorLabels).to.deep.equal(['TransientTransactionError']);
    }
  });

  it('fails closed for unsupported limiter configuration', function() {
    const collection = { findOneAndUpdate() {} };
    expect(() => withMongoSession(createLimiter(collection, { inMemoryBlockOnConsumed: 1 }), {})).to.throw();
    expect(() => withMongoSession(createLimiter(collection, { insuranceLimiter: createLimiter(collection) }), {})).to.throw();
    expect(() => withMongoSession({}, {})).to.throw();
    expect(() => withMongoSession(createLimiter(collection), null)).to.throw();
  });
});
