const passport = require('passport');
const { Strategy: GoogleTokenStrategy } = require('passport-google-token');
const config = require('../../config');
const UserController = require('../controllers/user');
const url = require('url');
const {
  hasRequiredStrategyConfig,
  warnStrategyDisabled
} = require('./strategyUtils');

const GoogleTokenStrategyConfig = {
  clientID: process.env.GOOGLE_APP_ID, //config.google.APP_ID,
  clientSecret: process.env.GOOGLE_APP_SECRET, //config.google.APP_SECRET
  passReqToCallback: true
};

const isGoogleTokenStrategyEnabled = hasRequiredStrategyConfig([
  GoogleTokenStrategyConfig.clientID,
  GoogleTokenStrategyConfig.clientSecret
]);

if (isGoogleTokenStrategyEnabled) {
  passport.use(
    new GoogleTokenStrategy(
      GoogleTokenStrategyConfig,
      UserController.googleLogin
    )
  );
} else {
  warnStrategyDisabled('google-token');
}

const configureGoogleTokenStrategy = app => {
  if (!isGoogleTokenStrategyEnabled) {
    return;
  }

  app.get(
    '/login/googletoken/callback',
    passport.authenticate('google-token', {
      failureRedirect: '/',
      session: false
    }),
    (req, res) => {
      res.json(req.user);
    }
  );
};

module.exports = {
  configureGoogleTokenStrategy
};
