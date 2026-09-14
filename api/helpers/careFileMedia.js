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
  const deletedMarker = name => `${target(name)}.deleted`;
  const staging = name => path.join(base, `.${name}.${crypto.randomBytes(16).toString('hex')}.staging`);
  const deletionError = () => Object.assign(new Error('Media file was deleted'), { code: 'MEDIA_FILE_DELETED', status: 409 });
  async function assertNotDeleted(name) {
    try {
      await fs.access(deletedMarker(name));
      throw deletionError();
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
  }
  return {
    async write(buffer) {
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      const name = `${crypto.randomBytes(24).toString('hex')}.bin`;
      await fs.writeFile(target(name), buffer, { flag: 'wx', mode: 0o600 }); return name;
    },
    // Publish only a complete file. `link` refuses to replace an existing
    // target, so concurrent recovery writers can never overwrite each other
    // and readers never observe a partially written canonical blob.
    async writeNamed(name, buffer) {
      const destination = target(name);
      const temporary = staging(name);
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      try {
        await assertNotDeleted(name);
        await fs.writeFile(temporary, buffer, { flag: 'wx', mode: 0o600 });
        await assertNotDeleted(name);
        try {
          await fs.link(temporary, destination);
          try {
            await assertNotDeleted(name);
          } catch (error) {
            await fs.unlink(destination).catch(unlinkError => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
            throw error;
          }
          return { name, created: true };
        } catch (error) {
          if (error.code === 'EEXIST') return { name, created: false };
          throw error;
        }
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    },
    async read(name) { await assertNotDeleted(name); return fs.readFile(target(name)); },
    async remove(name) {
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(deletedMarker(name), '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      // Marker remains if unlink fails, so a late writer cannot recreate this
      // identity while deletion is retried.
      await fs.unlink(target(name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  };
}
exports.createCareFileMedia = createCareFileMedia;
