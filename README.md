# Server-Panel 

Cloud server monitor and SSH control panel built with Node.js, Express, WebSocket terminal, and a browser-based dashboard.

## Features

- Real-time dashboard for CPU, RAM, disk, network, uptime, and health status
- Multi-server management with scoped access per account
- Interactive SSH terminal over WebSocket
- File manager with Monaco editor integration
- PM2 process management (start, stop, restart, logs)
- Docker, Nginx, and SSL certificate management
- Backup and restore plans with scheduling and retention
- Git-based deployments with GitHub OAuth
- Team accounts with Administrator, Operator, and Viewer roles
- Audit logging for API and terminal actions
- Alerting via Discord and Telegram
- Encrypted secrets at rest using CONFIG_KEY

## Requirements

- Node.js 18 or newer
- npm
- Linux target servers with SSH access
- Bash, Git, and GNU tools on target nodes for backups and deployments

## Installation

1. Clone the repository.
2. Install dependencies:

   npm install

3. Create environment file:

   cp .env.example .env

4. Edit `.env` and set at least:
   - `PANEL_TOKEN` (minimum 16 characters)
   - `PANEL_USERNAME`
   - `PANEL_PASSWORD`
   - `CONFIG_KEY` (64 hex characters)

   You can generate values with:

   npm run setup

5. Optional: create `config.json` from `config.example.json` and adjust server entries.

6. Start the application:

   npm start

   The panel will be available at `http://localhost:3000` by default.

## Development

Run in watch mode:

npm run dev

Run tests:

npm test

## Environment Variables

See `.env.example` for the full list. Key variables:

- `PORT` - HTTP port (default 3000)
- `HOST` - bind address (default 0.0.0.0)
- `TRUST_PROXY` - enable when behind a reverse proxy
- `PANEL_TOKEN` - required panel token used for authentication
- `PANEL_USERNAME` - administrator username for sign in
- `PANEL_PASSWORD` - administrator password for sign in
- `PANEL_VIEWER_TOKEN` - optional read-only token
- `CONFIG_KEY` - 64 hex character key for encrypting secrets
- `PANEL_ORIGINS` - comma-separated allowed browser origins
- `PANEL_FS_ROOT` - optional filesystem jail root
- `PTERO_DATA_ROOT` - container data root
- `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASS`, `SSH_KEY_PATH` - optional bootstrap server
- `GEMINI_API_KEY` - optional Gemini API key for Copilot features
- `GEMINI_MODEL` - Gemini model name

## Configuration

Server definitions are stored in `data/config.json` (or `config.json` at project root for initial setup). Secrets are encrypted using `CONFIG_KEY`. On first run, `npm run setup` migrates plaintext secrets to encrypted form.

Team accounts are stored in `data/accounts.json`. Passwords are hashed with scrypt. Sessions expire after 12 hours and are revoked on account changes or restart.

## Security Notes

- Always run behind HTTPS in production.
- Set `PANEL_ORIGINS` when exposing the panel publicly.
- Use `PANEL_FS_ROOT` to restrict file manager access.
- Do not commit `.env`, `config.json`, or `data/` files.
- Rotate `PANEL_TOKEN` and `CONFIG_KEY` if compromised.

## Project Structure

- `server.js` - application entry point
- `lib/` - core services (auth, accounts, SSH, monitoring, operations)
- `routes/` - HTTP route handlers
- `public/` - frontend dashboard
- `test/` - automated tests

## License

MIT
