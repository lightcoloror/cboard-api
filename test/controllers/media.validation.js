const { expect } = require('chai');

const { isSupportedMediaUpload } = require('../../api/controllers/media');

describe('media upload validation', function() {
  it('accepts bounded images, recordings, and short videos', function() {
    expect(isSupportedMediaUpload({ mimetype: 'image/gif', size: 1 })).to.equal(
      true
    );
    expect(
      isSupportedMediaUpload({ mimetype: 'audio/mpeg', size: 1024 })
    ).to.equal(true);
    expect(
      isSupportedMediaUpload({ mimetype: 'video/mp4', size: 8 * 1024 * 1024 })
    ).to.equal(true);
    expect(
      isSupportedMediaUpload({
        mimetype: 'video/webm',
        buffer: Buffer.from([1])
      })
    ).to.equal(true);
  });

  it('rejects unknown, empty, and oversized files', function() {
    expect(isSupportedMediaUpload({ mimetype: 'text/html', size: 1 })).to.equal(
      false
    );
    expect(isSupportedMediaUpload({ mimetype: 'video/mp4', size: 0 })).to.equal(
      false
    );
    expect(
      isSupportedMediaUpload({
        mimetype: 'video/mp4',
        size: 8 * 1024 * 1024 + 1
      })
    ).to.equal(false);
  });
});
