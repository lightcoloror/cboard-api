process.env.NODE_ENV = 'test';

const mockery = require('mockery');
const chai = require('chai');
const YAML = require('yamljs');

const expect = chai.expect;

describe('Settings controller unit', function() {
  let controller;
  let lastSettingsUpdate;
  let mockSettingsModel;
  let lifecycleCalls;
  let lifecycleError;
  let lifecycleSession;
  let previousLifecycleFlag;

  beforeEach(function() {
    lastSettingsUpdate = null;
    lifecycleCalls = [];
    lifecycleError = null;
    lifecycleSession = { id: 'settings-session' };
    previousLifecycleFlag = process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    mockSettingsModel = {
      getOrCreate: async user => ({
        id: 'settings-1',
        user: user.id,
        language: { lang: 'en-US' }
      }),
      findOneAndUpdate: (filter, update, options) => {
        lastSettingsUpdate = { filter, update, options };
        return {
          exec: async () => ({
            toJSON: () => ({
              id: 'settings-1',
              user: 'user-1',
              language: { lang: 'en-US' },
              communicationSupport: update.$set.communicationSupport,
              tuyujia: update.$set.tuyujia
            })
          })
        };
      }
    };

    mockery.enable({
      warnOnReplace: false,
      warnOnUnregistered: false,
      useCleanCache: true
    });
    mockery.registerMock('../models/Settings', mockSettingsModel);
    mockery.registerMock('../helpers/careFamilyLifecycle', {
      createCareFamilyLifecycle() {
        return {
          async withOpenAccount(id, callback) {
            lifecycleCalls.push(id);
            if (lifecycleError) throw lifecycleError;
            return callback(lifecycleSession);
          }
        };
      }
    });
    controller = require('../../api/controllers/settings');
  });

  afterEach(function() {
    if (previousLifecycleFlag === undefined) delete process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED;
    else process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = previousLifecycleFlag;
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

  it('updateSettings keeps communicationSupport and legacy tuyujia fields', async function() {
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
    expect(lastSettingsUpdate).to.deep.include({
      filter: { user: 'user-1' },
      options: {
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        upsert: true
      }
    });
    expect(lastSettingsUpdate.update.$setOnInsert).to.deep.equal({
      user: 'user-1'
    });
    expect(lastSettingsUpdate.update.$set.communicationSupport).to.deep.equal(
      req.body.communicationSupport
    );
    expect(lastSettingsUpdate.update.$set.tuyujia).to.deep.equal(
      req.body.tuyujia
    );
    expect(res.body.communicationSupport).to.deep.equal({
      savedPhrases: [{ sentence: 'I want water' }],
      history: []
    });
    expect(res.body.tuyujia).to.deep.equal({
      savedPhrases: [{ sentence: 'I want water' }],
      history: []
    });
  });

  it('updates only mutable settings fields without changing the request body', async function() {
    const req = {
      user: { id: 'user-1' },
      body: {
        id: 'attacker-settings-id',
        _id: 'attacker-mongo-id',
        __v: 99,
        user: 'other-user',
        createdAt: 1,
        unknown: { enabled: true },
        display: { highContrast: true }
      }
    };
    const originalBody = JSON.parse(JSON.stringify(req.body));
    const res = createResponse();

    await controller.updateSettings(req, res);

    expect(res.statusCode).to.equal(200);
    expect(req.body).to.deep.equal(originalBody);
    expect(lastSettingsUpdate.filter).to.deep.equal({ user: 'user-1' });
    expect(lastSettingsUpdate.update).to.deep.equal({
      $set: { display: { highContrast: true } },
      $setOnInsert: { user: 'user-1' }
    });
  });

  it('publishes settings through the account lifecycle session when enabled', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const res = createResponse();

    await controller.updateSettings({ user: { id: 'user-1' }, body: { display: { highContrast: true } } }, res);

    expect(res.statusCode).to.equal(200);
    expect(lifecycleCalls).to.deep.equal(['user-1']);
    expect(lastSettingsUpdate.options.session).to.equal(lifecycleSession);
  });

  it('maps account closing and closed lifecycle errors to stable responses', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    for (const [code, status] of [['ACCOUNT_CLOSING', 409], ['ACCOUNT_CLOSED', 403]]) {
      lifecycleError = Object.assign(new Error('private lifecycle details'), { code });
      const res = createResponse();
      await controller.updateSettings({ user: { id: 'user-1' }, body: { display: {} } }, res);
      expect(res.statusCode).to.equal(status);
      expect(res.body.error.code).to.equal(code);
      expect(res.body.message).to.equal(code === 'ACCOUNT_CLOSING' ? 'Account is closing' : 'Account is closed');
      expect(res.body.message).not.to.include('private lifecycle details');
    }
  });

  it('rejects a non-object settings payload', async function() {
    const req = {
      user: { id: 'user-1' },
      body: []
    };
    const res = createResponse();

    await controller.updateSettings(req, res);

    expect(res.statusCode).to.equal(400);
    expect(lastSettingsUpdate).to.equal(null);
  });

  it('getSettings returns the created settings payload', async function() {
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

  it('does not wrap getSettings in a second controller transaction', async function() {
    process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED = 'true';
    const res = createResponse();
    await controller.getSettings({ user: { id: 'user-1' } }, res);
    expect(res.statusCode).to.equal(200);
    expect(lifecycleCalls).to.deep.equal([]);
  });

  it('reports a settings storage failure instead of returning an empty success', async function() {
    mockSettingsModel.getOrCreate = async () => null;

    mockery.deregisterAll();
    mockery.registerMock('../models/Settings', mockSettingsModel);
    controller = require('../../api/controllers/settings');

    const req = { user: { id: 'user-1' } };
    const res = createResponse();

    await controller.getSettings(req, res);

    expect(res.statusCode).to.equal(500);
    expect(res.body.message).to.equal('Error loading settings');
  });

  it('documents neutral and legacy fields in both settings contracts', function() {
    const definitions = YAML.load('./api/swagger/swagger.yaml').definitions;

    ['Settings', 'SettingsResponse'].forEach(definitionName => {
      const properties = definitions[definitionName].properties;
      expect(properties.communicationSupport).to.include({ type: 'object' });
      expect(properties.tuyujia).to.include({ type: 'object' });
    });
  });
});
