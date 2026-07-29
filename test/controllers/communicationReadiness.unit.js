'use strict';

const chai = require('chai');
const {
  assertCommunicationReadiness,
  verifyCommunicationReadiness
} = require('../../scripts/verifyCommunicationReadiness');

const expect = chai.expect;

describe('Communication readiness verifier', function() {
  it('accepts only a connected API with ready communication indexes', function() {
    const body = {
      status: 'ok',
      database: 'connected',
      communicationIndexes: 'ready'
    };

    expect(assertCommunicationReadiness(body)).to.equal(body);
    expect(() =>
      assertCommunicationReadiness({
        status: 'degraded',
        database: 'connected',
        communicationIndexes: 'failed'
      })
    ).to.throw('Communication API is not ready');
  });

  it('checks the public health endpoint without credentials', async function() {
    let requestedUrl;
    const body = {
      status: 'ok',
      database: 'connected',
      communicationIndexes: 'ready'
    };
    const fetchImpl = async (url, options) => {
      requestedUrl = url;
      expect(options.headers).to.deep.equal({ Accept: 'application/json' });
      expect(options.signal).to.have.property('aborted', false);
      return {
        ok: true,
        status: 200,
        json: async () => body
      };
    };

    const result = await verifyCommunicationReadiness(
      'https://api.example.com/base/',
      fetchImpl
    );

    expect(requestedUrl.href).to.equal('https://api.example.com/health');
    expect(result).to.equal(body);
  });

  it('rejects a non-success health response', async function() {
    let error;
    try {
      await verifyCommunicationReadiness(
        'https://api.example.com',
        async () => ({
          ok: false,
          status: 503,
          json: async () => ({
            status: 'degraded',
            database: 'connected',
            communicationIndexes: 'building'
          })
        })
      );
    } catch (caught) {
      error = caught;
    }

    expect(error.message).to.equal('Health request failed: 503');
  });
});
