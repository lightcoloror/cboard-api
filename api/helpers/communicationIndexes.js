'use strict';

const Communicator = require('../models/Communicator');
const CommunicationReceiverRecord = require('../models/CommunicationReceiverRecord');
const CommunicationSavedPhrase = require('../models/CommunicationSavedPhrase');
const CommunicationPrivateLibrary = require('../models/CommunicationPrivateLibrary');
const CommunicationPrivateDeviceData = require('../models/CommunicationPrivateDeviceData');
const Settings = require('../models/Settings');
const User = require('../models/User');
const PhoneVerificationChallenge = require('../models/PhoneVerificationChallenge');
const CommunicationAiUsage = require('../models/CommunicationAiUsage');

const COMMUNICATION_INDEX_STATUSES = Object.freeze({
  PENDING: 'pending',
  BUILDING: 'building',
  READY: 'ready',
  FAILED: 'failed'
});

const REQUIRED_COMMUNICATION_MODELS = Object.freeze([
  'Communicator',
  'CommunicationReceiverRecord',
  'CommunicationSavedPhrase',
  'CommunicationPrivateLibrary',
  'CommunicationPrivateDeviceData',
  'Settings',
  'User',
  'PhoneVerificationChallenge',
  'CommunicationAiUsage'
]);

function createCommunicationIndexCoordinator(models) {
  let status = COMMUNICATION_INDEX_STATUSES.PENDING;
  let activePromise = null;
  let generation = 0;
  let indexNames = [];

  function ensure() {
    if (status === COMMUNICATION_INDEX_STATUSES.READY) {
      return Promise.resolve(indexNames.slice());
    }
    if (activePromise) return activePromise;

    status = COMMUNICATION_INDEX_STATUSES.BUILDING;
    const runGeneration = generation;
    const creation = Promise.resolve()
      .then(() =>
        Promise.all(
          REQUIRED_COMMUNICATION_MODELS.map(modelName => {
            const model = models[modelName];
            if (!model || typeof model.createIndexes !== 'function') {
              throw new Error(
                `Missing communication index model: ${modelName}`
              );
            }
            return model.createIndexes().then(() => modelName);
          })
        )
      )
      .then(names => {
        if (generation === runGeneration) {
          indexNames = names.slice();
          status = COMMUNICATION_INDEX_STATUSES.READY;
        }
        return names;
      })
      .catch(error => {
        if (generation === runGeneration) {
          status = COMMUNICATION_INDEX_STATUSES.FAILED;
        }
        throw error;
      })
      .finally(() => {
        if (activePromise === creation) activePromise = null;
      });

    activePromise = creation;
    return creation;
  }

  function markPending() {
    generation += 1;
    activePromise = null;
    indexNames = [];
    status = COMMUNICATION_INDEX_STATUSES.PENDING;
  }

  return {
    ensure,
    getStatus: () => status,
    markPending
  };
}

const coordinator = createCommunicationIndexCoordinator({
  Communicator,
  CommunicationReceiverRecord,
  CommunicationSavedPhrase,
  CommunicationPrivateLibrary,
  CommunicationPrivateDeviceData,
  Settings,
  User,
  PhoneVerificationChallenge,
  CommunicationAiUsage
});

module.exports = {
  COMMUNICATION_INDEX_STATUSES,
  REQUIRED_COMMUNICATION_MODELS,
  createCommunicationIndexCoordinator,
  ensureCommunicationIndexes: coordinator.ensure,
  getCommunicationIndexesStatus: coordinator.getStatus,
  markCommunicationIndexesPending: coordinator.markPending
};
