'use strict';

// This fixture is deliberately isolated from the parent Mocha process. The SDK
// patches diagnostic channels when loaded, which must not affect mockery tests.
const http = require('http');
const assert = require('assert').strict;
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');

// The local SDK uses Statsbeat independently of the telemetry channel; disable
// that optional sender before loading the SDK so this probe has no network path.
process.env.APPLICATION_INSIGHTS_NO_STATSBEAT = 'true';

let networkAttempts = [];
const forbiddenNetwork = label => {
  networkAttempts.push(label);
  const error = new Error('network disabled in Application Insights SDK probe');
  error.stack += `\nnetwork-kind:${label}`;
  throw error;
};
http.request = () => forbiddenNetwork('http.request');
http.get = () => forbiddenNetwork('http.get');
https.request = () => forbiddenNetwork('https.request');
https.get = () => forbiddenNetwork('https.get');
net.connect = () => forbiddenNetwork('net.connect');
net.createConnection = () => forbiddenNetwork('net.createConnection');
net.Socket.prototype.connect = () => forbiddenNetwork('net.Socket.connect');
tls.connect = () => forbiddenNetwork('tls.connect');
dns.lookup = () => forbiddenNetwork('dns.lookup');

const appInsights = require('applicationinsights');
const {
  ALLOWED_METRIC_NAMES,
  createApplicationInsightsPrivacyProcessor
} = require('../../api/helpers/applicationInsightsPrivacy');

const client = new appInsights.TelemetryClient(
  'InstrumentationKey=00000000-0000-0000-0000-000000000000'
);
const sent = [];
client.channel.send = envelope => sent.push(envelope);
client.addTelemetryProcessor(createApplicationInsightsPrivacyProcessor());
client.trackMetric({
  name: Array.from(ALLOWED_METRIC_NAMES)[0],
  value: 1,
  properties: { email: 'user@example.test' }
});
client.trackException({ exception: new Error('secret-token') });

assert.equal(sent.length, 1);
assert.equal(sent[0].data.baseType, 'MetricData');
assert.equal(JSON.stringify(sent).includes('secret-token'), false);
assert.equal(JSON.stringify(sent).includes('user@example.test'), false);
if (networkAttempts.length) {
  process.stderr.write(`network attempts: ${JSON.stringify(networkAttempts)}\n`);
}
assert.deepEqual(networkAttempts, []);

process.stdout.write(JSON.stringify({
  sentCount: sent.length,
  baseType: sent[0] && sent[0].data && sent[0].data.baseType,
  containsSecret: JSON.stringify(sent).includes('secret-token') ||
    JSON.stringify(sent).includes('user@example.test'),
  networkAttempts: networkAttempts.length
}));
