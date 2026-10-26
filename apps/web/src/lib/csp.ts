import { config } from "zod";
// Shared contracts instantiate Zod schemas during module evaluation. Disable its
// optional JIT before those modules load: even a caught Function feature probe
// produces a violation under require-trusted-types-for 'script'. No policy bypass.
config({ jitless: true });
