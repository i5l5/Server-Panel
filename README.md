# Server-Panel

A centralized server management panel built with **Node.js, Express, and WebSocket**.

I developed Server-Panel to make managing and monitoring multiple VPS servers easier through a single dashboard.

## Preview


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