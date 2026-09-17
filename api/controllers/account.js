const User = require('../models/User');
const Settings = require('../models/Settings');
const Communicator = require('../models/Communicator');
const Board = require('../models/Board');
const Subscribers = require('../models/Subscribers');
const CommunicationReceiverRecord = require('../models/CommunicationReceiverRecord');
const CommunicationSavedPhrase = require('../models/CommunicationSavedPhrase');
const CommunicationAiUsage = require('../models/CommunicationAiUsage');
const ResetPassword = require('../models/ResetPassword');
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
const { requireSelfOrAdmin } = require('../helpers/userAccess');

module.exports = {
  removeAccount,
  cleanupAccountData
};

function cleanupFailure(message, code) {
  const error = new Error(message);
  error.status = 500;
  error.code = code || 'ACCOUNT_CLEANUP_FAILED';
  if (code) error.responseError = { code };
  return error;
}

async function cleanupAccountData({
  id,
  userEmail,
  quotaService,
  privateLibraryCleanup = deletePrivateLibraryForUser,
  privateDeviceCleanup = deletePrivateDeviceDataForUser
}) {
  const response = {};
  try {
    response.deletedCommunicationPrivateLibrary = await privateLibraryCleanup(id);
    response.deletedCommunicationPrivateDeviceData = await privateDeviceCleanup(id);
  } catch (_) {
    throw cleanupFailure('Error deleting private account archive backup');
  }

  try {
    await Settings.findOneAndDelete({ user: id });
  } catch (_) {
    throw cleanupFailure('Error deleting user setting');
  }

  try {
    const result = await CommunicationReceiverRecord.deleteMany({ user: id });
    response.deletedCommunicationReceiverRecords = result.deletedCount;
  } catch (_) {
    throw cleanupFailure('Error deleting confirmed receiver records');
  }

  try {
    const result = await CommunicationSavedPhrase.deleteMany({ user: id });
    response.deletedCommunicationSavedPhrases = result.deletedCount;
  } catch (_) {
    throw cleanupFailure('Error deleting communication saved phrases');
  }

  try {
    const result = await CommunicationAiUsage.deleteMany({ user: id });
    response.deletedCommunicationAiUsage = result.deletedCount;
  } catch (_) {
    throw cleanupFailure('Error deleting communication AI usage');
  }

  try {
    const result = await ResetPassword.deleteMany({ userId: String(id) });
    response.deletedPasswordResetRecords = result.deletedCount;
  } catch (_) {
    throw cleanupFailure('Error deleting password reset records');
  }

  try {
    response.deletedCommunicationAiTokenQuota = quotaService &&
      typeof quotaService.deleteUserQuota === 'function'
      ? await quotaService.deleteUserQuota({ userId: id })
      : false;
  } catch (_) {
    throw cleanupFailure('Error deleting communication AI token quota');
  }

  try {
    const result = await Communicator.deleteMany({ email: userEmail });
    response.deletedComunicators = result.deletedCount;
  } catch (_) {
    throw cleanupFailure('Error deleting user communicator');
  }

  try {
    const result = await Board.deleteMany({ email: userEmail });
    response.deletedBoards = result.deletedCount;
  } catch (_) {
    throw cleanupFailure('Error deleting user communicator');
  }

  try {
    await Subscribers.findOneAndRemove({ userId: id });
  } catch (_) {
    throw cleanupFailure('Error deleting user subscriber');
  }

  try {
    const result = await CareAccount.deleteOne({ _id: id });
    response.deletedCareAccount = result.deletedCount;
  } catch (_) {
    throw cleanupFailure('Error deleting care account data', 'CARE_ACCOUNT_CLEANUP_FAILED');
  }
  return response;
}

async function removeAccount(req, res) {
  const id = req.swagger.params.id.value;

  const access = requireSelfOrAdmin(req, id);
  if (!access.ok) return res.status(access.status).json(access.body);
  const actorId = access.id;

  if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true') {
    return res.status(409).json({
      error: { code: 'CLOSURE_CONFIRMATION_REQUIRED' }
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

  let response;
  try {
    response = await cleanupAccountData({
      id,
      userEmail,
      quotaService: req.communicationAiTokenQuotaService
    });
  } catch (error) {
    console.error('Account deletion cleanup failed.');
    return res.status(error.status || 500).json({
      message: error.message,
      ...(error.responseError ? { error: error.responseError } : {})
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
