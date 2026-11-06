# Server-Panel

A centralized server management panel built with **Node.js, Express, and WebSocket**.

I developed Server-Panel to make managing and monitoring multiple VPS servers easier through a single dashboard.

## Preview

<img width="1800" height="760" alt="banner" src="https://github.com/user-attachments/assets/76e92376-d2b4-49ad-a2c0-2b15f0c2ed28" />
<img width="1258" height="795" alt="dashboard" src="https://github.com/user-attachments/assets/629e0358-922a-4ca0-b74a-12b609dd93df" />
<img width="1258" height="795" alt="terminal" src="https://github.com/user-attachments/assets/f1c0ddfe-9eb9-4fee-b63f-d5ca4c5d6e36" />
<img width="1258" height="795" alt="files" src="https://github.com/user-attachments/assets/fad5dd23-20fc-40cb-ac20-1a926537822c" />
<img width="1258" height="795" alt="agent" src="https://github.com/user-attachments/assets/0bbd87d2-10cc-4bbf-8537-8d8e7843383b" />
<img width="1258" height="795" alt="files" src="https://github.com/user-attachments/assets/6d62c9e3-e17b-4d40-833e-ec21531e649c" />
<img width="1258" height="795" alt="infra" src="https://github.com/user-attachments/assets/bddaa384-4f53-40a4-9389-d09979d57273" />
<img width="1258" height="795" alt="settings" src="https://github.com/user-attachments/assets/82374e82-c08c-4645-9e27-f59250402048" />


## Features

- Real-time server monitoring.
- Multi-server management via SSH.
- Interactive web-based terminal.
- File manager with Monaco Editor.
- PM2 process management.
- Docker, Nginx, and SSL management.
- Backup and restore.
- Git-based deployments.
- Team accounts and role permissions.
- Discord and Telegram notifications.
- Encrypted configuration and audit logs.

## Requirements

- Node.js 18+
- npm
- Linux servers with SSH access.

## Installation

```bash
npm install
cp .env.example .env
npm run setup
npm start
```

Open `http://localhost:3000` to access the dashboard.

## Development

```bash
npm run dev
npm test
```

## License

MIT
