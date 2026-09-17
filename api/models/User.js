'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const constants = require('../constants');
const {
  isValidMainlandChinaPhone,
  maskMainlandChinaPhone,
  normalizeMainlandChinaPhone
} = require('../helpers/userPhone');
const Schema = mongoose.Schema;
const Communicator = require('./Communicator');

const oAuthTypes = ['github', 'twitter', 'facebook', 'google', 'linkedin'];

const USER_SCHEMA_DEFINITION = {
  name: {
    type: String,
    default: ''
  },
  email: {
    type: String,
    unique: true,
    required: true,
    trim: true
  },
  phone: {
    type: String,
    trim: true,
    index: {
      name: 'phone_1',
      unique: true,
      sparse: true
    },
    set: value => normalizeMainlandChinaPhone(value) || undefined,
    validate: {
      validator: value => !value || isValidMainlandChinaPhone(value),
      message: 'Phone must be an 11-digit mainland China number'
    }
  },
  role: {
    type: String,
    default: 'user',
    required: true,
    trim: true
  },
  birthdate: {
    type: Date,
    default: Date.now
  },
  provider: {
    type: String,
    default: ''
  },
  locale: {
    type: String,
    default: constants.DEFAULT_LANG
  },
  password: {
    type: String,
    default: ''
  },
  authVersion: {
    type: Number,
    default: 0,
    min: 0
  },
  lastlogin: {
    type: Date,
    default: Date.now
  },
  google: {
    id: String,
    token: String,
    displayName: String,
    name: String,
    lastname: String,
    gender: String,
    email: String,
    emails: [{ type: String }],
    photos: [{ type: String }]
  },
  facebook: {
    id: String,
    token: String,
    gender: String,
    displayName: String,
    name: String,
    lastname: String,
    email: String,
    emails: [{ type: String }],
    photos: [{ type: String }]
  },
  apple: {
    id: String,
    token: String,
    gender: String,
    displayName: String,
    name: String,
    lastname: String,
    email: String,
    emails: [{ type: String }],
    photos: [{ type: String }]
  },
  resetPasswordToken: {
    type: String
  },
  resetPasswordExpires: {
    type: Date
  },
  location: {
    ip: String,
    country: String,
    countryCode: String,
    region: String,
    city: String
  },
  isFirstLogin: {
    type: Boolean,
    required: false
  }
};

const USER_SCHEMA_OPTIONS = {
  toObject: {
    virtuals: true
  },
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: function(doc, ret) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.password;
      delete ret.authVersion;
      ret.phoneMasked = maskMainlandChinaPhone(ret.phone);
      delete ret.phone;
      if (ret.authToken) {
        delete ret.authToken;
      }
      if (ret.location && ret.location.ip) {
        delete ret.location.ip;
      }
    }
  },
  timestamps: true
};

const userSchema = new Schema(USER_SCHEMA_DEFINITION, USER_SCHEMA_OPTIONS);

userSchema.virtual('communicators', {
  ref: 'Communicator',
  localField: 'email',
  foreignField: 'email'
});

userSchema.virtual('boards', {
  ref: 'Board',
  localField: 'email',
  foreignField: 'email'
});

userSchema.virtual('isAdmin').get(function() {
  return this.role === 'admin';
});

const validatePresenceOf = value => value && value.length;

/**
 * Validations
 */

// the below validations only apply if you are signing up traditionally

userSchema.path('name').validate(function(name) {
  if (this.skipValidation()) return true;
  return name.length;
}, 'Name cannot be blank');

userSchema.path('email').validate(function(email) {
  if (this.skipValidation()) return true;
  return email.length;
}, 'Email cannot be blank');

userSchema.path('email').validate(async function(email) {
  const User = mongoose.model('User');
  if (this.skipValidation()) {
    return true;
  }

  // Check only when it is a new user or when email field is modified
  if (this.isNew || this.isModified('email')) {
    const users = await User.find({ email }).exec();
    if (users.length > 0) {
      return false;
    }
  }

  return true;
}, 'Email already exists');

userSchema.path('password').validate(function(password) {
  if (this.skipValidation()) return true;

  const { facebook, google, apple } = this;
  if (facebook.token || google.token || apple.token) return true;

  return password.length;
}, 'Password cannot be blank');

/**
 * Pre-save hook
 */
userSchema.pre('save', function(next) {
  if (!this.isNew) return next();

  const { facebook, google, apple, password } = this;
  const isValidUser =
    validatePresenceOf(password) ||
    facebook.token ||
    google.token ||
    apple.token;

  if (!isValidUser && !this.skipValidation()) {
    next(new Error('Invalid password'));
  } else {
    next();
  }
});

/**
 * Methods
 */

userSchema.methods = {
  /**
   * Validation is not required if using OAuth
   */

  skipValidation: function() {
    return ~oAuthTypes.indexOf(this.provider);
  }
};

/**
 * Statics
 */

userSchema.statics = {
  /**
   * Authenticate input against database
   *
   * @param {String} email
   * @param {String} password
   * @param {Function} callback
  * @api private
  */
  authenticate: function(email, password, callback) {
    if (
      typeof email !== 'string' ||
      typeof password !== 'string' ||
      !email.trim() ||
      password.length === 0
    ) {
      const error = new Error('Invalid credentials.');
      error.status = 401;
      return callback(error);
    }

    const exactEmail = email.trim();
    const canonicalEmail = exactEmail.toLowerCase();
    const lookup = lookupEmail =>
      this.findOne({ email: lookupEmail })
        .populate('communicators')
        .populate({ path: 'boards', options: { lean: true } })
        .exec();
    const authenticateUser = user =>
      bcrypt.compare(password, user.password, function(err, result) {
        if (err) return callback(err);
        if (result === true) return callback(null, user);
        return callback();
      });
    const reportMissingUser = () => {
      const error = new Error('User not found.');
      error.status = 401;
      return callback(error);
    };

    lookup(exactEmail)
      .then(user => {
        if (user) return authenticateUser(user);
        if (canonicalEmail === exactEmail) return reportMissingUser();
        return lookup(canonicalEmail).then(fallbackUser => {
          if (!fallbackUser) return reportMissingUser();
          return authenticateUser(fallbackUser);
        });
      })
      .catch(error => callback(error));
  },

  updateUser: async function(user, options = {}) {
    try {
      return await user.save(options);
    } catch (e) {
      // Preserve Mongo transaction labels so the lifecycle can retry conflicts.
      if (options.session) throw e;
      return null;
    }
  },

  ensureBearerRole: async function(user, options = {}) {
    const owner = user && (user.id || user._id);
    if (!owner) return null;
    const lifecycleEnabled = options.lifecycleEnabled ||
      (() => process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED === 'true');
    const readCurrent = async session => {
      const query = this.findOne({ _id: owner });
      if (session) query.session(session);
      return query.exec();
    };
    const apply = async session => {
      const current = await readCurrent(session);
      if (!current) return null;
      if (current.role) return current;
      current.role = 'user';
      const saved = await this.updateUser(current, session ? { session } : {});
      if (!saved) {
        const error = new Error('Unable to establish user role');
        error.status = 503;
        error.code = 'USER_ROLE_UNAVAILABLE';
        throw error;
      }
      return saved;
    };
    if (!lifecycleEnabled()) return apply(null);
    const { createCareFamilyLifecycle } = require('../helpers/careFamilyLifecycle');
    const lifecycle = options.lifecycle || createCareFamilyLifecycle();
    return lifecycle.withOpenAccount(String(owner), apply);
  },

  getById: async function(id) {
    let user = null;

    try {
      user = await this.findById(id).exec();
    } catch (e) {}

    if (!user) return null;

    const authUser = user.toJSON();
    Object.defineProperty(authUser, 'authVersion', {
      value: user.authVersion,
      enumerable: false
    });
    return authUser;
  },

  // Creates an user from a Facebook Profile (+ accessToken)
  // Returns a promise
  createUserFromFacebook: async function(profile) {
    const user = getUserFromProfile(profile, 'facebook', User);
    user.isFirstLogin = true;
    const dbUser = await user.save();
    return dbUser;
  },

  // Creates an user from a Google Profile (+ accessToken)
  // Returns a promise
  createUserFromGoogle: async function(profile) {
    const user = getUserFromProfile(profile, 'google', User);
    user.isFirstLogin = true;
    const dbUser = await user.save();
    return dbUser;
  },

  createUserFromApple: async function(profile) {
    const user = getUserFromProfile(profile, 'apple', User);
    user.isFirstLogin = true;
    const dbUser = await user.save();
    return dbUser;
  },

  // Updates an user from a Facebook Profile (+ accessToken)
  // Returns a promise
  updateUserFromFacebook: async function(profile, existingUser) {
    return updateExistingUserFromOAuth(profile, existingUser, 'facebook');
  },

  // Updates an user from a Google Profile (+ accessToken)
  // Returns a promise
  updateUserFromGoogle: async function(profile, existingUser) {
    return updateExistingUserFromOAuth(profile, existingUser, 'google');
  },

  updateUserFromApple: async function(profile, existingUser) {
    return updateExistingUserFromOAuth(profile, existingUser, 'apple');
  }
};

function getUserType(profile) {
  const photos = profile.photos || [];

  const user = {
    id: profile.id,
    token: profile.accessToken,
    gender: profile.gender,
    displayName: profile.displayName,
    name: profile.name?.givenName || 'user name',
    lastname: profile.name?.familyName || 'Name',
    email: profile.emails[0].value,
    emails: profile.emails.map(email => email.value),
    photos: photos.map(photo => photo.value)
  };

  return user;
}

function getUserFromProfile(profile, type = 'facebook', Model = User) {
  const user = new Model();

  const userType = getUserType(profile);
  user[type] = userType;
  user.name = userType.displayName || userType.name;
  user.email = userType.email;
  return user;
}

function updateUserFromProfile(profile, existingUser, type = 'facebook') {
  const userType = getUserType(profile);
  existingUser[type] = userType;

  return existingUser;
}

async function updateExistingUserFromOAuth(profile, existingUser, type) {
  if (process.env.CARE_LIFECYCLE_TRANSACTIONS_ENABLED !== 'true') {
    const user = updateUserFromProfile(profile, existingUser, type);
    return user.save();
  }

  const originalId = existingUser && existingUser._id;
  const originalEmail = existingUser && existingUser.email;
  const owner = originalId && String(originalId);
  if (!owner || !originalEmail) {
    throw new Error('OAuth user identity is required');
  }

  // Keep this require lazy: User is also used by the lifecycle helper's model
  // defaults, and loading it while this module is initializing creates a cycle.
  const { createCareFamilyLifecycle } = require('../helpers/careFamilyLifecycle');
  const lifecycle = createCareFamilyLifecycle();
  return lifecycle.withOpenAccount(owner, async session => {
    const currentUser = await User.findOne({ _id: originalId, email: originalEmail })
      .session(session).exec();
    if (!currentUser) {
      const error = new Error('OAuth user is no longer available');
      error.status = 409;
      error.code = 'OAUTH_USER_NOT_FOUND';
      throw error;
    }
    const user = updateUserFromProfile(profile, currentUser, type);
    return user.save({ session });
  });
}

const User = mongoose.model('User', userSchema);

module.exports = User;
