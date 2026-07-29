'use strict';

const chai = require('chai');
const mongoose = require('mongoose');
const {
  createCommunicationAiTokenQuotaService
} = require('../../api/helpers/communicationAiTokenQuota');

const expect = chai.expect;
const mongoUrl = process.env.COMMUNICATION_AI_TOKEN_QUOTA_MONGO_TEST_URL;
const describeWithMongo = mongoUrl ? describe : describe.skip;

describeWithMongo('Communication AI token quota with Mongo', function() {
  this.timeout(20000);

  const config = {
    enabled: true,
    monthlyTokens: 100,
    textReservationTokens: 40,
    imageReservationTokens: 80
  };
  const now = () => new Date('2026-07-29T00:00:00.000Z');
  const userId = 'quota-integration-user';
  let connection;
  let collection;
  let service;

  before(async function() {
    connection = mongoose.createConnection(mongoUrl, {
      useFindAndModify: false,
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    await new Promise((resolve, reject) => {
      connection.once('open', resolve);
      connection.once('error', reject);
    });

    collection = connection.collection('communicationAiMonthlyTokenQuotas');
    await collection.createIndex({ expire: -1 }, { expireAfterSeconds: 0 });
    await collection.createIndex({ key: 1 }, { unique: true });
    service = createCommunicationAiTokenQuotaService({
      config,
      now,
      storeClient: connection
    });
  });

  beforeEach(async function() {
    await collection.deleteMany({});
  });

  after(async function() {
    if (collection) await collection.deleteMany({});
    if (connection) await connection.close();
  });

  it('keeps concurrent reservations within quota and reconciles outcomes', async function() {
    const attempts = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        service.reserve({
          operationId: 'generateCommunicationSentences',
          userId
        })
      )
    );
    const reservations = attempts
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value);
    const rejections = attempts.filter(result => result.status === 'rejected');

    expect(reservations).to.have.length(2);
    expect(rejections).to.have.length(1);
    expect(rejections[0].reason).to.include({
      code: 'COMMUNICATION_AI_TOKEN_QUOTA_EXCEEDED',
      status: 429
    });
    expect(await service.getStatus({ userId })).to.include({
      consumedTokens: 80,
      remainingTokens: 20
    });

    await service.settleReservation(reservations[0], {
      completion_tokens: 5,
      prompt_tokens: 10,
      total_tokens: 15
    });
    await service.releaseReservation(reservations[1]);
    expect(await service.getStatus({ userId })).to.include({
      consumedTokens: 15,
      remainingTokens: 85
    });

    const imageReservation = await service.reserve({
      operationId: 'recognizeCommunicationImageText',
      userId
    });
    await service.settleReservation(imageReservation, {
      total_tokens: 100
    });
    expect(await service.getStatus({ userId })).to.include({
      consumedTokens: 115,
      remainingTokens: 0
    });

    let quotaError;
    try {
      await service.reserve({
        operationId: 'resegmentCommunicationText',
        userId
      });
    } catch (error) {
      quotaError = error;
    }
    expect(quotaError).to.include({
      code: 'COMMUNICATION_AI_TOKEN_QUOTA_EXCEEDED',
      status: 429
    });

    const documents = await collection.find({}).toArray();
    expect(documents).to.have.length(1);
    expect(JSON.stringify(documents[0])).not.to.contain(userId);

    expect(await service.deleteUserQuota({ userId })).to.equal(true);
    expect(await service.getStatus({ userId })).to.include({
      consumedTokens: 0,
      remainingTokens: 100
    });
  });
});
