'use strict';

const bodyParser = require('body-parser');
const chai = require('chai');
const express = require('express');
const request = require('supertest');
const swaggerTools = require('swagger-tools');
const YAML = require('yamljs');

const expect = chai.expect;

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
        originalToken: '水'
      }
    ],
    createdAt: 10,
    updatedAt: 20,
    confirmedAt: 20,
    ...overrides
  };
}

describe('Communication receiver record route', function () {
  let app;

  before(function (done) {
    app = express();
    app.use(bodyParser.json());

    swaggerTools.initializeMiddleware(
      YAML.load('./api/swagger/swagger.yaml'),
      function initialize(middleware) {
        app.use(middleware.swaggerMetadata());
        app.use(middleware.swaggerValidator());
        app.use(
          middleware.swaggerRouter({
            controllers: './test/fixtures/communicationRecordsControllers',
            useStubs: false
          })
        );
        app.use(function handleError(error, req, res, next) {
          if (!error) return next();
          return res.status(error.status || 400).json({
            error: { message: error.message }
          });
        });
        done();
      }
    );
  });

  it('accepts a bounded confirmed receiver record', async function () {
    const response = await request(app)
      .post('/communication/receiver-records/sync')
      .send({
        records: [
          createConfirmedRecord({
            patientFeedback: 'understood',
            patientFeedbackAt: 22,
            patientFeedbackEvents: [
              { type: 'repeat_requested', createdAt: 21 },
              { type: 'understood', createdAt: 22 }
            ],
            updatedAt: 22
          })
        ]
      })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.acceptedCount).to.equal(1);
    expect(response.body.records[0].recordStatus).to.equal('confirmed');
    expect(response.body.records[0].patientFeedback).to.equal(
      'understood'
    );
    expect(response.body.records[0].patientFeedbackEvents).to.have.length(
      2
    );
    expect(response.body.deletedRecordIds).to.deep.equal([]);
  });

  it('rejects drafts at the public contract boundary', async function () {
    await request(app)
      .post('/communication/receiver-records/sync')
      .send({
        records: [createConfirmedRecord({ recordStatus: 'draft' })]
      })
      .expect(400);
  });

  it('rejects private maintenance fields at the public contract boundary', async function () {
    await request(app)
      .post('/communication/receiver-records/sync')
      .send({
        records: [
          createConfirmedRecord({
            missingTokens: ['秘密词']
          })
        ]
      })
      .expect(400);
  });

  it('rejects unknown patient feedback at the public contract boundary', async function () {
    await request(app)
      .post('/communication/receiver-records/sync')
      .send({
        records: [
          createConfirmedRecord({
            patientFeedback: 'unknown',
            patientFeedbackAt: 21,
            patientFeedbackEvents: [
              { type: 'unknown', createdAt: 21 }
            ],
            updatedAt: 21
          })
        ]
      })
      .expect(400);
  });

  it('rejects an oversized sync batch', async function () {
    await request(app)
      .post('/communication/receiver-records/sync')
      .send({
        records: Array.from({ length: 101 }, (value, index) =>
          createConfirmedRecord({ id: `receiver-${index}` })
        )
      })
      .expect(400);
  });

  it('accepts a bounded receiver record deletion request', async function () {
    const response = await request(app)
      .delete('/communication/receiver-records')
      .send({ recordIds: ['receiver-1'] })
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body.deletedCount).to.equal(1);
    expect(response.body.deletedRecordIds).to.deep.equal(['receiver-1']);
  });

  it('rejects private maintenance fields on deletion', async function () {
    await request(app)
      .delete('/communication/receiver-records')
      .send({
        recordIds: ['receiver-1'],
        missingTokens: ['秘密词']
      })
      .expect(400);
  });
});
