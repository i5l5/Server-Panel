
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const LINE_RE = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/;

function parseEnv(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach(line => {
    if (/^\s*#/.test(line)) return;
    const match = line.match(LINE_RE);
    if (!match) return;
    let val = (match[2] || '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[match[1]] = val;
  });
  return out;
}


function loadEnv(file = ENV_PATH) {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
    }
    return parsed;
  } catch (err) {
    console.warn('Could not read .env:', err.message);
    return {};
  }
}


function persistEnvValue(key, value, file = ENV_PATH) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^\\s*${key.replace(/[.]/g, '\\.')}\\s*=.*$`, 'm');
  if (re.test(text)) {
    text = text.replace(re, `${key}=${value}`);
  } else {
    if (text && !text.endsWith('\n')) text += '\n';
    text += `${key}=${value}\n`;
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  process.env[key] = value;
}

module.exports = { ENV_PATH, parseEnv, loadEnv, persistEnvValue };
