# Server-Panel

A centralized server management panel built with **Node.js, Express, and WebSocket**.

I developed Server-Panel to make managing and monitoring multiple VPS servers easier through a single dashboard.

## Preview

<img width="1800" height="760" alt="banner" src="https://github.com/user-attachments/assets/76e92376-d2b4-49ad-a2c0-2b15f0c2ed28" />
<img width="1258" height="795" alt="dashboard" src="https://github.com/user-attachments/assets/629e0358-922a-4ca0-b74a-12b609dd93df" />
<img width="1258" height="795" alt="terminal" src="https://github.com/user-attachments/assets/f1c0ddfe-9eb9-4fee-b63f-d5ca4c5d6e36" />
<img width="1258" height="795" alt="files" src="https://github.com/user-attachments/assets/fad5dd23-20fc-40cb-ac20-1a926537822c" />



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

## Quick Setup

1. [Install Docker](https://docs.docker.com/engine/install/)
2. Create a `docker-compose.yml` file similar to this:

```yaml
services:
  app:
    image: 'ghcr.io/i5l5/server-panel:latest'
    restart: unless-stopped
    ports:
      - '3000:3000'
    volumes:
      - ./data:/app/data
```

This is the bare minimum configuration required. See [Configuration](#configuration) for more.

3. Bring up your stack by running

```bash
docker compose up -d
```

4. Get your admin login from the logs

```bash
docker compose logs app
```

On first start the panel creates an `admin` account with a random password and prints it in the logs.

5. Log in to the panel

Open `http://127.0.0.1:3000` (or `http://<server-ip>:3000`) and sign in with the credentials from the logs.

## Configuration

Everything the panel stores lives in `./data`: servers, encrypted secrets, accounts, audit log, metrics history, and a generated `.env` that holds `PANEL_TOKEN`, `CONFIG_KEY` and the admin password. Back up this folder. Saved SSH passwords can't be decrypted without its `CONFIG_KEY`.

You can set any option from [`.env.example`](.env.example) under `environment:` in `docker-compose.yml`, or edit `./data/.env`, then restart:

```yaml
    environment:
      PANEL_USERNAME: admin
      PANEL_PASSWORD: a-long-password-of-12-chars-or-more
      TRUST_PROXY: 'true'                  # when behind Nginx / Caddy / Traefik
      PANEL_ORIGINS: https://panel.example.com
```

| Task | Command |
| --- | --- |
| Update to the latest version | `docker compose pull && docker compose up -d` |
| Show admin login and API token | `docker compose exec -u node app node scripts/setup.js --show` |
| View logs | `docker compose logs -f app` |
| Stop | `docker compose down` (data in `./data` is kept) |

**Tips**

- **Different port:** change the left side of the port mapping, for example `'8080:3000'`.
- **Managing the Docker host itself:** add `extra_hosts: ['host.docker.internal:host-gateway']`, then add a server with host `host.docker.internal`.
- **SSH keys:** mount a key read-only, for example `- ~/.ssh/id_ed25519:/run/secrets/ssh_key:ro`, and set `SSH_KEY_PATH=/run/secrets/ssh_key`.
- **HTTPS:** put the panel behind a reverse proxy, for example Nginx Proxy Manager, and set `TRUST_PROXY` and `PANEL_ORIGINS` as shown above.

## License

MIT
