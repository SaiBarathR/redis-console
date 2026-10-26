import { afterEach, expect, it, vi } from "vitest";
import { binFromString } from "@rconsole/shared";
import { executeCli, keyOperation } from "./operations.ts";
afterEach(() => vi.unstubAllGlobals());
it("surfaces Redis ACL errors returned as typed HTTP 200 replies", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          argv: ["VADD"],
          durationMs: 1,
          commandClass: "write",
          reply: { t: "err", v: "NOPERM no permissions" },
        }),
      ),
    ),
  );
  await expect(executeCli("sandbox-e2e", { argv: ["VADD"] })).rejects.toThrow(
    "NOPERM",
  );
});
it("does not report successful creation when SET NX returns nil", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { t: "nil" } })),
      ),
  );
  await expect(
    keyOperation("sandbox-e2e", {
      op: "string.set",
      key: binFromString("k"),
      value: binFromString("v"),
      nx: true,
    }),
  ).rejects.toThrow("already exists");
});
it("does not report successful rename when RENAMENX returns zero", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { t: "int", v: "0" } }),
        ),
      ),
  );
  await expect(
    keyOperation("sandbox-e2e", {
      op: "key.rename",
      key: binFromString("a"),
      newKey: binFromString("b"),
      nx: true,
    }),
  ).rejects.toThrow("destination key already exists");
});
