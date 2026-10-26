/**
 * Repository-local launcher for `pnpm dev` / `pnpm start` in apps/server. Config resolution order:
 * RCONSOLE_CONFIG, then config/rconsole.local.json (gitignored, machine-specific) if it exists, then the generic
 * config/rconsole.dev.json. With RCONSOLE_PORT set and RCONSOLE_PUBLIC_URL not, a local http publicUrl follows the
 * port (scripts/dev-ports.ts). The production entry point (src/main.ts, used by the image) still requires
 * RCONSOLE_CONFIG and changes nothing.
 */
import { devConfigFile, devPublicUrl } from '../../../scripts/dev-ports.ts';

const publicUrl = devPublicUrl();
process.env.RCONSOLE_CONFIG = devConfigFile();
if (publicUrl) process.env.RCONSOLE_PUBLIC_URL = publicUrl;
await import('../src/main.ts');
