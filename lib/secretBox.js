
const crypto = require('crypto');
const { persistEnvValue } = require('./env');

const PREFIX = 'enc:v1:';
let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  let hex = String(process.env.CONFIG_KEY || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    hex = crypto.randomBytes(32).toString('hex');
    try {
      persistEnvValue('CONFIG_KEY', hex);
      console.log('Generated a new CONFIG_KEY in .env for encrypting stored secrets.');
    } catch (err) {
      throw new Error(`CONFIG_KEY is missing and could not be written to .env: ${err.message}`);
    }
  }
  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return '';
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Plaintext (legacy) values pass through unchanged so old configs keep loading. */
function decrypt(value) {
  if (!isEncrypted(value)) return value || '';
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

function resetKeyCache() {
  cachedKey = null;
}

module.exports = { encrypt, decrypt, isEncrypted, resetKeyCache };
