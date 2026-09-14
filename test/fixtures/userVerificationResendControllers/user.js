'use strict';

// Keep the Swagger harness narrow while routing to the production handler.
// Loading the full controller directory would initialize unrelated controllers.
module.exports = {
  resendVerificationEmail: require('../../../api/controllers/user')
    .resendVerificationEmail
};
