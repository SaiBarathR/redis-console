# Licence texts for packages that ship none

`scripts/third-party-notices.ts` reproduces the licence files each production dependency ships. A few packages ship
none; their upstream texts are kept here and used instead, so `THIRD-PARTY-NOTICES` always carries the full licence.
The generator fails for any other package without a licence file, and for any licence outside its allowlist.

| File | Packages | Upstream |
|---|---|---|
| `node-redis.txt` | `redis`, `@redis/bloom`, `@redis/client`, `@redis/json`, `@redis/search`, `@redis/time-series` | `LICENSE` of https://github.com/redis/node-redis |
| `qrcode-generator.txt` | `qrcode-generator` | `LICENSE` of https://github.com/kazuhikoarase/qrcode-generator |
| `abstract-logging.txt` | `abstract-logging` | The package README's licence, the MIT License at http://jsumners.mit-license.org/ (James Sumners); the repository has no licence file |
