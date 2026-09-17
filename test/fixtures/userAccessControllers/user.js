'use strict';

module.exports = {
  listUser: require('../../../api/controllers/user').listUser,
  getUser: require('../../../api/controllers/user').getUser,
  removeUser: require('../../../api/controllers/user').removeUser,
  updateUser: require('../../../api/controllers/user').updateUser
};
