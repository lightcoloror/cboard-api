const chai = require('chai');
const mongoose = require('mongoose');

const expect = chai.expect;
const User = require('../../api/models/User');
const createEmailVerification = require('../../api/mail/email-verification');
const {
  isDuplicateMainlandChinaPhoneError,
  isValidMainlandChinaPhone,
  maskMainlandChinaPhone,
  normalizeMainlandChinaPhone,
  parseOptionalMainlandChinaPhone
} = require('../../api/helpers/userPhone');

describe('user phone privacy helpers', function() {
  it('reuses the PicInterpreter normalization, validation and masking rules', function() {
    expect(normalizeMainlandChinaPhone('138 0013 8000')).to.equal(
      '13800138000'
    );
    expect(isValidMainlandChinaPhone('138 0013 8000')).to.equal(true);
    expect(isValidMainlandChinaPhone('2800138000')).to.equal(false);
    expect(maskMainlandChinaPhone('13800138000')).to.equal('138****8000');
  });

  it('keeps the global CBoard registration path compatible when phone is omitted', function() {
    expect(parseOptionalMainlandChinaPhone('')).to.deep.equal({
      provided: false,
      valid: true,
      phone: ''
    });
    expect(parseOptionalMainlandChinaPhone('2800138000')).to.deep.equal({
      provided: true,
      valid: false,
      phone: '2800138000'
    });
  });

  it('recognizes only Mongo duplicate errors for the phone index', function() {
    expect(
      isDuplicateMainlandChinaPhoneError({
        code: 11000,
        keyPattern: { phone: 1 }
      })
    ).to.equal(true);
    expect(
      isDuplicateMainlandChinaPhoneError({
        code: 11000,
        message: 'duplicate key index: phone_1'
      })
    ).to.equal(true);
    expect(
      isDuplicateMainlandChinaPhoneError({
        code: 11000,
        keyPattern: { email: 1 }
      })
    ).to.equal(false);
    expect(isDuplicateMainlandChinaPhoneError(new Error('storage'))).to.equal(
      false
    );
  });

  it('normalizes storage and never serializes the raw phone number', function() {
    const user = new User({
      name: 'Caregiver',
      email: 'care@example.test',
      password: 'secret',
      phone: '138 0013 8000'
    });

    expect(user.phone).to.equal('13800138000');
    expect(user.authVersion).to.equal(0);
    expect(user.toJSON()).to.include({ phoneMasked: '138****8000' });
    expect(user.toJSON()).not.to.have.property('phone');
    expect(user.toJSON()).not.to.have.property('authVersion');
    const phoneIndex = User.schema
      .indexes()
      .find(item => item[1].name === 'phone_1');
    expect(phoneIndex[0]).to.deep.equal({ phone: 1 });
    expect(phoneIndex[1]).to.include({ unique: true, sparse: true });
  });

  it('copies the phone uniqueness index to pending registrations', async function() {
    const isolatedMongoose = new mongoose.Mongoose();
    const verification = createEmailVerification(isolatedMongoose);
    const TempUser = await new Promise((resolve, reject) => {
      verification.generateTempUserModel(User, (error, model) => {
        if (error) reject(error);
        else resolve(model);
      });
    });
    const phoneIndex = TempUser.schema
      .indexes()
      .find(item => item[1].name === 'phone_1');

    expect(phoneIndex[0]).to.deep.equal({ phone: 1 });
    expect(phoneIndex[1]).to.include({ unique: true, sparse: true });
  });
});
