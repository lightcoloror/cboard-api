'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const bcrypt = require('bcryptjs');
const db = require('../db');
const User = require('../api/models/User');
const Settings = require('../api/models/Settings');

const email = process.env.LOCAL_RUNTIME_USER_EMAIL || 'local.runtime@example.com';
const password = process.env.LOCAL_RUNTIME_USER_PASSWORD || 'ChangeMe123!';
const name = process.env.LOCAL_RUNTIME_USER_NAME || 'Local Runtime User';

async function waitForConnection() {
  if (db.readyState === 1) {
    return;
  }

  await new Promise((resolve, reject) => {
    db.once('connected', resolve);
    db.once('error', reject);
  });
}

async function main() {
  await waitForConnection();

  const hashedPassword = await bcrypt.hash(password, 10);
  let user = await User.findOne({ email }).exec();

  if (!user) {
    user = new User({
      name,
      email,
      password: hashedPassword,
      role: 'user',
      locale: 'en-US',
      provider: '',
      isFirstLogin: false
    });
  } else {
    user.name = name;
    user.password = hashedPassword;
    user.provider = '';
    user.isFirstLogin = false;
  }

  await user.save();

  const settings = await Settings.getOrCreate({ id: user.id });
  if (!settings.communicationSupport) {
    await Settings.findByIdAndUpdate(settings.id, {
      communicationSupport: {
        savedPhrases: [],
        history: []
      }
    }).exec();
  }

  console.log(
    JSON.stringify(
      {
        email,
        password,
        userId: user.id
      },
      null,
      2
    )
  );
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
