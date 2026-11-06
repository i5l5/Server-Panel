
const crypto = require('crypto');
const { Client: SSHClient } = require('ssh2');
const security = require('./lib/security');


const MAX_EXEC_OUTPUT = 5 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 120_000;
const METRICS_CACHE_MS = 2_000;
const MAX_EDITABLE_FILE = 5 * 1024 * 1024;


function computeHealth(cpu, ram, disk) {
  const diskPenalty = Math.max(0, disk - 80) * 1.5;
  return Math.max(0, Math.min(100, Math.round(100 - (cpu * 0.4 + ram * 0.4 + diskPenalty))));
}

class SSHService {
  constructor() {
    this.connections = new Map(); 
    this.pendingConnections = new Map(); 
    this.metricsCache = new Map(); 
    this.netCounters = new Map(); 
  }

  
  async connect(serverConfig) {
    const id = serverConfig.id || `${serverConfig.host}:${serverConfig.port || 22}`;

    // If already connected and active
    const existing = this.connections.get(id);
    if (existing && existing.isConnected && existing.client) {
      return existing;
    }
    if (this.pendingConnections.has(id)) return this.pendingConnections.get(id);

    const pending = this.openConnection(id, serverConfig)
      .finally(() => this.pendingConnections.delete(id));
    this.pendingConnections.set(id, pending);
    return pending;
  }

  openConnection(id, serverConfig) {
    return new Promise((resolve, reject) => {
      const client = new SSHClient();
      let isResolved = false;
      let hostKeyMismatch = false;

      const connectConfig = {
        host: serverConfig.host,
        port: parseInt(serverConfig.port) || 22,
        username: serverConfig.username || 'root',
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        // Trust on first use: the fingerprint is pinned, and a changed host key
        // (possible man-in-the-middle) refuses to send the password.
        hostVerifier: (key) => {
          const fingerprint = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          if (!serverConfig.hostKeyFingerprint) {
            serverConfig.hostKeyFingerprint = fingerprint;
            if (this.onHostKeyLearned) this.onHostKeyLearned(serverConfig);
            return true;
          }
          if (serverConfig.hostKeyFingerprint === fingerprint) return true;
          hostKeyMismatch = true;
          return false;
        }
      };

      if (serverConfig.privateKey) {
        connectConfig.privateKey = serverConfig.privateKey;
      } else if (serverConfig.password) {
        connectConfig.password = serverConfig.password;
      }

      client.on('ready', () => {
        // Open SFTP session
        client.sftp((sftpErr, sftp) => {
          const connObj = {
            id,
            client,
            sftp: sftp || null,
            isConnected: true,
            serverConfig
          };
          this.connections.set(id, connObj);
          if (!isResolved) {
            isResolved = true;
            resolve(connObj);
          }
        });
      });

      client.on('error', (err) => {
        this.connections.delete(id);
        if (!isResolved) {
          isResolved = true;
          reject(hostKeyMismatch
            ? new Error(`Host key for ${serverConfig.host} changed (expected ${serverConfig.hostKeyFingerprint}). Connection refused.`)
            : err);
        }
      });

      client.on('close', () => {
        const conn = this.connections.get(id);
        if (conn) conn.isConnected = false;
        this.connections.delete(id);
      });

      client.on('end', () => {
        const conn = this.connections.get(id);
        if (conn) conn.isConnected = false;
        this.connections.delete(id);
      });

      try {
        client.connect(connectConfig);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Execute a single command and return stdout & stderr
   */
  async execCommand(serverConfig, command, { timeoutMs = EXEC_TIMEOUT_MS, input } = {}) {
    if (typeof command !== 'string' || !command.trim()) {
      const err = new Error('Command must be a non-empty string');
      err.statusCode = 400;
      throw err;
    }

    const conn = await this.connect(serverConfig);
    return new Promise((resolve, reject) => {
      conn.client.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = '';
        let stderr = '';
        let settled = false;

        const append = (current, chunk) => (
          current.length >= MAX_EXEC_OUTPUT
            ? current
            : (current + chunk).slice(0, MAX_EXEC_OUTPUT)
        );

        const finish = (result, error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(result);
        };

        const timer = setTimeout(() => {
          try { stream.close(); } catch (_) { /* القناة مغلقة أصلاً */ }
          finish(null, new Error(`Command timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
        if (timer.unref) timer.unref();

        stream.on('close', (code) => finish({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
        stream.on('error', (streamErr) => finish(null, streamErr));
        stream.on('data', (data) => { stdout = append(stdout, data.toString('utf8')); });
        stream.stderr.on('data', (data) => { stderr = append(stderr, data.toString('utf8')); });
        if (input !== undefined) stream.end(input);
      });
    });
  }

  /**
   * Open interactive PTY shell (for terminal / WebSocket streaming)
   */
  async openShell(serverConfig, ws, dimensions = { rows: 30, cols: 100 }) {
    const conn = await this.connect(serverConfig);
    return new Promise((resolve, reject) => {
      conn.client.shell({
        term: 'xterm-256color',
        rows: dimensions.rows || 30,
        cols: dimensions.cols || 100
      }, (err, stream) => {
        if (err) return reject(err);

        conn.ptyStream = stream;

        // Pipe raw stream to client WebSocket
        stream.on('data', (data) => {
          if (ws && ws.readyState === 1) {
            const str = data.toString('utf8');
            // Send both for backward compatibility and raw xterm.js
            ws.send(JSON.stringify({
              type: 'pty_data',
              data: str,
              text: str
            }));
          }
        });

        stream.on('close', () => {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: 'pty_exit',
              text: '\r\n\x1b[33m[SSH Connection Closed by Remote Host]\x1b[0m\r\n'
            }));
          }
        });

        resolve(stream);
      });
    });
  }

  /**
   * Get real server metrics via remote bash commands
   */
  /**
   * Live metrics with a short cache: the dashboard poll, the WebSocket pulse and
   * the monitor all ask at once, and they share one SSH round trip.
   */
  async getLiveMetrics(serverConfig) {
    const id = serverConfig.id || serverConfig.host;
    const cached = this.metricsCache.get(id);
    const now = Date.now();
    if (cached && cached.value && now - cached.at < METRICS_CACHE_MS) return cached.value;
    if (cached && cached.pending) return cached.pending;

    const pending = this.fetchLiveMetrics(serverConfig)
      .then(value => {
        this.metricsCache.set(id, { at: Date.now(), value });
        return value;
      })
      .catch(err => {
        this.metricsCache.delete(id);
        throw err;
      });
    this.metricsCache.set(id, { ...(cached || {}), pending });
    return pending;
  }

  async fetchLiveMetrics(serverConfig) {
    const cmd = `
      # CPU model & Load
      CPU_MODEL=$(lscpu | grep "Model name:" | sed -r 's/Model name:\\s+//g; s/"//g' | head -n1 || echo "Generic Linux CPU")
      LOAD=$(cat /proc/loadavg | awk '{print $1}')
      UPTIME=$(uptime -p 2>/dev/null || uptime | awk '{print $3,$4}')

      # CPU usage: two /proc/stat samples (top's first frame is a since-boot average)
      S1=$(awk '/^cpu /{print $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat)
      sleep 0.4
      S2=$(awk '/^cpu /{print $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat)
      CPU_USAGE=$(echo "$S1 $S2" | awk '{d=$4-$2; if (d>0) printf "%.1f", ($3-$1)*100/d; else print 0}')

      # RAM
      RAM_TOTAL=$(free -m | awk '/Mem:/ {print $2}')
      RAM_USED=$(free -m | awk '/Mem:/ {print $3}')
      RAM_BUFF=$(free -m | awk '/Mem:/ {print $6}')

      # DISK /
      DISK_TOTAL=$(df -BG / | awk 'NR==2 {gsub("G",""); print $2}')
      DISK_AVAIL=$(df -BG / | awk 'NR==2 {gsub("G",""); print $4}')
      DISK_USED_PCT=$(df -h / | awk 'NR==2 {gsub("%",""); print $5}')

      # Network byte counters summed over physical interfaces (rates are computed from deltas)
      NET_STATS=$(awk -F: '/:/ { if ($1 !~ /lo/) { split($2,a," "); rx+=a[1]; tx+=a[9] } } END { print rx+0, tx+0 }' /proc/net/dev)
      NET_RX=$(echo "$NET_STATS" | awk '{print $1+0}')
      NET_TX=$(echo "$NET_STATS" | awk '{print $2+0}')

      echo "METRICS_JSON_START"
      echo "{\\"cpuModel\\":\\"$CPU_MODEL\\",\\"cpuLoad\\":\\"$LOAD\\",\\"cpuPercent\\":\${CPU_USAGE:-0},\\"ramTotalMb\\":\${RAM_TOTAL:-0},\\"ramUsedMb\\":\${RAM_USED:-0},\\"cacheMb\\":\${RAM_BUFF:-0},\\"diskTotalGb\\":\${DISK_TOTAL:-0},\\"diskAvailGb\\":\${DISK_AVAIL:-0},\\"diskPercent\\":\${DISK_USED_PCT:-0},\\"rxBytes\\":\${NET_RX:-0},\\"txBytes\\":\${NET_TX:-0},\\"uptime\\":\\"$UPTIME\\"}"
      echo "METRICS_JSON_END"
    `;

    const res = await this.execCommand(serverConfig, cmd);
    const match = res.stdout.match(/METRICS_JSON_START\s*([\s\S]*?)\s*METRICS_JSON_END/);
    if (match && match[1]) {
      try {
        const parsed = JSON.parse(match[1].trim());
        const cpuP = Math.round(parseFloat(parsed.cpuPercent) || 0);
        const ramTotalG = +(parsed.ramTotalMb / 1024).toFixed(1);
        const ramUsedG = +(parsed.ramUsedMb / 1024).toFixed(1);
        const ramP = Math.round((parsed.ramUsedMb / (parsed.ramTotalMb || 1)) * 100);
        const net = this.networkRates(serverConfig.id || serverConfig.host, Number(parsed.rxBytes), Number(parsed.txBytes));

        return {
          uptime: String(parsed.uptime || '').replace(/^up\s+/, '') || 'unknown',
          cpuModel: String(parsed.cpuModel || 'Generic Linux CPU').trim(),
          cpuLoad: +(parseFloat(parsed.cpuLoad) || 0.5).toFixed(2),
          cpuPercent: Math.min(100, Math.max(0, cpuP)),
          memoryTotal: ramTotalG,
          memoryUsed: ramUsedG,
          memoryPercent: Math.min(100, Math.max(0, ramP)),
          storageTotal: parseFloat(parsed.diskTotalGb) || 0,
          storageFree: parseFloat(parsed.diskAvailGb) || 0,
          storagePercent: Math.min(100, Math.max(0, parseInt(parsed.diskPercent, 10) || 0)),
          cacheMb: parseInt(parsed.cacheMb, 10) || 0,
          txKbps: net.txKbps,
          rxMbps: net.rxMbps,
          systemHealth: computeHealth(cpuP, ramP, parseInt(parsed.diskPercent, 10) || 0),
          healthStatus: cpuP > 80 || ramP > 85 ? 'High Load' : 'Optimal Stable'
        };
      } catch (err) {
        console.warn('Error parsing remote metrics json:', err.message);
      }
    }
    throw new Error('Could not parse server metrics output');
  }

  /** Converts cumulative /proc/net/dev counters into TX KB/s and RX MB/s. */
  networkRates(id, rxBytes, txBytes, now = Date.now()) {
    const prev = this.netCounters.get(id);
    this.netCounters.set(id, { rxBytes, txBytes, at: now });
    if (!prev || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) return { txKbps: 0, rxMbps: 0 };
    const seconds = (now - prev.at) / 1000;
    if (seconds <= 0 || rxBytes < prev.rxBytes || txBytes < prev.txBytes) return { txKbps: 0, rxMbps: 0 };
    return {
      txKbps: +((txBytes - prev.txBytes) / 1024 / seconds).toFixed(1),
      rxMbps: +((rxBytes - prev.rxBytes) / 1024 / 1024 / seconds).toFixed(2)
    };
  }

  /**
   * Get real PM2 processes list from remote server
   */
  async getPm2List(serverConfig) {
    try {
      const res = await this.execCommand(serverConfig, 'pm2 jlist 2>/dev/null || echo "[]"');
      const text = res.stdout.trim();
      const firstBracket = text.indexOf('[');
      const lastBracket = text.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket !== -1) {
        const jsonStr = text.substring(firstBracket, lastBracket + 1);
        const list = JSON.parse(jsonStr);
        return list.map(item => {
          const memBytes = item.monit?.memory || 0;
          const memMb = Math.round(memBytes / (1024 * 1024));
          const uptimeMs = Date.now() - (item.pm2_env?.pm_uptime || Date.now());
          const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
          const mins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

          return {
            id: item.pm_id,
            name: item.name,
            namespace: item.pm2_env?.namespace || 'default',
            version: item.pm2_env?.version || 'N/A',
            mode: item.pm2_env?.exec_mode || 'fork',
            pid: item.pid || 0,
            uptime: `${hours}h ${mins}m`,
            status: item.pm2_env?.status === 'online' ? 'online' : 'stopped',
            cpu: Math.round(item.monit?.cpu || 0),
            memory: `${memMb} MB`,
            memoryRawMb: memMb,
            user: item.pm2_env?.username || 'root',
            matching: 'disabled',
            logs: [
              `[PM2] Application ${item.name} status: ${item.pm2_env?.status}`,
              `[PM2] Restarts count: ${item.pm2_env?.restart_time || 0}`,
              `[PM2] Script: ${item.pm2_env?.pm_exec_path}`
            ]
          };
        });
      }
    } catch (e) {
      console.warn('Could not fetch remote pm2 list:', e.message);
    }
    return [];
  }

  /**
   * Real SFTP: List directory
   */
  async listFiles(serverConfig, remotePath) {
    const conn = await this.connect(serverConfig);
    if (!conn.sftp) throw new Error('SFTP subsystem not available on server');

    return new Promise((resolve, reject) => {
      conn.sftp.readdir(remotePath, (err, list) => {
        if (err) return reject(err);

        const items = list.map(item => {
          const isDir = (item.attrs.mode & 0o40000) !== 0;
          const sizeStr = isDir ? '--' : formatBytes(item.attrs.size);
          const modDate = new Date(item.attrs.mtime * 1000).toISOString().replace('T', ' ').substring(0, 16);
          return {
            name: item.filename,
            type: isDir ? 'dir' : 'file',
            size: sizeStr,
            modified: modDate
          };
        });

        // Sort folders first, then alphabetically
        items.sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === 'dir' ? -1 : 1;
        });

        resolve(items);
      });
    });
  }

  /**
   * Real SFTP: Read file content
   */
  async readFile(serverConfig, remoteFilePath) {
    const conn = await this.connect(serverConfig);
    if (!conn.sftp) throw new Error('SFTP subsystem not available');

    // The editor loads the whole file into memory, so huge files are refused up front.
    const size = await new Promise((resolve, reject) => {
      conn.sftp.stat(remoteFilePath, (err, stats) => (err ? reject(err) : resolve(stats.size)));
    });
    if (size > MAX_EDITABLE_FILE) {
      throw security.httpError(413, `File is too large to edit (${formatBytes(size)}). Download it instead.`);
    }

    return new Promise((resolve, reject) => {
      const stream = conn.sftp.createReadStream(remoteFilePath);
      let content = '';
      stream.on('data', (chunk) => { content += chunk.toString('utf8'); });
      stream.on('end', () => resolve(content));
      stream.on('error', (err) => reject(err));
    });
  }

  /**
   * Real SFTP: Write file content
   */
  async writeFile(serverConfig, remoteFilePath, content) {
    const conn = await this.connect(serverConfig);
    if (!conn.sftp) throw new Error('SFTP subsystem not available');

    return new Promise((resolve, reject) => {
      const stream = conn.sftp.createWriteStream(remoteFilePath);
      stream.write(content);
      stream.end();
      stream.on('close', () => resolve(true));
      stream.on('error', (err) => reject(err));
    });
  }

  /**
   * Real SFTP: Upload file buffer
   */
  async uploadFile(serverConfig, remoteFilePath, buffer) {
    const conn = await this.connect(serverConfig);
    if (!conn.sftp) throw new Error('SFTP subsystem not available');

    return new Promise((resolve, reject) => {
      const stream = conn.sftp.createWriteStream(remoteFilePath);
      stream.write(buffer);
      stream.end();
      stream.on('close', () => resolve(true));
      stream.on('error', (err) => reject(err));
    });
  }

  /**
   * Real SFTP: Get readable stream for downloading
   */
  async getReadStream(serverConfig, remoteFilePath) {
    const conn = await this.connect(serverConfig);
    if (!conn.sftp) throw new Error('SFTP subsystem not available');
    return conn.sftp.createReadStream(remoteFilePath);
  }

  /**
   * Real SFTP: Delete file or directory
   */
  async deleteItem(serverConfig, remotePath) {
    const conn = await this.connect(serverConfig);
    if (!conn.sftp) throw new Error('SFTP subsystem not available');

    return new Promise((resolve, reject) => {
      conn.sftp.stat(remotePath, (err, stats) => {
        if (err) return reject(err);
        const isDir = (stats.mode & 0o40000) !== 0;
        if (isDir) {
          // Use bash rm -rf for robust recursive folder removal
          // اقتباس POSIX كامل + `--` يمنعان تفسير المسار كأوامر أو كخيارات.
          this.execCommand(serverConfig, `rm -rf -- ${security.shellQuote(remotePath)}`)
            .then(() => resolve(true))
            .catch(reject);
        } else {
          conn.sftp.unlink(remotePath, (unlinkErr) => {
            if (unlinkErr) return reject(unlinkErr);
            resolve(true);
          });
        }
      });
    });
  }

  /**
   * Real SFTP: Create directory
   */
  async createFolder(serverConfig, remotePath) {
    const conn = await this.connect(serverConfig);
    if (!conn.sftp) throw new Error('SFTP subsystem not available');

    return new Promise((resolve, reject) => {
      conn.sftp.mkdir(remotePath, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }

  /**
   * Real SFTP: Rename / Move item
   */
  async renameItem(serverConfig, oldPath, newPath) {
    const conn = await this.connect(serverConfig);
    if (!conn.sftp) throw new Error('SFTP subsystem not available');

    return new Promise((resolve, reject) => {
      conn.sftp.rename(oldPath, newPath, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    });
  }

  /**
   * Disconnect server
   */
  disconnect(serverId) {
    const conn = this.connections.get(serverId);
    if (conn && conn.client) {
      try { conn.client.end(); } catch (e) {}
    }
    this.connections.delete(serverId);
    this.metricsCache.delete(serverId);
    this.netCounters.delete(serverId);
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

module.exports = new SSHService();
module.exports.SSHService = SSHService;
module.exports.computeHealth = computeHealth;
