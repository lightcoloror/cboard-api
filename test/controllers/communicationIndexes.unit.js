'use strict';

const chai = require('chai');
const {
  COMMUNICATION_INDEX_STATUSES,
  REQUIRED_COMMUNICATION_MODELS,
  createCommunicationIndexCoordinator
} = require('../../api/helpers/communicationIndexes');
const Communicator = require('../../api/models/Communicator');
const CommunicationReceiverRecord = require('../../api/models/CommunicationReceiverRecord');
const CommunicationSavedPhrase = require('../../api/models/CommunicationSavedPhrase');
const CommunicationPrivateLibrary = require('../../api/models/CommunicationPrivateLibrary');
const CommunicationPrivateDeviceData = require('../../api/models/CommunicationPrivateDeviceData');
const Settings = require('../../api/models/Settings');
const User = require('../../api/models/User');
const PhoneVerificationChallenge = require('../../api/models/PhoneVerificationChallenge');
const CommunicationAiUsage = require('../../api/models/CommunicationAiUsage');

const expect = chai.expect;

function createModels(createIndexes) {
  return {
    Communicator: { createIndexes },
    CommunicationReceiverRecord: { createIndexes },
    CommunicationSavedPhrase: { createIndexes },
    CommunicationPrivateLibrary: { createIndexes },
    CommunicationPrivateDeviceData: { createIndexes },
    Settings: { createIndexes },
    User: { createIndexes },
    PhoneVerificationChallenge: { createIndexes },
    CommunicationAiUsage: { createIndexes }
  };
}

describe('Communication index readiness', function() {
  it('creates every correctness index and becomes ready', async function() {
    let calls = 0;
    const coordinator = createCommunicationIndexCoordinator(
      createModels(async () => {
        calls += 1;
      })
    );

    const names = await coordinator.ensure();

    expect(names).to.deep.equal(REQUIRED_COMMUNICATION_MODELS);
    expect(calls).to.equal(REQUIRED_COMMUNICATION_MODELS.length);
    expect(coordinator.getStatus()).to.equal(
      COMMUNICATION_INDEX_STATUSES.READY
    );
  });

  it('coalesces concurrent initialization attempts', async function() {
    let resolveIndex;
    let calls = 0;
    const deferred = new Promise(resolve => {
      resolveIndex = resolve;
    });
    const coordinator = createCommunicationIndexCoordinator(
      createModels(async () => {
        calls += 1;
        await deferred;
      })
    );

    const first = coordinator.ensure();
    const second = coordinator.ensure();
    resolveIndex();
    await Promise.all([first, second]);

    expect(second).to.equal(first);
    expect(calls).to.equal(REQUIRED_COMMUNICATION_MODELS.length);
  });

  it('reports failure and allows a later retry', async function() {
    let shouldFail = true;
    const coordinator = createCommunicationIndexCoordinator(
      createModels(async () => {
        if (shouldFail) throw new Error('index unavailable');
      })
    );

    let error;
    try {
      await coordinator.ensure();
    } catch (caught) {
      error = caught;
    }
    expect(error.message).to.equal('index unavailable');
    expect(coordinator.getStatus()).to.equal(
      COMMUNICATION_INDEX_STATUSES.FAILED
    );

    shouldFail = false;
    await coordinator.ensure();
    expect(coordinator.getStatus()).to.equal(
      COMMUNICATION_INDEX_STATUSES.READY
    );
  });

  it('invalidates an old build after a database disconnect', async function() {
    let resolveIndex;
    const deferred = new Promise(resolve => {
      resolveIndex = resolve;
    });
    const coordinator = createCommunicationIndexCoordinator(
      createModels(async () => {
        await deferred;
      })
    );

    const oldBuild = coordinator.ensure();
    coordinator.markPending();
    resolveIndex();
    await oldBuild;

    expect(coordinator.getStatus()).to.equal(
      COMMUNICATION_INDEX_STATUSES.PENDING
    );
  });

  it('keeps correctness index definitions in the Mongoose schemas', function() {
    const expectedIndexes = [
      [
        Communicator,
        'email_1_clientCreationKey_1',
        { email: 1, clientCreationKey: 1 }
      ],
      [
        CommunicationReceiverRecord,
        'user_1_clientRecordId_1',
        { user: 1, clientRecordId: 1 }
      ],
      [
        CommunicationSavedPhrase,
        'user_1_clientPhraseId_1',
        { user: 1, clientPhraseId: 1 }
      ],
      [CommunicationPrivateLibrary, 'user_1', { user: 1 }],
      [CommunicationPrivateDeviceData, 'user_1', { user: 1 }],
      [Settings, 'user_1', { user: 1 }],
      [User, 'phone_1', { phone: 1 }],
      [PhoneVerificationChallenge, 'challengeId_1', { challengeId: 1 }],
      [
        PhoneVerificationChallenge,
        'verificationTokenHash_1',
        { verificationTokenHash: 1 }
      ],
      [
        CommunicationAiUsage,
        'user_1_month_1_provider_1_model_1_operation_1',
        { user: 1, month: 1, provider: 1, model: 1, operation: 1 }
      ]
    ];

    expectedIndexes.forEach(([model, name, keys]) => {
      const index = model.schema.indexes().find(item => item[1].name === name);
      expect(index[0]).to.deep.equal(keys);
      expect(index[1].unique).to.equal(true);
    });

    const phoneIndex = User.schema
      .indexes()
      .find(item => item[1].name === 'phone_1');
    expect(phoneIndex[1].sparse).to.equal(true);

    const tokenIndex = PhoneVerificationChallenge.schema
      .indexes()
      .find(item => item[1].name === 'verificationTokenHash_1');
    expect(tokenIndex[1].sparse).to.equal(true);
    const expiryIndex = PhoneVerificationChallenge.schema
      .indexes()
      .find(item => item[1].name === 'expiresAt_1');
    expect(expiryIndex[0]).to.deep.equal({ expiresAt: 1 });
    expect(expiryIndex[1].expireAfterSeconds).to.equal(0);
  });
});
