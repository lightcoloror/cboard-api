'use strict';

const assert = require('assert').strict;
const crypto = require('crypto');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { createCareFileMedia } = require('../../api/helpers/careFileMedia');

describe('care file media named publication', function() {
  it('publishes one complete named object without replacing a concurrent writer', async function() {
    const root = path.join(os.tmpdir(), `care-file-media-${crypto.randomBytes(12).toString('hex')}`);
    const name = `${'a'.repeat(48)}.bin`;
    const media = createCareFileMedia(root);
    try {
      const first = Buffer.from('complete-first'); const second = Buffer.from('complete-second');
      const results = await Promise.all([media.writeNamed(name, first), media.writeNamed(name, second)]);
      assert.equal(results.filter(value => value.created).length, 1);
      assert.equal(results.filter(value => !value.created).length, 1);
      const stored = await media.read(name);
      assert([first, second].some(value => stored.equals(value)));
      assert.deepEqual(await fs.readdir(root), [name]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('keeps a deletion marker through both old-writer windows', async function() {
    const root = path.join(os.tmpdir(), `care-file-media-${crypto.randomBytes(12).toString('hex')}`);
    const beforeName = `${'b'.repeat(48)}.bin`; const afterName = `${'c'.repeat(48)}.bin`;
    const media = createCareFileMedia(root);
    try {
      // The marker already exists when the old writer begins publishing.
      await media.remove(beforeName);
      await assert.rejects(media.writeNamed(beforeName, Buffer.from('old-before')), error => error.code === 'MEDIA_FILE_DELETED');

      // Inject deletion immediately after the hard-link publish. The adapter's
      // post-publish marker check must remove that canonical object itself.
      const originalLink = fs.link;
      fs.link = async (...args) => { await originalLink(...args); await media.remove(afterName); };
      try {
        await assert.rejects(media.writeNamed(afterName, Buffer.from('old-after')), error => error.code === 'MEDIA_FILE_DELETED');
      } finally { fs.link = originalLink; }
      await assert.rejects(media.read(afterName), error => error.code === 'MEDIA_FILE_DELETED');
      const names = await fs.readdir(root);
      assert(names.includes(`${beforeName}.deleted`));
      assert(names.includes(`${afterName}.deleted`));
      assert.equal(names.some(name => name === afterName), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
