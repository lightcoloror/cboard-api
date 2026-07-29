'use strict';

process.env.NODE_ENV = 'test';

const chai = require('chai');
const mockery = require('mockery');

const expect = chai.expect;

describe('Communication receiver records controller', function () {
  let controller;
  let operations;
  let deletion;
  let deletions;
  let existingRecords;
  let storedRecords;

  beforeEach(function () {
    operations = [];
    deletion = null;
    deletions = [];
    existingRecords = [];
    storedRecords = [];
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
        operations = nextOperations;
      },
      async updateMany(filter, update) {
        deletion = { filter, update };
        deletions.push(deletion);
        return { modifiedCount: 1 };
      },
      find(filter) {
        const isRequestedRecordLookup = Boolean(
          filter &&
            filter.clientRecordId &&
            filter.clientRecordId.$in
        );
        return createQuery(
          isRequestedRecordLookup ? existingRecords : storedRecords
        );
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock(
      '../models/CommunicationReceiverRecord',
      model
    );
    controller = require('../../api/controllers/communicationRecords');
  });

  afterEach(function () {
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

  function createConfirmedRecord(overrides = {}) {
    return {
      id: 'receiver-1',
      sessionId: 'session-1',
      patientId: 'patient-1',
      workspaceId: 'workspace-1',
      direction: 'receive',
      recordStatus: 'confirmed',
      inputText: '我想喝水',
      labels: ['想', '水'],
      pictogramSequence: [
        {
          pictogramId: 'water',
          label: '水',
          source: 'local_dict',
          matchType: 'exact',
          confidence: 1,
          originalToken: '水',
          attribution: {
            provider: 'opensymbols',
            originalId: 'mulberry:water',
            name: 'OpenSymbols / mulberry',
            license: 'CC BY-SA 2.0 UK',
            licenseUrl:
              'https://creativecommons.org/licenses/by-sa/2.0/uk/',
            author: 'Mulberry Symbols',
            authorUrl: 'https://mulberrysymbols.org/',
            sourceUrl:
              'https://www.opensymbols.org/symbols/mulberry/water',
            repoKey: 'mulberry'
          }
        }
      ],
      createdAt: 10,
      updatedAt: 20,
      confirmedAt: 20,
      ...overrides
    };
  }

  it('requires an authenticated CBoard user', async function () {
    const res = createResponse();
    await controller.syncConfirmedReceiverRecords(
      { body: { records: [] } },
      res
    );
    expect(res.statusCode).to.equal(400);
  });

  it('upserts only whitelisted confirmed data for the current user', async function () {
    const input = createConfirmedRecord({
      patientFeedback: 'understood',
      patientFeedbackAt: 22,
      patientFeedbackEvents: [
        { type: 'repeat_requested', createdAt: 21 },
        { type: 'understood', createdAt: 22 }
      ],
      updatedAt: 22,
      receiverCorrections: [{ action: 'replace_pictogram' }],
      missingTokens: ['秘密词']
    });
    storedRecords = [
      {
        user: 'user-1',
        clientRecordId: input.id,
        ...input,
        serverVersion: 1
      }
    ];
    const res = createResponse();

    await controller.syncConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: { records: [input] }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.acceptedCount).to.equal(1);
    expect(res.body.conflictCount).to.equal(0);
    expect(operations[0].updateOne.filter).to.deep.equal({
      user: 'user-1',
      clientRecordId: 'receiver-1'
    });
    const inserted = operations[0].updateOne.update.$setOnInsert;
    expect(inserted).not.to.have.property(
      'receiverCorrections'
    );
    expect(inserted).not.to.have.property(
      'missingTokens'
    );
    expect(inserted).not.to.have.property('baseVersion');
    expect(inserted.serverVersion).to.equal(1);
    expect(
      inserted.patientFeedbackEvents
    ).to.deep.equal([
      { type: 'repeat_requested', createdAt: 21 },
      { type: 'understood', createdAt: 22 }
    ]);
    expect(
      inserted.pictogramSequence[0].attribution
    ).to.deep.equal(input.pictogramSequence[0].attribution);
    expect(res.body.records[0].patientFeedback).to.equal(
      'understood'
    );
    expect(res.body.records[0].patientFeedbackAt).to.equal(22);
    expect(res.body.records[0]).not.to.have.property('user');
    expect(res.body.records[0].serverVersion).to.equal(1);
    expect(res.body.records[0].conflicted).to.equal(false);
    expect(res.body.deletedRecordIds).to.deep.equal([]);
    expect(res.body.deletedRecords).to.deep.equal([]);
  });

  it('strips device-private attribution and pictogram ids at the server boundary', async function () {
    const input = createConfirmedRecord({
      pictogramSequence: [
        {
          pictogramId: 'device_private_missing_family-photo',
          label: '妈妈',
          source: 'user',
          matchType: 'manual',
          confidence: 1,
          originalToken: '妈妈',
          attribution: {
            provider: 'device-private',
            originalId: 'family-photo',
            name: '当前设备私有图片',
            license: '用户提供，仅限本机使用',
            sourceUrl:
              'device-private://missing-token/family-photo'
          }
        }
      ]
    });
    storedRecords = [
      {
        user: 'user-1',
        clientRecordId: input.id,
        ...input
      }
    ];
    const res = createResponse();

    await controller.syncConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: { records: [input] }
      },
      res
    );

    const sequenceItem =
      operations[0].updateOne.update.$setOnInsert
        .pictogramSequence[0];
    expect(sequenceItem.pictogramId).to.equal(null);
    expect(sequenceItem).not.to.have.property('attribution');
  });

  it('keeps the server-confirmed body when an old device pushes a stale rewrite', async function () {
    const canonical = {
      user: 'user-1',
      clientRecordId: 'receiver-1',
      ...createConfirmedRecord(),
      serverVersion: 2,
      deletedAt: null
    };
    existingRecords = [canonical];
    storedRecords = [canonical];
    const res = createResponse();

    await controller.syncConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: {
          records: [
            createConfirmedRecord({
              inputText: '旧设备试图覆盖',
              updatedAt: 50,
              baseVersion: 1
            })
          ]
        }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.acceptedCount).to.equal(0);
    expect(res.body.conflictCount).to.equal(1);
    expect(res.body.conflictedRecordIds).to.deep.equal([
      'receiver-1'
    ]);
    expect(res.body.records[0]).to.include({
      inputText: '我想喝水',
      serverVersion: 2,
      conflicted: true
    });
    expect(operations).to.deep.equal([]);
  });

  it('merges additive patient feedback when the base version is current', async function () {
    const existing = {
      user: 'user-1',
      clientRecordId: 'receiver-1',
      ...createConfirmedRecord({
        patientFeedback: 'repeat_requested',
        patientFeedbackAt: 21,
        patientFeedbackEvents: [
          { type: 'repeat_requested', createdAt: 21 }
        ],
        updatedAt: 21
      }),
      serverVersion: 2,
      deletedAt: null
    };
    existingRecords = [existing];
    storedRecords = [
      {
        ...existing,
        patientFeedback: 'understood',
        patientFeedbackAt: 22,
        patientFeedbackEvents: [
          { type: 'repeat_requested', createdAt: 21 },
          { type: 'understood', createdAt: 22 }
        ],
        updatedAt: 22,
        serverVersion: 3
      }
    ];
    const res = createResponse();

    await controller.syncConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: {
          records: [
            createConfirmedRecord({
              baseVersion: 2,
              patientFeedback: 'understood',
              patientFeedbackAt: 22,
              patientFeedbackEvents: [
                { type: 'understood', createdAt: 22 }
              ],
              updatedAt: 22
            })
          ]
        }
      },
      res
    );

    expect(res.body.conflictCount).to.equal(0);
    expect(operations[0].updateOne.update.$set).to.include({
      serverVersion: 3,
      patientFeedback: 'understood',
      patientFeedbackAt: 22
    });
    expect(
      operations[0].updateOne.update.$set.patientFeedbackEvents
    ).to.deep.equal([
      { type: 'repeat_requested', createdAt: 21 },
      { type: 'understood', createdAt: 22 }
    ]);
    expect(res.body.records[0].serverVersion).to.equal(3);
  });

  it('marks feedback lost to a simultaneous version update as a conflict', async function () {
    const existing = {
      user: 'user-1',
      clientRecordId: 'receiver-1',
      ...createConfirmedRecord({
        patientFeedback: 'repeat_requested',
        patientFeedbackAt: 21,
        patientFeedbackEvents: [
          { type: 'repeat_requested', createdAt: 21 }
        ],
        updatedAt: 21
      }),
      serverVersion: 2,
      deletedAt: null
    };
    existingRecords = [existing];
    storedRecords = [
      {
        ...existing,
        patientFeedback: 'not_understood',
        patientFeedbackAt: 23,
        patientFeedbackEvents: [
          { type: 'repeat_requested', createdAt: 21 },
          { type: 'not_understood', createdAt: 23 }
        ],
        updatedAt: 23,
        serverVersion: 3
      }
    ];
    const res = createResponse();

    await controller.syncConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: {
          records: [
            createConfirmedRecord({
              baseVersion: 2,
              patientFeedback: 'understood',
              patientFeedbackAt: 22,
              patientFeedbackEvents: [
                { type: 'repeat_requested', createdAt: 21 },
                { type: 'understood', createdAt: 22 }
              ],
              updatedAt: 22
            })
          ]
        }
      },
      res
    );

    expect(res.body.acceptedCount).to.equal(0);
    expect(res.body.conflictCount).to.equal(1);
    expect(res.body.conflictedRecordIds).to.deep.equal([
      'receiver-1'
    ]);
    expect(res.body.records[0]).to.include({
      serverVersion: 3,
      conflicted: true
    });
  });

  it('rejects drafts before they reach persistence', async function () {
    const res = createResponse();
    await controller.syncConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: {
          records: [
            createConfirmedRecord({ recordStatus: 'draft' })
          ]
        }
      },
      res
    );

    expect(res.statusCode).to.equal(400);
    expect(operations).to.deep.equal([]);
  });

  it('rejects malformed patient feedback before persistence', async function () {
    const res = createResponse();
    await controller.syncConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: {
          records: [
            createConfirmedRecord({
              patientFeedbackEvents: [
                { type: 'unknown', createdAt: 21 }
              ],
              updatedAt: 21
            })
          ]
        }
      },
      res
    );

    expect(res.statusCode).to.equal(400);
    expect(operations).to.deep.equal([]);
  });

  it('returns tombstones without returning deleted records as active history', async function () {
    storedRecords = [
      {
        user: 'user-1',
        clientRecordId: 'receiver-deleted',
        ...createConfirmedRecord({ id: 'receiver-deleted' }),
        deletedAt: 30,
        deletedBy: 'user-1',
        serverVersion: 2
      }
    ];
    const res = createResponse();

    await controller.syncConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: { records: [] }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.records).to.deep.equal([]);
    expect(res.body.deletedRecordIds).to.deep.equal([
      'receiver-deleted'
    ]);
    expect(res.body.deletedRecords).to.deep.equal([
      {
        id: 'receiver-deleted',
        deletedAt: 30,
        deletedBy: 'user-1',
        serverVersion: 2
      }
    ]);
  });

  it('marks selected records as deleted for the current user', async function () {
    existingRecords = [
      {
        user: 'user-1',
        clientRecordId: 'receiver-1',
        ...createConfirmedRecord(),
        serverVersion: 2,
        deletedAt: null
      }
    ];
    const res = createResponse();
    await controller.deleteConfirmedReceiverRecords(
      {
        user: { id: 'user-1' },
        body: { recordIds: ['receiver-1'] }
      },
      res
    );

    expect(res.statusCode).to.equal(200);
    expect(res.body.deletedCount).to.equal(1);
    expect(deletion.filter).to.deep.equal({
      user: 'user-1',
      deletedAt: null,
      clientRecordId: { $in: ['receiver-1'] }
    });
    expect(deletion.update.$set.deletedAt).to.be.a('number');
    expect(deletion.update.$set.deletedBy).to.equal('user-1');
    expect(deletion.update.$inc.serverVersion).to.equal(1);
    expect(deletions[0]).to.deep.equal({
      filter: {
        user: 'user-1',
        deletedAt: null,
        clientRecordId: { $in: ['receiver-1'] },
        serverVersion: { $exists: false }
      },
      update: { $set: { serverVersion: 1 } }
    });
    expect(res.body.deletedRecords[0]).to.include({
      id: 'receiver-1',
      deletedBy: 'user-1',
      serverVersion: 3
    });
  });
});
