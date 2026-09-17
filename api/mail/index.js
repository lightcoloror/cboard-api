'use strict';

var User = require('../models/User');
var config = require('../../config');
var mongoose = require('mongoose');
var nev = require('./email-verification')(mongoose);
var bcrypt = require('bcryptjs');

const nevInstance = configNev('en');

function configNev(locale) {
  const care = process.env.CARE_COLLABORATION_ENABLED === 'true';
  var myHasher = function(password, tempUserData, insertTempUser, callback) {
    bcrypt.genSalt(8, function(err, salt) {
      bcrypt.hash(password, salt, function(err, hash) {
        return insertTempUser(hash, tempUserData, callback);
      });
    });
  };

  var subject, html, text;

  switch (locale) {
    case 'en':
      subject = 'Cboard - Please confirm account';
      (html =
        'Thanks for signup to Cboard!<br>Click the following link to confirm your account:</p><p>${URL}</p><br>Thanks,<br>The Cboard team'),
        (text =
          'Thanks for signup to Cboard!. Please confirm your account by clicking the following link: ${URL}');
      break;
    case 'es':
      (subject = 'Por favor, confirma tu cuenta'),
        (html =
          'Pulsa el enlace siguiente para confirmar tu cuenta:</p><p>${URL}</p>'),
        (text =
          'Por favor, confirma tu cuenta pulsando el enlace siguiente: ${URL}');
      break;
    default:
      subject = 'Cboard - Please confirm account';
      (html =
        'Thanks for signup to Cboard!<br>Click the following link to confirm your account:</p><p>${URL}</p><br>Thanks,<br>The Cboard team'),
        (text =
          'Thanks for signup to Cboard!. Please confirm your account by clicking the following link: ${URL}');
  }
  if (care) {
    subject = '图语家 — 验证邮箱';
    html = '<p>请打开以下链接，完成图语家账号的邮箱验证：</p><p>${URL}</p><p>如果不是您发起的注册，请忽略此邮件。请勿转发验证链接。</p>';
    text = '请打开以下链接，完成图语家账号的邮箱验证：${URL}。如果不是您发起的注册，请忽略此邮件。请勿转发验证链接。';
  }
  nev.configure(
    {
      verificationURL: '${DOMAIN}/activate/${URL}',
      resetPasswordURL: '${DOMAIN}/reset/${USERID}/${URL}',
      URLLength: 16,

      // mongo-stuff
      persistentUserModel: User,
      emailFieldName: 'email',
      passwordFieldName: 'password',
      URLFieldName: 'GENERATED_VERIFYING_URL',
      expirationTime: 86400, //1 day

      // emailing options
      transportOptions: config.emailTransport,
      verifyMailOptions: {
        from: config.emailTransport.from,
        subject: subject,
        html: html,
        text: text
      },
      shouldSendConfirmation: true,
      confirmMailOptions: care ? {
        from: config.emailTransport.from,
        subject: '图语家 — 邮箱验证成功',
        html: '<p>您的图语家账号已完成邮箱验证，可以返回应用登录。</p>',
        text: '您的图语家账号已完成邮箱验证，可以返回应用登录。'
      } : {
        from: config.emailTransport.from,
        subject: 'Cboard - Successfully verified!',
        html: '<p>Your account at Cboard has been successfully verified.</p>',
        text: 'Your account at Cboard has been successfully verified.'
      },
      resetPasswordMailOptions: care ? {
        from: config.emailTransport.from,
        subject: '图语家 — 重置密码',
        html: '<p>您申请了重置图语家账号密码。请打开以下链接设置新密码：</p><p>${URL}</p><p>如果不是您发起的请求，请忽略此邮件。请勿转发重置链接。</p>',
        text: '您申请了重置图语家账号密码。请打开以下链接设置新密码：${URL}。如果不是您发起的请求，请忽略此邮件。请勿转发重置链接。'
      } : {
        from: config.emailTransport.from,
        subject: 'Cboard - Password reset',
        html:
          '<p>A request was submitted to reset the password of your Cboard account. </p> \
        <p>This request will expire in 24 hours. Please set a new password as soon as possible.</p> \
        <p>Please reset your account by clicking <a href = "${URL}">this link</a>. </p> \
        <p>If you are unable to do so, copy and paste the following link into your browser:</p><p>${URL}</p>',
        text:
          'A request was submitted to reset the password of your Cboard account. \
        This request will expire in 24 hours. Please set a new password as soon as possible. \
        Please reset your account by clicking ${URL} \
        If you are unable to do so, copy and paste the following link into your browser: ${URL}'
      },
      hashingFunction: myHasher
    },
    function(err, options) {
      if (err) {
        console.log(err);
        return;
      }
      console.log('configured: ' + (typeof options === 'object'));
    }
  );

  nev.generateTempUserModel(User, function(err, tempUserModel) {
    if (err) {
      console.log(err);
      return;
    }
    console.log(
      'generated temp user model: ' + (typeof tempUserModel === 'function')
    );
  });
  return nev;
};

module.exports = {
  nev: nevInstance
}
