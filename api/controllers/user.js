const moment = require('moment');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const { paginatedResponse } = require('../helpers/response');
const { getORQuery } = require('../helpers/query');
const User = require('../models/User');
const ResetPassword = require('../models/ResetPassword');
const Settings = require('../models/Settings');
const { nev } = require('../mail');
const auth = require('../helpers/auth');
const { findIpLocation, isLocalIp } = require('../helpers/localize');
const Subscribers = require('../models/Subscribers');
const {
  isDuplicateMainlandChinaPhoneError,
  parseOptionalMainlandChinaPhone
} = require('../helpers/userPhone');
const {
  phoneVerificationService
} = require('../helpers/phoneVerificationRuntime');
const {
  compareResetToken,
  hashNewPassword,
  hashResetToken,
  normalizeNewPassword,
  normalizeResetToken
} = require('../helpers/passwordReset');

const config = require('../../config');
const {
  CBOARD_PROD_URL,
  CBOARD_QA_URL,
  LOCALHOST_PORT_3000_URL,
  INTERNAL_API_KEY
} = config;

function hasValidInternalApiKey(req) {
  if (!INTERNAL_API_KEY) return false;

  const authHeader = req.get('Authorization') || '';
  if (authHeader.indexOf('Bearer ') !== 0) return false;

  const providedKey = authHeader.slice('Bearer '.length);
  const providedBuffer = Buffer.from(providedKey);
  const expectedBuffer = Buffer.from(INTERNAL_API_KEY);

  if (providedBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

module.exports = {
  createUser: createUser,
  activateUser: activateUser,
  listUser: listUser,
  removeUser: removeUser,
  getUser: getUser,
  updateUser: updateUser,
  loginUser: loginUser,
  loginUserWithPhone: loginUserWithPhone,
  logoutUser: logoutUser,
  getMe: getMe,
  facebookLogin: facebookLogin,
  googleLogin: googleLogin,
  appleLogin,
  googleIdTokenLogin,
  forgotPassword: forgotPassword,
  storePassword: storePassword,
  resetPasswordWithPhone: resetPasswordWithPhone,
  proxyOauth: proxyOauth
};

const USER_MODEL_ID_TYPE = {
  facebook: 'facebook.id',
  google: 'google.id',
  apple: 'apple.id'
};

function mapLeanBoardIds(boards) {
  if (!Array.isArray(boards)) return boards;
  return boards.map(board => {
    if (!board || typeof board !== 'object' || !board._id) return board;
    const { _id, __v, ...rest } = board;
    return { ...rest, id: _id };
  });
}

async function getSettings(user) {
  let settings = null;

  try {
    settings = await Settings.getOrCreate({ id: user.id || user._id });
    delete settings.user;
  } catch (e) {}

  return settings;
}

async function getSubscriber(user) {
  let subscriber = null;
  try {
    subscriber = await Subscribers.getByUserId({ id: user.id || user._id });
  } catch (e) {}

  if (subscriber) {
    const product = {
      title: subscriber.product?.title,
      billingPeriod: subscriber.product?.billingPeriod,
      price: subscriber.product?.price
    };
    return {
      id: subscriber._id,
      status: subscriber.status,
      expiryDate: subscriber.transaction?.expiryDate || null,
      product
    };
  }

  return {};
}

async function createUser(req, res) {
  const phoneVerificationToken = req.body.phoneVerificationToken;
  delete req.body.phoneVerificationToken;
  const phoneInput = parseOptionalMainlandChinaPhone(req.body.phone);
  if (!phoneInput.valid) {
    return res.status(400).json({
      message: 'Please enter a valid 11-digit mainland China phone number.'
    });
  }

  if (phoneInput.provided) {
    try {
      const TempUser = nev.options.tempUserModel;
      const [persistentUser, temporaryUser] = await Promise.all([
        User.findOne({ phone: phoneInput.phone }).exec(),
        TempUser ? TempUser.findOne({ phone: phoneInput.phone }).exec() : null
      ]);
      if (persistentUser || temporaryUser) {
        return res.status(409).json({
          message: 'This phone number is already registered.'
        });
      }
      await phoneVerificationService.consumeRegistrationVerification({
        phone: phoneInput.phone,
        token: phoneVerificationToken
      });
      req.body.phone = phoneInput.phone;
    } catch (error) {
      if (/^PHONE_VERIFICATION_[A-Z_]+$/.test(String(error.code || ''))) {
        return res.status(error.status || 503).json({
          message: error.message,
          error: { code: error.code }
        });
      }
      return res.status(500).json({
        message: 'Unable to validate the phone number.'
      });
    }
  } else {
    delete req.body.phone;
  }

  try {
    if (!isLocalIp(req.ip)) req.body.location = await findIpLocation(req.ip);
  } catch (error) {
    console.error(error.message);
  }
  req.body.isFirstLogin = true;
  const user = new User(req.body);
  nev.createTempUser(user, function(err, existingPersistentUser, newTempUser) {
    if (err) {
      if (isDuplicateMainlandChinaPhoneError(err)) {
        return res.status(409).json({
          message: 'This phone number is already registered.'
        });
      }
      return res.status(500).json({
        message: 'Unable to create the account.'
      });
    }
    // user already exists in persistent collection
    if (existingPersistentUser) {
      return res.status(409).json({
        message:
          'You have already signed up and confirmed your account. Did you forget your password?'
      });
    }
    // new user created
    if (newTempUser) {
      const URL = newTempUser[nev.options.URLFieldName];

      let domain = req.headers.origin;

      const isValidDomain = domain =>
        [CBOARD_PROD_URL, CBOARD_QA_URL, LOCALHOST_PORT_3000_URL].includes(
          domain
        );
      //if origin is private insert default hostname
      if (!domain || !isValidDomain(domain)) {
        domain = CBOARD_PROD_URL;
      }

      nev.sendVerificationEmail(newTempUser.email, domain, URL, function(
        err,
        info
      ) {
        if (err) {
          return res.status(500).json({
            message: 'ERROR: sending verification email FAILED ' + info
          });
        }

        return res.status(200).json({
          success: 1,
          url: URL,
          message:
            'An email has been sent to you. Please check it to verify your account.'
        });
      });

      // user already exists in temporary collection!
    } else {
      return res.status(409).json({
        message:
          'You have already signed up. Please check your email to verify your account.'
      });
    }
  });
}

async function proxyOauth(req, res) {
  if (!hasValidInternalApiKey(req)) {
    return res.status(401).json({
      message: 'Not authorized to use the OAuth proxy endpoint.'
    });
  }

  const { accessToken, refreshToken, profile } = req.body;
  const provider = req.swagger.params.provider.value;
  return passportLogin(
    '',
    provider,
    accessToken,
    refreshToken,
    profile,
    (req, authRes) => {
      res.json(authRes);
    }
  );
}
// Login from Facebook or Google
async function passportLogin(
  ip,
  type,
  accessToken,
  refreshToken,
  profile,
  done
) {
  try {
    const propertyId = USER_MODEL_ID_TYPE[type];
    let user = await User.findOne({ [propertyId]: profile.id })
      .populate('communicators')
      .populate({ path: 'boards', options: { lean: true } })
      .exec();

    if (!user) {
      user = await createOrUpdateUser(accessToken, profile, type);
      await user
        .populate('communicators')
        .populate({ path: 'boards', options: { lean: true } })
        .execPopulate();
    }

    if (!user.location || !user.location.country)
      try {
        await updateUserLocation(ip, user);
      } catch (error) {
        console.error(error.message);
      }

    const { _id: userId, email } = user;
    const tokenString = auth.issueToken({
      id: userId,
      email,
      authVersion: user.authVersion
    });

    const settings = await getSettings(user);
    const subscriber = await getSubscriber(user);

    const userJSON = user.toJSON();
    userJSON.boards = mapLeanBoardIds(userJSON.boards);
    const response = {
      ...userJSON,
      settings,
      subscriber,
      authToken: tokenString
    };

    done(null, response);
  } catch (err) {
    console.error('Passport Login error', err);
    return done(err);
  }
}

async function facebookLogin(req, accessToken, refreshToken, profile, done) {
  const ip = req.ip;
  return passportLogin(
    ip,
    'facebook',
    accessToken,
    refreshToken,
    profile,
    done
  );
}

async function googleLogin(req, accessToken, refreshToken, profile, done) {
  const ip = req.ip;
  return passportLogin(ip, 'google', accessToken, refreshToken, profile, done);
}

async function appleLogin(
  req,
  accessToken,
  refreshToken,
  idToken,
  profile,
  done
) {
  const decodedUser = jwt.decode(idToken);
  const appleProfile = {
    id: decodedUser.sub,
    accessToken: accessToken,
    gender: null,
    displayName: profile?.fullName?.nickName,
    name: profile?.name?.givenName,
    lastname: profile?.name?.familyName,
    email: decodedUser.email,
    emails: profile?.emails || [{ value: decodedUser.email }],
    photos: profile?.photos?.map(photo => photo.value)
  };
  const ip = req.ip;
  return passportLogin(
    ip,
    'apple',
    accessToken,
    refreshToken,
    appleProfile,
    done
  );
}

async function googleIdTokenLogin(req, res) {
  const client = new OAuth2Client();
  const id_token = req.query.id_token;
  async function verify() {
    const ticket = await client.verifyIdToken({
      idToken: id_token,
      audience: [
        process.env.GOOGLE_FIREBASE_SIGN_IN_APP_ID,
        process.env.GOOGLE_FIREBASE_WEB_CLIENT_ID
      ]
      // Or, if multiple clients access the backend:
      //[CLIENT_ID_1, CLIENT_ID_2, CLIENT_ID_3]
    });
    return ticket.getPayload();
  }
  try {
    const profile = await verify();
    const googleProfile = {
      id: profile.sub,
      accessToken: id_token,
      gender: null,
      displayName: profile.name,
      name: profile?.given_name,
      lastname: profile?.family_name,
      email: profile.email,
      emails: [{ value: profile.email }],
      photos: [{ value: profile.picture }]
    };
    await googleLogin(req, id_token, null, googleProfile, (err, response) => {
      if (err) {
        console.error(err);
        res
          .status(500)
          .json({ message: 'Something went wrong on Google Id Token login' });
        return;
      }
      if (response.authToken) res.json(response);
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: 'Something went wrong on Google Id Token login' });
    return;
  }
}

async function createOrUpdateUser(accessToken, profile, type = 'facebook') {
  const fnMap = {
    facebook: {
      create: 'createUserFromFacebook',
      update: 'updateUserFromFacebook'
    },
    google: {
      create: 'createUserFromGoogle',
      update: 'updateUserFromGoogle'
    },
    apple: {
      create: 'createUserFromApple',
      update: 'updateUserFromApple'
    }
  };

  const mergedProfile = { ...profile, accessToken };
  const emails = profile.emails.map(email => email.value);
  const existingUser = await User.findOne({ email: { $in: emails } }).exec();

  const userModelFn = existingUser ? fnMap[type].update : fnMap[type].create;
  const user = await User[userModelFn](mergedProfile, existingUser);

  return user;
}

function activateUser(req, res) {
  const url = req.swagger.params.url.value;
  nev.confirmTempUser(url, function(err, user) {
    if (user) {
      nev.sendConfirmationEmail(user.email, function(err, info) {
        if (err) {
          return res.status(404).json({
            message: 'ERROR: sending confirmation email FAILED ' + info
          });
        }
        return res.status(200).json({
          success: 1,
          userid: user._id,
          message: 'CONFIRMED!'
        });
      });
    } else {
      return res.status(404).json({
        message:
          'ERROR: confirming your temporary user FAILED, please try to login again',
        error:
          'ERROR: confirming your temporary user FAILED, please try to login again'
      });
    }
  });
}

async function listUser(req, res) {
  const { search = '' } = req.query;
  const searchFields = ['name', 'author', 'email'];
  const query =
    search && search.length ? getORQuery(searchFields, search, true) : {};

  const response = await paginatedResponse(
    User,
    {
      query
    },
    req.query
  );

  return res.status(200).json(response);
}

function removeUser(req, res) {
  const id = req.swagger.params.id.value;
  User.findByIdAndRemove(id, function(err, users) {
    if (err) {
      return res.status(404).json({
        message: 'User not found. User Id: ' + id
      });
    }
    return res.status(200).json(users);
  });
}

async function getUser(req, res) {
  const id = req.swagger.params.id.value;

  try {
    const user = await User.findById(id).exec();

    if (!user) {
      return res.status(404).json({
        message: `User does not exist. User Id: ${id}`
      });
    }

    const settings = await getSettings(user);
    const response = {
      ...user.toJSON(),
      settings
    };

    return res.status(200).json(response);
  } catch (err) {
    return res.status(500).json({
      message: 'Error getting user.',
      error: err.message
    });
  }
}

const UPDATEABLE_FIELDS = [
  'email',
  'name',
  'birthdate',
  'locale',
  'location',
  'isFirstLogin'
];

function updateUser(req, res) {
  const id = req.swagger.params.id.value;

  if (!req.user.isAdmin && req.auth.id !== id) {
    return res.status(403).json({
      message: 'You are not authorized to update this user.'
    });
  }

  User.findById(id).exec(async function(err, user) {
    if (err) {
      return res.status(500).json({
        message: 'Error updating user. ',
        error: err.message
      });
    }
    if (!user) {
      return res.status(404).json({
        message: 'Unable to find user. User Id: ' + id
      });
    }
    for (let key in req.body) {
      if (UPDATEABLE_FIELDS.includes(key)) {
        if (key === 'location') {
          if ((user.location && user.location.country) || isLocalIp(req.ip))
            continue;
          try {
            req.body.location = await findIpLocation(req.ip);
          } catch (error) {
            console.error(error.message);
            continue;
          }
        }

        user[key] = req.body[key];
      }
    }
    try {
      const dbUser = await user.save();
      if (!dbUser) {
        return res.status(404).json({
          message: 'Unable to find user. User id: ' + id
        });
      }
      return res.status(200).json(user);
    } catch (e) {
      return res.status(500).json({
        message: 'Error saving user. ',
        error: e.message
      });
    }
  });
}

async function completeUserLogin(req, res, user) {
  const userId = user._id;
  req.session.userId = userId;

  const tokenString = auth.issueToken({
    email: user.email,
    id: userId,
    authVersion: user.authVersion
  });

  if (!user.location || !user.location.country)
    try {
      await updateUserLocation(req.ip, user);
    } catch (error) {
      console.error(error.message);
    }

  const settings = await getSettings(user);
  const subscriber = await getSubscriber(user);

  const userJSON = user.toJSON();
  userJSON.boards = mapLeanBoardIds(userJSON.boards);
  return res.status(200).json({
    ...userJSON,
    settings,
    subscriber,
    birthdate: moment(user.birthdate).format('YYYY-MM-DD'),
    authToken: tokenString
  });
}

function sendPhoneLoginFailure(res, status = 401) {
  return res.status(status).json({
    message: 'Unable to sign in with this phone number.',
    error: { code: 'PHONE_LOGIN_FAILED' }
  });
}

function loginUser(req, res) {
  const { email, password } = req.body;

  User.authenticate(email, password, async (error, user) => {
    if (error || !user) {
      return res.status(401).json({
        message: 'Wrong email or password.'
      });
    }
    return completeUserLogin(req, res, user).catch(() =>
      res.status(500).json({ message: 'Unable to complete login.' })
    );
  });
}

async function loginUserWithPhone(req, res) {
  const body = req.body || {};
  const phoneInput = parseOptionalMainlandChinaPhone(body.phone);
  if (!phoneInput.provided || !phoneInput.valid) {
    return sendPhoneLoginFailure(res);
  }

  try {
    await phoneVerificationService.consumeLoginVerification({
      phone: phoneInput.phone,
      token: body.phoneVerificationToken
    });
  } catch (error) {
    return sendPhoneLoginFailure(
      res,
      Number(error && error.status) === 503 ? 503 : 401
    );
  }

  try {
    const user = await User.findOne({ phone: phoneInput.phone })
      .populate('communicators')
      .populate({ path: 'boards', options: { lean: true } })
      .exec();
    if (!user || user.role === 'admin') return sendPhoneLoginFailure(res);
    return completeUserLogin(req, res, user);
  } catch (error) {
    return sendPhoneLoginFailure(res, 503);
  }
}

async function updateUserLocation(ip, user) {
  if ((!user.location || !user.location.country) && !isLocalIp(ip)) {
    try {
      const newLocation = await findIpLocation(ip);
      if (newLocation && newLocation.country) {
        user.location = newLocation;
        try {
          const dbUser = await user.save();
          if (!dbUser) {
            user.location = null;
            console.log('Unable to find user on the DB');
            return;
          }
        } catch (err) {
          console.log('Error saving user location', err);
          user.location = null;
          return;
        }
      }
    } catch (error) {
      console.error(error.message);
    }
  }
}

function logoutUser(req, res) {
  if (req.session) {
    // delete session object
    req.session.destroy(err => {
      if (err) {
        return res.status(500).json({
          message: 'Error removing session .',
          error: err.message
        });
      }
    });
  }

  return res.status(200).json({
    message: 'User successfully logout'
  });
}

async function getMe(req, res) {
  if (!req.user) {
    return res
      .status(400)
      .json({ message: 'Are you logged in? Is bearer token present?' });
  }

  const settings = await getSettings(req.user);
  const response = { ...req.user, settings };

  return res.status(200).json(response);
}

const PASSWORD_RESET_REQUEST_RESPONSE = Object.freeze({
  success: 1,
  message:
    'If the account exists, password reset instructions will be sent shortly.'
});

function trustedPasswordResetDomain(origin) {
  return [CBOARD_PROD_URL, CBOARD_QA_URL, LOCALHOST_PORT_3000_URL].includes(
    origin
  )
    ? origin
    : CBOARD_PROD_URL;
}

function sendPasswordResetFailure(res, status = 400) {
  return res.status(status).json({
    message: 'Unable to reset the password.',
    error: { code: 'PASSWORD_RESET_FAILED' }
  });
}

async function forgotPassword(req, res) {
  const email = String((req.body && req.body.email) || '')
    .trim()
    .toLowerCase();
  const token = crypto.randomBytes(32).toString('hex');

  try {
    // Hash work is performed before lookup so unknown and known accounts have
    // a closer response profile and never expose the raw token in the API.
    const tokenHash = await hashResetToken(token);
    const user = email ? await User.findOne({ email }).exec() : null;
    if (user) {
      const userId = String(user.id || user._id);
      await ResetPassword.findOneAndUpdate(
        { userId },
        {
          $set: {
            resetPasswordToken: tokenHash,
            resetPasswordExpires: moment.utc().add(86400, 'seconds'),
            status: false
          }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).exec();

      try {
        nev.sendResetPasswordEmail(
          user.email,
          trustedPasswordResetDomain(req.headers.origin),
          userId,
          token,
          error => {
            if (error) console.error('Unable to send password reset email.');
          }
        );
      } catch (error) {
        console.error('Unable to send password reset email.');
      }
    }
  } catch (error) {
    console.error('Unable to prepare password reset request.');
  }

  return res.status(200).json(PASSWORD_RESET_REQUEST_RESPONSE);
}

async function storePassword(req, res) {
  const body = req.body || {};
  const userId = String(body.userid || '').trim();
  const password = normalizeNewPassword(body.password);
  const token = normalizeResetToken(body.token);
  if (!userId || !password || !token) return sendPasswordResetFailure(res);

  try {
    const now = new Date();
    const resetPassword = await ResetPassword.findOne({
      userId,
      status: false,
      resetPasswordExpires: { $gt: now }
    }).exec();
    if (
      !resetPassword ||
      !(await compareResetToken(token, resetPassword.resetPasswordToken))
    ) {
      return sendPasswordResetFailure(res);
    }

    const passwordHash = await hashNewPassword(password);
    const consumed = await ResetPassword.findOneAndUpdate(
      {
        _id: resetPassword._id,
        status: false,
        resetPasswordExpires: { $gt: now }
      },
      { $set: { status: true } },
      { new: true }
    ).exec();
    if (!consumed) return sendPasswordResetFailure(res, 409);

    const user = await User.findOneAndUpdate(
      { _id: userId },
      {
        $set: { password: passwordHash },
        $inc: { authVersion: 1 }
      },
      { new: true }
    ).exec();
    if (!user) return sendPasswordResetFailure(res);

    return res.status(200).json({
      success: 1,
      message: 'Password reset. Please sign in again.'
    });
  } catch (error) {
    return sendPasswordResetFailure(res, 500);
  }
}

async function resetPasswordWithPhone(req, res) {
  const body = req.body || {};
  const phoneInput = parseOptionalMainlandChinaPhone(body.phone);
  const password = normalizeNewPassword(body.password);
  if (!phoneInput.provided || !phoneInput.valid || !password) {
    return sendPasswordResetFailure(res);
  }

  try {
    await phoneVerificationService.consumePasswordResetVerification({
      phone: phoneInput.phone,
      token: body.phoneVerificationToken
    });
  } catch (error) {
    return sendPasswordResetFailure(
      res,
      Number(error && error.status) === 503 ? 503 : 400
    );
  }

  try {
    const user = await User.findOne({ phone: phoneInput.phone }).exec();
    if (!user || user.role === 'admin') {
      return sendPasswordResetFailure(res);
    }

    await ResetPassword.updateMany(
      { userId: String(user._id), status: false },
      { $set: { status: true } }
    ).exec();

    const passwordHash = await hashNewPassword(password);
    const updated = await User.findOneAndUpdate(
      { _id: user._id, role: { $ne: 'admin' } },
      {
        $set: { password: passwordHash },
        $inc: { authVersion: 1 }
      },
      { new: true }
    ).exec();
    if (!updated) return sendPasswordResetFailure(res);

    return res.status(200).json({
      success: 1,
      message: 'Password reset. Please sign in again.'
    });
  } catch (error) {
    return sendPasswordResetFailure(res, 500);
  }
}
