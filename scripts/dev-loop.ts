/**
 * `pnpm dev` at the repository root: the server (watch mode, apps/server `dev`) and Vite (apps/web `dev`, hot
 * reload) on ports that agree. Open the Vite address; it proxies /api to the server.
 *
 *   RCONSOLE_PORT       server port (default: the dev config's server.port, 4000)
 *   RCONSOLE_WEB_PORT   Vite port (default 5173; the dev config allows 5173-5176 as origins)
 *   RCONSOLE_PUBLIC_URL default http://localhost:<Vite port>: the browser's origin, so the Origin check, the session
 *                       cookie and the OIDC callback (through Vite's proxy) all match
 *   RCONSOLE_CONFIG, RCONSOLE_DATA_DIR as for the server.
 */
import { spawn } from 'node:child_process';
import { devServerPort, devWebPort, REPO_ROOT } from './dev-ports.ts';

const api = devServerPort();
const web = devWebPort();
const env = { ...process.env, RCONSOLE_PORT: String(api), RCONSOLE_WEB_PORT: String(web) };
env.RCONSOLE_PUBLIC_URL ||= `http://localhost:${web}`;
console.log(`[dev] API server on 127.0.0.1:${api}; open ${env.RCONSOLE_PUBLIC_URL} (Vite on ${web}, /api proxied to ${api})`);
const child = spawn('pnpm', ['-r', '--parallel', '--filter', './apps/*', 'dev'], { cwd: REPO_ROOT, env, stdio: 'inherit' });
// Ctrl+C reaches the whole process group; wait for the children instead of exiting first.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
