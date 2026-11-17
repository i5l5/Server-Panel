const path = require('path');

const ROOT = path.join(__dirname, '..');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const CONFIG_PATH = path.resolve(process.env.CONFIG_PATH || path.join(ROOT, 'config.json'));
const ENV_PATH = path.resolve(process.env.ENV_FILE || path.join(ROOT, '.env'));

module.exports = { ROOT, DATA_DIR, CONFIG_PATH, ENV_PATH };
