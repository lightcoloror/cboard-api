'use strict';

const assert = require('assert').strict;
const mockery = require('mockery');

const mediaModule = require.resolve('../../api/controllers/media');
const previousTrialFlag = process.env.CARE_PUBLIC_TRIAL_ENABLED;

function response() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

function uploadRequest(file) {
  return { files: { file: [file] } };
}

function loadController(calls) {
  mockery.enable({
    warnOnReplace: false,
    warnOnUnregistered: false,
    useCleanCache: true
  });
  mockery.registerMock('../helpers/blob', {
    async createBlockBlobFromText(...args) {
      calls.push(args);
      return [{ name: 'synthetic-file' }, 'https://blob.invalid/private-file'];
    }
  });
  delete require.cache[mediaModule];
  return require(mediaModule).uploadMedia;
}

function restoreModule() {
  delete require.cache[mediaModule];
  mockery.deregisterAll();
  mockery.disable();
}

describe('legacy public trial media upload gate', function() {
  afterEach(function() {
    restoreModule();
    if (previousTrialFlag === undefined) delete process.env.CARE_PUBLIC_TRIAL_ENABLED;
    else process.env.CARE_PUBLIC_TRIAL_ENABLED = previousTrialFlag;
  });

  it('rejects valid and invalid legacy uploads before any blob write', async function() {
    process.env.CARE_PUBLIC_TRIAL_ENABLED = 'true';
    const calls = [];
    const uploadMedia = loadController(calls);
    const valid = response();
    const invalid = response();

    await uploadMedia(uploadRequest({
      originalname: 'photo.png', mimetype: 'image/png', size: 3,
      buffer: Buffer.from([1, 2, 3])
    }), valid);
    await uploadMedia(uploadRequest({
      originalname: 'payload.txt', mimetype: 'text/plain', size: 3,
      buffer: Buffer.from('no media')
    }), invalid);

    for (const result of [valid, invalid]) {
      assert.equal(result.statusCode, 403);
      assert.deepEqual(result.body, {
        code: 'LEGACY_MEDIA_UPLOAD_DISABLED',
        message: 'Legacy public media uploads are disabled; use patient profile private media.'
      });
      assert.equal(result.headers['Cache-Control'], 'no-store');
    }
    assert.deepEqual(calls, []);
  });

  it('keeps a valid upload working when the public trial gate is disabled', async function() {
    process.env.CARE_PUBLIC_TRIAL_ENABLED = 'false';
    const calls = [];
    const uploadMedia = loadController(calls);
    const result = response();
    const file = {
      originalname: 'photo.png', mimetype: 'image/png', size: 3,
      buffer: Buffer.from([1, 2, 3])
    };

    await uploadMedia(uploadRequest(file), result);

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body, { url: 'https://blob.invalid/private-file' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'photo.png');
    assert.equal(calls[0][2], file);
  });

  it('keeps invalid upload validation when the public trial gate is disabled', async function() {
    delete process.env.CARE_PUBLIC_TRIAL_ENABLED;
    const calls = [];
    const uploadMedia = loadController(calls);
    const result = response();

    await uploadMedia(uploadRequest({
      originalname: 'payload.txt', mimetype: 'text/plain', size: 3,
      buffer: Buffer.from('no media')
    }), result);

    assert.equal(result.statusCode, 400);
    assert.deepEqual(result.body, { message: 'Unsupported, empty, or oversized media file.' });
    assert.deepEqual(calls, []);
  });
});
