#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadEnv, persistEnvValue, ENV_PATH } = require('../lib/env');

const args = new Set(process.argv.slice(2));
const example = path.join(__dirname, '..', '.env.example');

if (!fs.existsSync(ENV_PATH) && fs.existsSync(example)) {
  fs.copyFileSync(example, ENV_PATH);
  console.log('Created .env from .env.example');
}
loadEnv();

const token = String(process.env.PANEL_TOKEN || '');
if (token.length < 16 || args.has('--rotate-token')) {
  persistEnvValue('PANEL_TOKEN', crypto.randomBytes(32).toString('hex'));
  console.log(' PANEL_TOKEN generated in .env');
} else {
  console.log(' PANEL_TOKEN already set');
}

if (!/^[0-9a-f]{64}$/i.test(String(process.env.CONFIG_KEY || ''))) {
  persistEnvValue('CONFIG_KEY', crypto.randomBytes(32).toString('hex'));
  console.log(' CONFIG_KEY generated in .env');
} else {
  console.log(' CONFIG_KEY already set');
}


const store = require('../lib/configStore');
store.load();
console.log(` config.json checked (${store.config.servers.length} server(s), secrets encrypted at rest)`);

if (args.has('--show')) console.log(`\nAdmin token: ${process.env.PANEL_TOKEN}\n`);
else console.log('\nYour admin token is PANEL_TOKEN in .env (or run: npm run setup -- --show).');
