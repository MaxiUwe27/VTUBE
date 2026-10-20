// Launches Electron for this project. Adds --no-sandbox only when running as root
// (e.g. in containers), where Chromium's sandbox refuses to start. Normal users keep the sandbox.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron'); // path to the electron binary
const args = ['.', ...process.argv.slice(2)];
if (process.getuid?.() === 0 && !args.includes('--no-sandbox')) args.push('--no-sandbox');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, args, { cwd: root, stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
