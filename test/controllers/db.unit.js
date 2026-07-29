'use strict';

const EventEmitter = require('events');
const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('Database communication index startup', function() {
  it('initializes indexes after connect and invalidates readiness after disconnect', async function() {
    const connection = new EventEmitter();
    connection.close = callback => callback();
    let connectOptions;
    let seedCalls = 0;
    let ensureCalls = 0;
    let pendingCalls = 0;
    const originalSigintListeners = process.listeners('SIGINT');

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('mongoose', {
      connect(url, options) {
        connectOptions = { url, options };
      },
      connection
    });
    mockery.registerMock('./config', {
      databaseUrl: 'mongodb://example/cboard',
      env: 'test'
    });
    mockery.registerMock('./seeds', () => {
      seedCalls += 1;
    });
    mockery.registerMock('./api/helpers/communicationIndexes', {
      ensureCommunicationIndexes: async () => {
        ensureCalls += 1;
      },
      markCommunicationIndexesPending: () => {
        pendingCalls += 1;
      }
    });

    try {
      const database = require('../../db');

      expect(database).to.equal(connection);
      expect(connectOptions).to.deep.equal({
        url: 'mongodb://example/cboard',
        options: {
          useNewUrlParser: true,
          useFindAndModify: false
        }
      });

      connection.emit('connected');
      await new Promise(resolve => setImmediate(resolve));
      expect(seedCalls).to.equal(1);
      expect(ensureCalls).to.equal(1);

      connection.emit('disconnected');
      expect(pendingCalls).to.equal(1);
    } finally {
      process.removeAllListeners('SIGINT');
      originalSigintListeners.forEach(listener =>
        process.on('SIGINT', listener)
      );
      mockery.deregisterAll();
      mockery.disable();
    }
  });
});
