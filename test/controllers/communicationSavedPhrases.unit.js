'use strict';

process.env.NODE_ENV = 'test';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('Communication saved phrases controller', function() {
  let controller;
  let findResults;
  let operations;

  beforeEach(function() {
    findResults = [];
    operations = [];
    const createQuery = records => ({
      sort() {
        return this;
      },
      limit() {
        return this;
      },
      lean() {
        return this;
      },
      async exec() {
        return records;
      }
    });
    const model = {
      async bulkWrite(nextOperations) {
        operations.push(...nextOperations);
      },
      find() {
        return createQuery(findResults.shift() || []);
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/CommunicationSavedPhrase', model);
    controller = require('../../api/controllers/communicationSavedPhrases');
  });

  afterEach(function() {
    mockery.deregisterAll();
    mockery.disable();
  });

  function createResponse() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
  }

  function createPhrase(overrides = {}) {
    return {
      id: 'phrase-water',
      sentence: '我要喝水',
      output: [{ id: 'water', label: '水' }],
      usageCount: 1,
      contractVersion: 1,
      createdAt: 10,
      lastUsedAt: 15,
      updatedAt: 20,
      baseVersion: 0,
      ...overrides
    };
  }

  function createStoredPhrase(overrides = {}) {
    const phrase = createPhrase(overrides);
    return {
      user: 'user-1',
      clientPhraseId: phrase.id,
      sentence: phrase.sentence,
      output: phrase.output,
      usageCount: phrase.usageCount,
      contractVersion: phrase.contractVersion,
      createdAt: phrase.createdAt,
      lastUsedAt: phrase.lastUsedAt,
      updatedAt: phrase.updatedAt,
      serverVersion: overrides.serverVersion || 1,
      deletedAt: Object.prototype.hasOwnProperty.call(overrides, 'deletedAt')
        ? overrides.deletedAt
        : null,
      deletedBy: overrides.deletedBy || null
    };
  }

  it('requires an authenticated CBoard user', async function() {
    const res = createResponse();

    await controller.syncCommunicationSavedPhrases(
      { body: { phrases: [] } },
      res
    );

    expect(res.statusCode).to.equal(400);
  });

  it('inserts only public phrase data and strips device-private pictograms', async function() {
    const input = createPhrase({
      output: [
        {
          id: 'device_private_family-cup',
          label: '家庭杯子',
          image: 'wxfile://private/cup.png',
          source: 'user'
        },
        {
          id: 'water',
          label: '水',
          image: 'https://cdn.example/water.png'
        },
        {
          id: 'generated-help',
          label: '紧急求助',
          image: 'https://cdn.example/generated-help.png',
          source: 'ai',
          attribution: {
            provider: 'ai-generated',
            originalId: 'generated-help',
            name: 'AI 生成图片',
            license: 'unknown',
            sourceUrl: 'https://ai.example/generated-help'
          }
        }
      ],
      privateRecordingPath: 'wxfile://private/voice.mp3'
    });
    const stored = createStoredPhrase({
      output: [
        { label: '家庭杯子' },
        {
          id: 'water',
          label: '水',
          image: 'https://cdn.example/water.png'
        },
        {
          id: 'generated-help',
          label: '紧急求助',
          source: 'ai'
        }
      ]
    });
    findResults = [[], [stored]];
    const res = createResponse();

    await controller.syncCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: { phrases: [input] }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.acceptedCount).to.equal(1);
    const inserted = operations[0].updateOne.update.$setOnInsert;
    expect(inserted.output).to.deep.equal(stored.output);
    expect(inserted).not.to.have.property('baseVersion');
    expect(inserted).not.to.have.property('privateRecordingPath');
    expect(inserted.serverVersion).to.equal(1);
  });

  it('keeps the server phrase when an old device sends a stale edit', async function() {
    const existing = createStoredPhrase({ serverVersion: 2 });
    findResults = [[existing], [existing]];
    const res = createResponse();

    await controller.syncCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: {
          phrases: [
            createPhrase({
              sentence: '旧设备覆盖',
              updatedAt: 30,
              baseVersion: 1
            })
          ]
        }
      },
      res
    );

    expect(operations).to.deep.equal([]);
    expect(res.body.acceptedCount).to.equal(0);
    expect(res.body.conflictCount).to.equal(1);
    expect(res.body.conflictedPhraseIds).to.deep.equal(['phrase-water']);
    expect(res.body.phrases[0]).to.include({
      sentence: '我要喝水',
      serverVersion: 2,
      conflicted: true
    });
  });

  it('updates mutable phrase content when the base version is current', async function() {
    const existing = createStoredPhrase({ serverVersion: 2 });
    const incoming = createPhrase({
      sentence: '请给我水',
      updatedAt: 30,
      baseVersion: 2
    });
    const stored = createStoredPhrase({
      sentence: incoming.sentence,
      updatedAt: incoming.updatedAt,
      serverVersion: 3
    });
    findResults = [[existing], [stored]];
    const res = createResponse();

    await controller.syncCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: { phrases: [incoming] }
      },
      res
    );

    expect(res.body.conflictCount).to.equal(0);
    expect(operations[0].updateOne.update.$set).to.include({
      sentence: '请给我水',
      updatedAt: 30,
      serverVersion: 3
    });
    expect(res.body.phrases[0].serverVersion).to.equal(3);
  });

  it('accepts an identical stale retry without creating a new version', async function() {
    const existing = createStoredPhrase({ serverVersion: 3 });
    findResults = [[existing], [existing]];
    const res = createResponse();

    await controller.syncCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: { phrases: [createPhrase({ baseVersion: 1 })] }
      },
      res
    );

    expect(operations).to.deep.equal([]);
    expect(res.body.acceptedCount).to.equal(1);
    expect(res.body.conflictCount).to.equal(0);
    expect(res.body.phrases[0].serverVersion).to.equal(3);
  });

  it('detects an edit lost to a simultaneous version update', async function() {
    const existing = createStoredPhrase({ serverVersion: 2 });
    const incoming = createPhrase({
      sentence: '本机修改',
      updatedAt: 30,
      baseVersion: 2
    });
    const concurrent = createStoredPhrase({
      sentence: '另一台设备修改',
      updatedAt: 31,
      serverVersion: 3
    });
    findResults = [[existing], [concurrent]];
    const res = createResponse();

    await controller.syncCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: { phrases: [incoming] }
      },
      res
    );

    expect(res.body.acceptedCount).to.equal(0);
    expect(res.body.conflictCount).to.equal(1);
    expect(res.body.phrases[0]).to.include({
      sentence: '另一台设备修改',
      serverVersion: 3,
      conflicted: true
    });
  });

  it('returns a tombstone instead of resurrecting a deleted phrase', async function() {
    const deleted = createStoredPhrase({
      sentence: '',
      output: [],
      serverVersion: 3,
      deletedAt: 40,
      deletedBy: 'user-1'
    });
    findResults = [[deleted], [deleted]];
    const res = createResponse();

    await controller.syncCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: { phrases: [createPhrase({ baseVersion: 2 })] }
      },
      res
    );

    expect(operations).to.deep.equal([]);
    expect(res.body.phrases).to.deep.equal([]);
    expect(res.body.conflictCount).to.equal(1);
    expect(res.body.deletedPhrases).to.deep.equal([
      {
        id: 'phrase-water',
        deletedAt: 40,
        deletedBy: 'user-1',
        serverVersion: 3
      }
    ]);
  });

  it('marks an existing phrase as deleted with a new server version', async function() {
    const existing = createStoredPhrase({ serverVersion: 2 });
    const deleted = {
      ...existing,
      serverVersion: 3,
      deletedAt: 50,
      deletedBy: 'user-1',
      updatedAt: 50
    };
    findResults = [[existing], [deleted]];
    const res = createResponse();

    await controller.deleteCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: { phraseIds: ['phrase-water'] }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.deletedCount).to.equal(1);
    expect(operations[0].updateOne.update.$set).to.include({
      deletedBy: 'user-1',
      serverVersion: 3
    });
    expect(res.body.deletedPhrases[0]).to.include({
      id: 'phrase-water',
      serverVersion: 3
    });
  });

  it('creates an idempotent tombstone for an unknown phrase id', async function() {
    const deleted = createStoredPhrase({
      id: 'phrase-unknown',
      sentence: '',
      output: [],
      deletedAt: 60,
      deletedBy: 'user-1'
    });
    findResults = [[], [deleted]];
    const res = createResponse();

    await controller.deleteCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: { phraseIds: ['phrase-unknown'] }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.deletedCount).to.equal(1);
    expect(operations[0].updateOne.update.$setOnInsert).to.include({
      clientPhraseId: 'phrase-unknown',
      sentence: '',
      deletedBy: 'user-1'
    });
  });

  it('does not create another version when deleting an existing tombstone', async function() {
    const deleted = createStoredPhrase({
      sentence: '',
      output: [],
      serverVersion: 3,
      deletedAt: 70,
      deletedBy: 'user-1'
    });
    findResults = [[deleted], [deleted]];
    const res = createResponse();

    await controller.deleteCommunicationSavedPhrases(
      {
        user: { id: 'user-1' },
        body: { phraseIds: ['phrase-water'] }
      },
      res
    );

    expect(operations).to.deep.equal([]);
    expect(res.statusCode).to.equal(200);
    expect(res.body.deletedCount).to.equal(0);
    expect(res.body.deletedPhrases[0].serverVersion).to.equal(3);
  });
});
