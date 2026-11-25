import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { AppError } from './errors.mjs';

export class CodexRpc extends EventEmitter {
  constructor({ executable = 'codex', cwd = process.cwd() } = {}) {
    super();
    this.executable = executable;
    this.cwd = cwd;
    this.pending = new Map();
    this.nextId = 0;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.initialize();
    return this.ready;
  }

  async initialize() {
    const environment = { ...process.env };
    delete environment.OPENAI_API_KEY;
    this.child = spawn(this.executable, ['app-server', '--stdio'], {
      cwd: this.cwd, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Provider diagnostics can contain account information; never send them to the browser.
    this.child.stderr.resume();
    this.child.on('error', () => this.fail('Codex could not start. Check that Codex is installed and signed in.'));
    this.child.on('exit', () => this.fail('The Codex connection closed. Restart the sketchbook to reconnect.'));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => this.receive(line));
    await this.request('initialize', {
      clientInfo: { name: 'santas-sketchbook', title: 'Santa sketchbook demo', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); }
    catch { return; }
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new AppError(502, 'Codex could not complete that request. Check its sign-in and usage limits. Your drawing is safe.', 'codex_error'));
      else pending.resolve(message.result);
    } else if (message.id != null && message.method) {
      if (this.listenerCount('request')) this.emit('request', message);
      else this.send({ id: message.id, error: { code: -32601, message: 'This app does not permit that tool.' } });
    } else if (message.method) {
      this.emit('notification', message);
      if (message.method !== 'error' || this.listenerCount('error')) this.emit(message.method, message.params);
    }
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new AppError(503, 'Codex is not connected.', 'codex_offline');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeout = 45_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(504, 'Codex took too long. Your drawing is safe.', 'codex_timeout'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  fail(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError(503, message, 'codex_offline'));
    }
    this.pending.clear();
    this.emit('disconnected');
  }

  close() {
    this.child?.kill();
    this.lines?.close();
    this.fail('Codex was stopped.');
  }
}
