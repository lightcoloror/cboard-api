'use strict';

const { RateLimiterMongo } = require('rate-limiter-flexible');

function transactionConflict(error) {
  const wrapped = new Error('Rate limiter transaction conflict');
  wrapped.code = 'RATE_LIMIT_TRANSACTION_CONFLICT';
  wrapped.cause = error;
  return wrapped;
}

function withMongoSession(limiter, session) {
  if (!(limiter instanceof RateLimiterMongo)) {
    throw new TypeError('A RateLimiterMongo instance is required');
  }
  if (!session || typeof session !== 'object') {
    throw new TypeError('A Mongo session is required');
  }
  if (!limiter._collection || typeof limiter._collection.findOneAndUpdate !== 'function') {
    throw new TypeError('RateLimiterMongo collection is required');
  }
  if (limiter.insuranceLimiter || Number(limiter.inMemoryBlockOnConsumed) > 0) {
    throw new Error('Rate limiter transaction configuration is unsupported');
  }

  const collection = limiter._collection;
  const view = Object.create(limiter);
  view._collection = {
    findOneAndUpdate(filter, update, options = {}) {
      return Promise.resolve()
        .then(() => collection.findOneAndUpdate(filter, update, {
          ...options,
          session
        }))
        .catch(error => {
          if (error && error.code === 11000) throw transactionConflict(error);
          throw error;
        });
    },
    findOne(filter, options = {}) {
      return collection.findOne(filter, { ...options, session });
    },
    deleteOne(filter, options = {}) {
      return collection.deleteOne(filter, { ...options, session });
    }
  };
  return view;
}

module.exports = { withMongoSession };
