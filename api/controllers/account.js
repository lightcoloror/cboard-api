const User = require('../models/User');
const Settings = require('../models/Settings');
const Communicator = require('../models/Communicator');
const Board = require('../models/Board');
const Subscribers = require('../models/Subscribers');
const CommunicationReceiverRecord = require('../models/CommunicationReceiverRecord');
const CommunicationSavedPhrase = require('../models/CommunicationSavedPhrase');
const CommunicationAiUsage = require('../models/CommunicationAiUsage');
const { Account: CareAccount } = require('../models/CareWorkspace');
const {
  getCareAccountDeletionBlocker
} = require('../helpers/careAccountDeletion');
const {
  deletePrivateLibraryForUser
} = require('./communicationPrivateLibrary');
const {
  deletePrivateDeviceDataForUser
} = require('./communicationPrivateDeviceData');
const deviceSessions = require('../helpers/deviceSessions');

module.exports = {
  removeAccount
};

async function removeAccount(req, res) {
  const id = req.swagger.params.id.value;

  const actorId = req.user && String(req.user.id || req.user._id || '');
  const isRequestedByAdmin = Boolean(req.user && req.user.isAdmin);

  if (!isRequestedByAdmin && (!actorId || String(id) !== actorId)) {
    return res.status(401).json({
      message: 'Error deleting the account',
      error:
        'Unauthorized request, delete account is only accessible using admin or owner user authToken'
    });
  }

  const careDeletionBlocker = await getCareAccountDeletionBlocker(id);
  if (careDeletionBlocker) {
    return res
      .status(careDeletionBlocker.status)
      .json({
        message: careDeletionBlocker.message,
        error: careDeletionBlocker.error
      });
  }

  let userEmail;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({
        message: 'User not found. User Id: ' + id
      });
    }
    userEmail = user.email;
  } catch (error) {
    console.error('Unable to verify account before deletion.');
    return res.status(503).json({
      message: 'Unable to verify account before deleting account',
      error: { code: 'ACCOUNT_LOOKUP_FAILED' }
    });
  }

  try {
    await deviceSessions.revoke(id);
  } catch (error) {
    console.error('Unable to revoke account sessions before deletion.');
    return res.status(503).json({
      message: 'Unable to revoke account sessions before deleting account',
      error: { code: 'SESSION_REVOKE_FAILED' }
    });
  }

  if (
    String(id) === actorId &&
    req.session &&
    typeof req.session.destroy === 'function'
  ) {
    try {
      await new Promise((resolve, reject) =>
        req.session.destroy(error => (error ? reject(error) : resolve()))
      );
    } catch (error) {
      console.error('Unable to destroy account server session before deletion.');
      return res.status(503).json({
        message: 'Unable to destroy account session before deleting account',
        error: { code: 'SESSION_DESTROY_FAILED' }
      });
    }
  }

  const response = {};
  try {
    response.deletedCommunicationPrivateLibrary = await deletePrivateLibraryForUser(
      id
    );
    response.deletedCommunicationPrivateDeviceData = await deletePrivateDeviceDataForUser(
      id
    );
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting private account archive backup'
    });
  }

  try {
    await Settings.findOneAndDelete({ user: id });
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting user setting'
    });
  }

  try {
    const deletedCommunicationReceiverRecords = await CommunicationReceiverRecord.deleteMany(
      { user: id }
    );
    response.deletedCommunicationReceiverRecords =
      deletedCommunicationReceiverRecords.deletedCount;
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting confirmed receiver records'
    });
  }

  try {
    const deletedCommunicationSavedPhrases = await CommunicationSavedPhrase.deleteMany(
      { user: id }
    );
    response.deletedCommunicationSavedPhrases =
      deletedCommunicationSavedPhrases.deletedCount;
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting communication saved phrases'
    });
  }

  try {
    const deletedCommunicationAiUsage = await CommunicationAiUsage.deleteMany({
      user: id
    });
    response.deletedCommunicationAiUsage =
      deletedCommunicationAiUsage.deletedCount;
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting communication AI usage'
    });
  }

  try {
    response.deletedCommunicationAiTokenQuota =
      req.communicationAiTokenQuotaService &&
      typeof req.communicationAiTokenQuotaService.deleteUserQuota ===
        'function'
        ? await req.communicationAiTokenQuotaService.deleteUserQuota({
            userId: id
          })
        : false;
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting communication AI token quota'
    });
  }

  try {
    const deletedComunicators = await Communicator.deleteMany({
      email: userEmail
    });
    response.deletedComunicators = deletedComunicators.deletedCount;
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting user communicator'
    });
  }

  try {
    const deletedBoards = await Board.deleteMany({
      email: userEmail
    });
    response.deletedBoards = deletedBoards.deletedCount;
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting user communicator'
    });
  }

  try {
    await Subscribers.findOneAndRemove({ userId: id });
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting user subscriber'
    });
  }

  try {
    const deletedCareAccount = await CareAccount.deleteOne({ _id: id });
    response.deletedCareAccount = deletedCareAccount.deletedCount;
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting care account data',
      error: { code: 'CARE_ACCOUNT_CLEANUP_FAILED' }
    });
  }

  try {
    const user = await User.findByIdAndRemove(id);
    if (!user) {
      return res.status(404).json({
        message: 'User not found. User Id: ' + id
      });
    }
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(500).json({
      message: 'Error deleting user account'
    });
  }

  return res.status(200).json(response);
}
