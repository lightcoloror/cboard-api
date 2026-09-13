'use strict';
const crypto = require('crypto');
function createCareCrypto(keys, active) {
  function key(id) {
    const value = keys && keys[id];
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
      const error = new Error('Care encryption is not configured'); error.status = 503;
      error.code = 'CARE_KEY_UNAVAILABLE'; throw error;
    }
    return Buffer.from(value, 'hex');
  }
  return {
    seal(value, context) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key(active), iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return { version: 1, keyId: active, iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    open(envelope, context) {
      try {
        if (!envelope || envelope.version !== 1) throw new Error('Invalid envelope');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key(envelope.keyId), Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      } catch (_) {
        const error = new Error('Care encrypted data unavailable'); error.status = 503;
        error.code = 'CARE_DATA_UNAVAILABLE'; throw error;
      }
    }
  };
}
exports.createCareCrypto = createCareCrypto;
exports.fromEnvironment = () => {
  let keys; try { keys = JSON.parse(process.env.CARE_ENCRYPTION_KEYS || '{}'); } catch (_) { keys = {}; }
  return createCareCrypto(keys, process.env.CARE_ENCRYPTION_ACTIVE_KEY);
};
