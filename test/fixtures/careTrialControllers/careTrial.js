'use strict';
// Loads the production handler after the route test supplies synthetic runtime
// dependencies through mockery; this fixture contains no replacement handler.
module.exports = require('../../../api/controllers/careTrial');
