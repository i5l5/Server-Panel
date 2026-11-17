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

const { Accounts } = require('../lib/accounts');
const hasAccounts = new Accounts().list().length > 0;
const envPassword = String(process.env.PANEL_PASSWORD || '');
let generatedPassword = '';
if (!envPassword && !hasAccounts) {
  if (!String(process.env.PANEL_USERNAME || '').trim()) persistEnvValue('PANEL_USERNAME', 'admin');
  generatedPassword = crypto.randomBytes(15).toString('base64url');
  persistEnvValue('PANEL_PASSWORD', generatedPassword);
  console.log(' Admin password generated in .env');
} else if (envPassword && envPassword.length < 12) {
  console.warn(' WARNING: PANEL_PASSWORD must be at least 12 characters, sign-in will fail');
}

const store = require('../lib/configStore');
store.load();
console.log(` config.json checked (${store.config.servers.length} server(s), secrets encrypted at rest)`);

if (generatedPassword || args.has('--show')) {
  const line = '='.repeat(56);
  console.log(`\n${line}\n  ServerOps admin login\n  Username: ${process.env.PANEL_USERNAME}\n  Password: ${process.env.PANEL_PASSWORD || '(set in your account settings)'}\n${line}`);
  if (generatedPassword) console.log('  Change it by setting PANEL_PASSWORD, or keep it safe.\n');
}
if (args.has('--show')) console.log(`Admin token: ${process.env.PANEL_TOKEN}\n`);
else console.log(`\nYour admin token is PANEL_TOKEN in ${ENV_PATH} (show it with: node scripts/setup.js --show).`);
