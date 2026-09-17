'use strict';

const chai = require('chai');
const express = require('express');
const http = require('http');
const request = require('supertest');
const {
  createTrustedProxyTrust,
  resolveTrustedProxyCidrs
} = require('../../api/helpers/trustedProxy');

const expect = chai.expect;

function createIpApp(env) {
  const app = express();
  app.set('trust proxy', createTrustedProxyTrust(env));
  app.get('/ip', (req, res) => res.json({ ip: req.ip, protocol: req.protocol }));
  return app;
}

describe('trusted proxy policy', function() {
  it('defaults to no trusted proxies and ignores spoofed forwarding headers', async function() {
    const server = http.createServer(createIpApp({}));
    try {
      const response = await request(server)
        .get('/ip')
        .set('X-Forwarded-For', '203.0.113.66')
        .set('X-Forwarded-Proto', 'https');
      expect(response.status).to.equal(200);
      expect(response.body.ip).to.match(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
      expect(response.body.ip).not.to.equal('203.0.113.66');
      expect(response.body.protocol).to.equal('http');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('honors only the configured loopback proxy and stops at the nearest untrusted hop', async function() {
    const server = http.createServer(createIpApp({ TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128' }));
    try {
      const response = await request(server)
        .get('/ip')
        .set('X-Forwarded-For', '203.0.113.66, 198.51.100.10')
        .set('X-Forwarded-Proto', 'https');
      expect(response.status).to.equal(200);
      expect(response.body.ip).to.equal('198.51.100.10');
      expect(response.body.protocol).to.equal('https');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('ignores forwarding headers when the configured proxy does not match the socket', async function() {
    const server = http.createServer(createIpApp({ TRUST_PROXY_CIDRS: '192.0.2.1/32' }));
    try {
      const response = await request(server)
        .get('/ip')
        .set('X-Forwarded-For', '203.0.113.66')
        .set('X-Forwarded-Proto', 'https');
      expect(response.status).to.equal(200);
      expect(response.body.ip).to.match(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
      expect(response.body.protocol).to.equal('http');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('rejects blank, broad, hop-count, boolean, and malformed trust configuration', function() {
    [
      '', '0', '1', '10', 'true', 'loopback', 'linklocal', 'uniquelocal',
      '0.0.0.0/0', '1.2.3.4/0', '0:0:0:0:0:0:0:0/0', '1.2.3.4/33',
      '1.2.3.4/24/1', 'not-an-ip'
    ]
      .forEach(value => expect(() => createTrustedProxyTrust({ TRUST_PROXY_CIDRS: value })).to.throw());
    expect(resolveTrustedProxyCidrs({ TRUST_PROXY_CIDRS: '127.0.0.1/32,2001:db8::1/128' }))
      .to.deep.equal(['127.0.0.1/32', '2001:db8::1/128']);
    expect(resolveTrustedProxyCidrs({})).to.deep.equal([]);
  });
});
