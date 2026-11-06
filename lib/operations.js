const crypto = require('crypto');
const path = require('path');
const security = require('./security');
const stateFile = require('./stateFile');
const q = security.shellQuote;
const INTERVALS = { manual: 0, hourly: 3600000, daily: 86400000, weekly: 604800000 };
const SHA = /^[a-f0-9]{40,64}$/;
const JOB_TIMEOUT = 30 * 60 * 1000;

function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\0\r\n]/.test(value)) throw security.httpError(400, 'Name must contain 1–80 characters');
  return value.trim();
}
function directory(value) {
  if (typeof value !== 'string' || !value.trim()) throw security.httpError(400, 'An absolute directory is required');
  const result = security.safeRemoteDir(value.trim());
  if (result === '/') throw security.httpError(400, 'Choose a directory below the filesystem root');
  return result;
}
function overlaps(a, b) { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function repository(value) {
  const repo = String(value || '').trim();
  if (!/^(https:\/\/github\.com\/|git@github\.com:)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repo)) throw security.httpError(400, 'Use a GitHub HTTPS or SSH repository URL without embedded credentials');
  return repo;
}
function branchName(value) {
  const branch = String(value || 'main');
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.') || branch.endsWith('.lock')) throw security.httpError(400, 'Invalid Git branch');
  return branch;
}
function dbIdentifier(value, fallback = '') {
  const result = String(value || fallback);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(result)) throw security.httpError(400, 'Invalid database name or username');
  return result;
}

function databaseArgs(plan) {
  const host = q(plan.host);
  const user = q(plan.username);
  if (plan.kind === 'postgres') return `--no-password --host=${host} --port=${plan.port} --username=${user} --dbname=${q(plan.database)}`;
  
  return `--defaults-extra-file=${q(plan.credentialsFile)} --host=${host} --port=${plan.port} --user=${user}`;
}
function backupScript(plan, archive, root) {
  const setup = `umask 077\nmkdir -p -- ${q(root)}\ntest ! -L ${q(root)}\nchmod 700 -- ${q(root)}\ntest ! -e ${q(archive)}\n`;
  let command;
  if (plan.kind === 'files') {
    command = `source_dir=$(realpath -e -- ${q(plan.source)})\nbackup_dir=$(realpath -e -- ${q(root)})\ncase "$backup_dir/" in "$source_dir/"*) echo 'Backup directory must be outside the source directory' >&2; exit 1;; esac\ncase "$source_dir/" in "$backup_dir/"*) echo 'Source directory must be outside backup storage' >&2; exit 1;; esac\ntar -C "$source_dir" -czf ${q(archive)} -- .`;
  } else if (plan.kind === 'postgres') {
    command = `${plan.credentialsFile ? `PGPASSFILE=${q(plan.credentialsFile)} ` : ''}pg_dump ${databaseArgs(plan)} --format=custom --file=${q(archive)}`;
  } else {
    command = `mysqldump ${databaseArgs(plan)} --single-transaction --routines --events --triggers -- ${q(plan.database)} > ${q(archive)}`;
  }
  return `${setup}${command}\nsha256sum -- ${q(archive)} > ${q(`${archive}.sha256`)}\nstat -c '%s' -- ${q(archive)}`;
}
function restoreScript(plan, archive) {
  const verify = `sha256sum --check -- ${q(`${archive}.sha256`)}\n`;
  if (plan.kind === 'files') return `${verify}test -d ${q(plan.source)}\ntar -C ${q(plan.source)} --no-same-owner --no-same-permissions -xzf ${q(archive)}`;
  if (plan.kind === 'postgres') return `${verify}${plan.credentialsFile ? `PGPASSFILE=${q(plan.credentialsFile)} ` : ''}pg_restore ${databaseArgs(plan)} --exit-on-error --single-transaction --clean --if-exists -- ${q(archive)}`;
  return `${verify}mysql ${databaseArgs(plan)} -- ${q(plan.database)} < ${q(archive)}`;
}

function deployScript(project, rollbackCommit, useOAuth = false) {
  const dir = q(project.directory);
  const git = useOAuth ? 'git -c credential.helper=' : 'git';
  const setup = rollbackCommit ? `initial_clone=0\ntest -d ${dir}/.git` : `initial_clone=0\nif [ ! -d ${dir}/.git ]; then\n initial_clone=1\n ${git} clone --branch ${q(project.branch)} -- ${q(project.repository)} ${dir}\nfi`;
  const change = rollbackCommit ? `git -C ${dir} checkout --detach ${q(rollbackCommit)}` : `test "$(git -C ${dir} remote get-url origin)" = ${q(project.repository)}\n${git} -C ${dir} fetch origin ${q(project.branch)}\ngit -C ${dir} checkout --detach FETCH_HEAD`;
  const askpass = '#!/bin/sh\ncase "$1" in\n *Username*) printf "%s\\n" x-access-token ;;\n *Password*) cat "$CL_GIT_CREDENTIAL_FILE" ;;\n *) exit 1 ;;\nesac\n';
  const cleanup = 'rm -rf -- "$auth_dir"\nunset GIT_ASKPASS CL_GIT_CREDENTIAL_FILE auth_dir\ntrap - EXIT HUP INT TERM';
  const auth = useOAuth ? `umask 077\nIFS= read -r oauth_token\nauth_dir=$(mktemp -d)\ntrap 'rm -rf -- "$auth_dir"' EXIT HUP INT TERM\nprintf '%s' "$oauth_token" > "$auth_dir/token"\nunset oauth_token\nprintf '%s' ${q(askpass)} > "$auth_dir/askpass"\nchmod 700 "$auth_dir/askpass"\nexport GIT_ASKPASS="$auth_dir/askpass"\nexport CL_GIT_CREDENTIAL_FILE="$auth_dir/token"\nunset GIT_TRACE GIT_TRACE_CURL GIT_CURL_VERBOSE\n` : '';
  return `export GIT_TERMINAL_PROMPT=0\nexport GIT_SSH_COMMAND='ssh -o BatchMode=yes'\n${auth}${setup}\ntest -z "$(git -C ${dir} status --porcelain --untracked-files=no)" || { echo 'Tracked files have local changes; commit or stash them first' >&2; exit 1; }\nif [ "$initial_clone" = 0 ]; then\n printf 'CL_FROM='\n git -C ${dir} rev-parse HEAD\nfi\n${change}\nprintf 'CL_TO='\ngit -C ${dir} rev-parse HEAD\n${useOAuth ? cleanup + '\n' : ''}cd -- ${dir}\n${project.install ? 'npm ci\n' : ''}${project.build ? 'npm run build\n' : ''}pm2 restart ${q(project.processName)} --update-env`;
}

class Operations {
  constructor({ store, ssh, audit, github, filename = path.join(__dirname, '..', 'data', 'operations.json'), root }) {
    this.store = store;
    this.ssh = ssh;
    this.audit = audit;
    this.github = github;
    this.root = directory(root || process.env.PANEL_BACKUP_ROOT || `${process.env.PANEL_FS_ROOT || '/var/lib'}/serverops-backups`);
    this.state = stateFile(filename, { projects: [], plans: [], runs: [] });
    this.locks = new Set();
    this.pending = new Map();
    let changed = false;
    for (const run of this.state.data.runs) {
      if (run.status === 'running') {
        run.status = 'interrupted';
        run.error = 'Panel restarted before completion. Check the node before retrying.';
        run.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.state.save();
  }
  list(serverId) {
    const { projects, plans, runs } = this.state.data;
    return { projects: projects.filter(p => p.serverId === serverId), plans: plans.filter(p => p.serverId === serverId), runs: runs.filter(r => r.serverId === serverId).slice(-200).reverse(), backupRoot: this.root };
  }
  node(serverId) {
    const node = this.store.config.servers.find(s => s.id === serverId);
    if (!node || !node.isReal) throw security.httpError(400, 'Select a configured SSH server to run this operation');
    return node;
  }
  addProject(serverId, input) {
    this.node(serverId);
    const dir = directory(input.directory);
    if (overlaps(dir, this.root)) throw security.httpError(400, 'Application and backup directories must be separate');
    if (this.state.data.projects.some(p => p.serverId === serverId && overlaps(p.directory, dir))) throw security.httpError(409, 'Another deployment already uses this directory');
    const project = { id: crypto.randomUUID(), serverId, name: label(input.name), repository: repository(input.repository), branch: branchName(input.branch), directory: dir, processName: security.assertSafeName(input.processName, 'PM2 process'), install: input.install === true, build: input.build === true, createdAt: new Date().toISOString() };
    if (Number.isSafeInteger(input.githubAccountId)) project.githubAccountId = input.githubAccountId;
    this.state.data.projects.push(project);
    try { this.state.save(); } catch (err) { this.state.data.projects.pop(); throw err; }
    return project;
  }
  addPlan(serverId, input) {
    this.node(serverId);
    if (!['files', 'postgres', 'mysql'].includes(input.kind)) throw security.httpError(400, 'Invalid backup type');
    if (!Object.hasOwn(INTERVALS, input.schedule)) throw security.httpError(400, 'Choose manual, hourly, daily or weekly');
    const retention = Number(input.retention);
    if (!Number.isInteger(retention) || retention < 1 || retention > 100) throw security.httpError(400, 'Retention must be between 1 and 100 copies');
    const plan = { id: crypto.randomUUID(), serverId, name: label(input.name), kind: input.kind, schedule: input.schedule, retention, enabled: true, createdAt: new Date().toISOString(), nextRunAt: INTERVALS[input.schedule] ? new Date(Date.now() + INTERVALS[input.schedule]).toISOString() : null };
    if (plan.kind === 'files') {
      plan.source = directory(input.source);
      if (overlaps(plan.source, this.root)) throw security.httpError(400, 'Backup source and storage directories must be separate');
    } else {
      plan.database = dbIdentifier(input.database);
      plan.username = dbIdentifier(input.username, plan.kind === 'postgres' ? 'postgres' : 'root');
      plan.host = String(input.host || 'localhost');
      if (!/^[A-Za-z0-9.:-]{1,253}$/.test(plan.host)) throw security.httpError(400, 'Invalid database host');
      plan.port = Number(input.port || (plan.kind === 'postgres' ? 5432 : 3306));
      if (!Number.isInteger(plan.port) || plan.port < 1 || plan.port > 65535) throw security.httpError(400, 'Invalid database port');
      plan.credentialsFile = input.credentialsFile ? directory(input.credentialsFile) : '';
      if (plan.kind === 'mysql' && !plan.credentialsFile) throw security.httpError(400, 'MySQL requires a remote defaults file containing credentials');
    }
    this.state.data.plans.push(plan);
    try { this.state.save(); } catch (err) { this.state.data.plans.pop(); throw err; }
    return plan;
  }
  get(collection, id, serverId) {
    const item = this.state.data[collection].find(p => p.id === id && p.serverId === serverId);
    if (!item) throw security.httpError(404, 'Item not found on this server');
    return item;
  }
  remove(collection, id, serverId) {
    if (this.locks.has(serverId)) throw security.httpError(409, 'Wait for the current server operation to finish');
    const item = this.get(collection, id, serverId);
    const index = this.state.data[collection].indexOf(item);
    this.state.data[collection].splice(index, 1);
    try { this.state.save(); } catch (err) { this.state.data[collection].splice(index, 0, item); throw err; }
    
  }
  togglePlan(id, serverId) {
    const plan = this.get('plans', id, serverId);
    const before = { enabled: plan.enabled, nextRunAt: plan.nextRunAt };
    plan.enabled = !plan.enabled;
    plan.nextRunAt = plan.enabled && INTERVALS[plan.schedule] ? new Date(Date.now() + INTERVALS[plan.schedule]).toISOString() : null;
    try { this.state.save(); } catch (err) { Object.assign(plan, before); throw err; }
    return plan;
  }
  async execute(node, script, run, input) {
    
    const command = `timeout --signal=TERM --kill-after=10s 1800s sh -c ${q(`set -eu\n${script}`)}`;
    const result = await this.ssh.execCommand(node, command, { timeoutMs: JOB_TIMEOUT + 20000, ...(input ? { input: `${input}\n` } : {}) });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    run.log = security.redactOutput(input ? output.split(input).join('[REDACTED]') : output).slice(-50000);
    const from = output.match(/^CL_FROM=([a-f0-9]{40,64})$/m);
    const to = output.match(/^CL_TO=([a-f0-9]{40,64})$/m);
    if (from) run.fromCommit = from[1];
    if (to) run.toCommit = to[1];
    if (result.code !== 0) throw new Error(`Remote command failed (exit ${result.code ?? 'unknown'}). See the operation log.`);
    return output;
  }
  start(serverId, actor, type, item, task) {
    const node = this.node(serverId);
    if (this.locks.has(serverId)) throw security.httpError(409, 'Another deployment, backup or restore is running on this server');
    const run = { id: crypto.randomUUID(), serverId, itemId: item.id, name: item.name, type, actor, status: 'running', startedAt: new Date().toISOString(), log: '' };
    this.locks.add(serverId);
    this.state.data.runs.push(run);
    try { this.state.save(); } catch (err) { this.locks.delete(serverId); this.state.data.runs.pop(); throw err; }
    this.audit.record({ type: 'operation', action: type, actor, serverId, server: node.name, runId: run.id, status: 'running' });
    const promise = Promise.resolve().then(async () => {
      try { await task(node, run); run.status = 'success'; }
      catch (err) { run.status = 'failed'; run.error = security.redactOutput(err.message); }
      finally {
        run.finishedAt = new Date().toISOString();
        try { this.state.save(); }
        catch (err) { console.error('Could not persist operation outcome:', err.message); }
        this.audit.record({ type: 'operation', action: type, actor, serverId, server: node.name, runId: run.id, status: run.status });
        this.locks.delete(serverId);
        this.pending.delete(run.id);
      }
    });
    this.pending.set(run.id, promise);
    return run;
  }
  deploy(serverId, projectId, actor, runId) {
    const project = this.get('projects', projectId, serverId);
    let target;
    if (runId) {
      const previous = this.get('runs', runId, serverId);
      if (previous.itemId !== projectId || !['deploy', 'rollback'].includes(previous.type) || !SHA.test(previous.fromCommit || '')) throw security.httpError(400, 'This deployment has no previous commit to restore');
      target = previous.fromCommit;
    }
    return this.start(serverId, actor, target ? 'rollback' : 'deploy', project, async (node, run) => {
      run.repository = project.repository;
      run.directory = project.directory;
      const token = project.githubAccountId ? await this.github?.token(project.githubAccountId) : null;
      if (project.githubAccountId && !token) throw security.httpError(409, 'Authorize GitHub before deploying this application');
      await this.execute(node, deployScript(project, target, Boolean(token)), run, token);
    });
  }
  backup(serverId, planId, actor) {
    const plan = this.get('plans', planId, serverId);
    return this.start(serverId, actor, 'backup', plan, async (node, run) => {
      run.plan = { ...plan };
      run.archive = `${this.root}/${run.id}.${plan.kind === 'files' ? 'tar.gz' : plan.kind === 'postgres' ? 'dump' : 'sql'}`;
      const output = await this.execute(node, backupScript(plan, run.archive, this.root), run);
      run.bytes = Number(output.split('\n').pop()) || 0;
      run.available = true;
      
      this.state.save();
      const copies = this.state.data.runs.filter(r => r.type === 'backup' && r.itemId === planId && r.available && r.id !== run.id).reverse();
      for (const copy of copies.slice(plan.retention - 1)) {
        try {
          await this.execute(node, `rm -f -- ${q(copy.archive)} ${q(`${copy.archive}.sha256`)}`, { log: '' });
          copy.available = false;
          copy.expiredAt = new Date().toISOString();
        } catch (err) { run.log += `\nRetention cleanup failed: ${security.redactOutput(err.message)}`; }
      }
    });
  }
  restore(serverId, runId, actor, confirmation) {
    const backup = this.get('runs', runId, serverId);
    if (backup.type !== 'backup' || backup.status !== 'success' || !backup.available || !backup.plan) throw security.httpError(400, 'Only a completed, retained backup can be restored');
    if (confirmation !== backup.name) throw security.httpError(400, 'Type the backup name to confirm replacement of current data');
    const plan = backup.plan;
    return this.start(serverId, actor, 'restore', { id: backup.itemId, name: backup.name }, async (node, run) => {
      run.backupId = backup.id;
      await this.execute(node, restoreScript(plan, backup.archive), run);
    });
  }
  async tick(now = Date.now()) {
    for (const plan of this.state.data.plans) {
      if (!plan.enabled || !plan.nextRunAt || new Date(plan.nextRunAt).getTime() > now || this.locks.has(plan.serverId)) continue;
      if (!this.store.config.servers.some(server => server.id === plan.serverId)) continue;
      const before = plan.nextRunAt;
      plan.nextRunAt = new Date(now + INTERVALS[plan.schedule]).toISOString();
      try { this.state.save(); }
      catch (err) { plan.nextRunAt = before; console.error('Backup schedule persistence failed:', err.message); continue; }
      try { this.backup(plan.serverId, plan.id, 'scheduler'); }
      catch (err) { this.audit.record({ type: 'operation', action: 'scheduled-backup', actor: 'scheduler', serverId: plan.serverId, status: 'failed', error: security.redactOutput(err.message) }); }
    }
  }
  startScheduler() {
    this.timer = setInterval(() => this.tick().catch(err => console.error('Backup scheduler:', err.message)), 30000);
    this.timer.unref();
    this.tick().catch(err => console.error('Backup scheduler:', err.message));
  }
  stopScheduler() { clearInterval(this.timer); }
}

module.exports = { Operations, INTERVALS, backupScript, restoreScript, deployScript, repository, branchName };
