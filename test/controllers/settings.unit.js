process.env.NODE_ENV = 'test';

const mockery = require('mockery');
const chai = require('chai');

const expect = chai.expect;

describe('Settings controller unit', function () {
  let controller;
  let mockSettingsModel;

  beforeEach(function () {
    mockSettingsModel = {
      getOrCreate: async user => ({
        id: 'settings-1',
        user: user.id,
        language: { lang: 'en-US' }
      }),
      findByIdAndUpdate: id => ({
        exec: async () => ({
          toJSON: () => ({
            id,
            user: 'user-1',
            language: { lang: 'en-US' },
            communicationSupport: {
              savedPhrases: [{ sentence: 'I want water' }],
              history: []
            },
            tuyujia: {
              savedPhrases: [{ sentence: 'I want water' }],
              history: []
            }
          })
        })
      })
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/Settings', mockSettingsModel);
    controller = require('../../api/controllers/settings');
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

  it('updateSettings keeps communicationSupport and legacy tuyujia fields', async function () {
    const req = {
      user: { id: 'user-1' },
      body: {
        id: 'ignore-me',
        communicationSupport: {
          savedPhrases: [{ sentence: 'I want water' }],
          history: []
        },
        tuyujia: {
          savedPhrases: [{ sentence: 'I want water' }],
          history: []
        }
      }
    };
    const res = createResponse();

    await controller.updateSettings(req, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.communicationSupport).to.deep.equal({
      savedPhrases: [{ sentence: 'I want water' }],
      history: []
    });
    expect(res.body.tuyujia).to.deep.equal({
      savedPhrases: [{ sentence: 'I want water' }],
      history: []
    });
  });

  it('getSettings returns the created settings payload', async function () {
    mockSettingsModel.getOrCreate = async () => ({
      id: 'settings-1',
      user: 'user-1',
      communicationSupport: {
        savedPhrases: [],
        history: []
      },
      tuyujia: {
        savedPhrases: [],
        history: []
      }
    });

    mockery.deregisterAll();
    mockery.registerMock('../models/Settings', mockSettingsModel);
    controller = require('../../api/controllers/settings');

    const req = {
      user: { id: 'user-1' }
    };
    const res = createResponse();

    await controller.getSettings(req, res);

    expect(res.statusCode).to.equal(200);
    expect(res.body.communicationSupport).to.deep.equal({
      savedPhrases: [],
      history: []
    });
    expect(res.body.tuyujia).to.deep.equal({
      savedPhrases: [],
      history: []
    });
  });
});
