'use strict';
// Optional private deployment adapter. Files contain authenticated ciphertext only.
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
function createCareFileMedia(root) {
  if (!path.isAbsolute(root || '') || path.parse(root).root === path.resolve(root)) throw new Error('CARE_MEDIA_ROOT must be a dedicated absolute directory');
  const base = path.resolve(root);
  const target = name => {
    if (!/^[a-f0-9]{48}\.bin$/.test(name || '')) throw new Error('Invalid media identifier');
    return path.join(base, name);
  };
  return {
    async write(buffer) {
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      const name = `${crypto.randomBytes(24).toString('hex')}.bin`;
      await fs.writeFile(target(name), buffer, { flag: 'wx', mode: 0o600 }); return name;
    },
    read: name => fs.readFile(target(name)),
    remove: name => fs.unlink(target(name)).catch(e => { if (e.code !== 'ENOENT') throw e; })
  };
}
exports.createCareFileMedia = createCareFileMedia;
