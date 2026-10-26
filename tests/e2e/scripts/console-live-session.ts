/** Prepare isolated :4300 QA sessions. Never prints account credentials or cookies. */
import { readFileSync, chmodSync } from "node:fs";
import { request } from "@playwright/test";
import { freshTotp } from "../lib/totp.ts";
const accounts = JSON.parse(
  readFileSync("../../.qa/accounts.json", "utf8"),
) as {
  local: Record<
    string,
    { username: string; password: string; totpSecret?: string }
  >;
};
for (const role of ["viewer", "operator", "admin"]) {
  const account = accounts.local[`qa-${role}`]!;
  const client = await request.newContext({ baseURL: "http://localhost:4300" });
  const me = await (await client.get("/api/v1/auth/me")).json();
  const headers = {
    Origin: "http://localhost:4300",
    "X-CSRF-Token": me.csrfToken,
  };
  const login = await client.post("/api/v1/auth/login", {
    headers,
    data: { username: account.username, password: account.password },
  });
  if (!login.ok())
    throw new Error(`QA ${role} login failed (${login.status()})`);
  if (account.totpSecret) {
    const pending = await (await client.get("/api/v1/auth/me")).json();
    const verify = await client.post("/api/v1/auth/totp/verify", {
      headers: {
        Origin: "http://localhost:4300",
        "X-CSRF-Token": pending.csrfToken,
      },
      data: { code: await freshTotp(account.totpSecret) },
    });
    if (!verify.ok())
      throw new Error(`QA ${role} TOTP failed (${verify.status()})`);
  }
  const file = `../../.qa/console-storage-${role}.json`;
  await client.storageState({ path: file });
  chmodSync(file, 0o600);
  await client.dispose();
  console.log(`Prepared isolated ${role} session on :4300`);
}
