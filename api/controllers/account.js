const User = require('../models/User');
const Settings = require('../models/Settings');
const Communicator = require('../models/Communicator');
const Board = require('../models/Board');
const Subscribers = require('../models/Subscribers');
const CommunicationReceiverRecord = require('../models/CommunicationReceiverRecord');
const CommunicationSavedPhrase = require('../models/CommunicationSavedPhrase');
const CommunicationAiUsage = require('../models/CommunicationAiUsage');
const {
  deletePrivateLibraryForUser
} = require('./communicationPrivateLibrary');
const {
  deletePrivateDeviceDataForUser
} = require('./communicationPrivateDeviceData');

const { getAuthDataFromReq } = require('../helpers/auth');

module.exports = {
  removeAccount
};

async function removeAccount(req, res) {
  const id = req.swagger.params.id.value;

  //this would be implemented like a middleware
  const { requestedBy, isAdmin: isRequestedByAdmin } = getAuthDataFromReq(req);

  if (!isRequestedByAdmin && (!requestedBy || id != requestedBy)) {
    return res.status(401).json({
      message: 'Error deleting the account',
      error:
        'Unauthorized request, delete account is only accessible using admin or owner user authToken'
    });
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
    console.error(error);
    return res.status(500).json({
      message: 'Error deleting private account archive backup'
    });
  }

  try {
    const user = await User.findByIdAndRemove(id);
    response.user = user;
  } catch (error) {
    console.error(error);
    return res.status(404).json({
      message: 'User not found. User Id: ' + id
    });
  }

  try {
    const setting = await Settings.findOneAndDelete({ user: id });
    response.setting = setting;
  } catch (error) {
    console.error(error);
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
    console.error(error);
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
    console.error(error);
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
    console.error(error);
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
    console.error(error);
    return res.status(500).json({
      message: 'Error deleting communication AI token quota'
    });
  }

  try {
    const deletedComunicators = await Communicator.deleteMany({
      email: response.user.email
    });
    response.deletedComunicators = deletedComunicators.deletedCount;
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: 'Error deleting user communicator'
    });
  }

  try {
    const deletedBoards = await Board.deleteMany({
      email: response.user.email
    });
    response.deletedBoards = deletedBoards.deletedCount;
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: 'Error deleting user communicator'
    });
  }

  try {
    const subscriber = await Subscribers.findOneAndRemove({ userId: id });
    response.subscriber = subscriber;
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: 'Error deleting user subscriber'
    });
  }

  return res.status(200).json(response);
}
