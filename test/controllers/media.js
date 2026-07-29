const request = require('supertest');
const chai = require('chai');

const helper = require('../helper');

const fs = require('fs');
const { expect } = require('chai');

//Parent block
describe('media API calls', function() {
  let server;

  before(async function() {
    helper.prepareNodemailerMock(); //enable mockery and replace nodemailer with nodemailerMock
    server = require('../../app'); //register mocks before require the original dependency
  });

  after(async function() {
    helper.prepareNodemailerMock(true);
    await helper.deleteMochaUsers();
  });

  describe('POST /media', function() {
    before(async function() {
      user = await helper.prepareUser(server, {
        role: 'user',
        email: helper.generateEmail()
      });
    });

    it('it should NOT post a media file without authToken.', async function() {
      const res = await request(server)
        .post('/media')
        .set('Accept', 'image/webp,*/*')
        .set(
          'Content-Disposition',
          'form-data; name="file"; filename="postman.png"'
        )
        .set(
          'Content-Type',
          'image/png',
          'multipart/form-data; boundary=---------------------------5993600411909833853278497880'
        )
        .attach(
          'file',
          fs.readFileSync('./public/images/postman.png'),
          'postman.png'
        )
        .expect(403);
    });

    it('it should post a media file.', async function() {
      const res = await request(server)
        .post('/media')
        .set('Authorization', 'Bearer ' + user.token)
        .set('Accept', 'image/webp,*/*')
        .set(
          'Content-Disposition',
          'form-data; name="file"; filename="postman.png"'
        )
        .set(
          'Content-Type',
          'image/png',
          'multipart/form-data; boundary=---------------------------5993600411909833853278497880'
        )
        .attach(
          'file',
          fs.readFileSync('./public/images/postman.png'),
          'postman.png'
        )
        .expect(200);

      res.body.url.should.be.a('string');
    });

    it('it should post a supported short video.', async function() {
      const video = Buffer.from([
        0x00,
        0x00,
        0x00,
        0x18,
        0x66,
        0x74,
        0x79,
        0x70,
        0x69,
        0x73,
        0x6f,
        0x6d
      ]);
      const res = await request(server)
        .post('/media')
        .set('Authorization', 'Bearer ' + user.token)
        .attach('file', video, {
          filename: 'action.mp4',
          contentType: 'video/mp4'
        })
        .expect(200);

      res.body.url.should.be.a('string');
    });

    it('it should reject an unsupported file type.', async function() {
      await request(server)
        .post('/media')
        .set('Authorization', 'Bearer ' + user.token)
        .attach('file', Buffer.from('not media'), {
          filename: 'payload.txt',
          contentType: 'text/plain'
        })
        .expect(400);
    });
  });
});
