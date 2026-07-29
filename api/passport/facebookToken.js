const passport = require('passport');
const FacebookTokenStrategy = require('passport-facebook-token');
const config = require('../../config');
const UserController = require('../controllers/user');
const {
  hasRequiredStrategyConfig,
  warnStrategyDisabled
} = require('./strategyUtils');

const FBStrategy = {
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    fbGraphVersion: 'v3.0',
    passReqToCallback: true
  };

const isFacebookTokenStrategyEnabled = hasRequiredStrategyConfig([
  FBStrategy.clientID,
  FBStrategy.clientSecret
]);

if (isFacebookTokenStrategyEnabled) {
  passport.use(
    new FacebookTokenStrategy(FBStrategy, UserController.facebookLogin)
  );
} else {
  warnStrategyDisabled('facebook-token');
}

const configureFacebookTokenStrategy = app => {
    if (!isFacebookTokenStrategyEnabled) {
      return;
    }

    app.get(
      '/login/facebooktoken/callback',
      passport.authenticate('facebook-token', {
        failureRedirect: '/',
        session: false
      }),
      (req, res) => {
        res.json(req.user);
      }
    );
};
  
module.exports = {
    configureFacebookTokenStrategy
};
