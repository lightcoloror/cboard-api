'use strict';

module.exports = {
  loginUserWithPhone(req, res) {
    return res.status(200).json({
      id: '507f1f77bcf86cd799439011',
      email: 'care@example.test',
      phoneMasked: '138****8000',
      authToken: 'test-auth-token'
    });
  },
  resetPasswordWithPhone(req, res) {
    return res.status(200).json({
      success: 1,
      message: 'Password reset. Please sign in again.'
    });
  }
};
