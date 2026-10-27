import { describe, expect, it } from "vitest";
import { serverProduct } from "./engine.ts";

// Deployment trial: a Valkey 8.1 server was listed as "7.2.4", the Redis version it reports for compatibility.
describe("serverProduct", () => {
  it("names Valkey with its own version and explains the compatibility version", () => {
    expect(serverProduct({ version: "7.2.4", engine: { name: "Valkey", version: "8.1.4" }, mode: "standalone", modules: [] })).toEqual({
      name: "Valkey",
      version: "8.1.4",
      title: "Reports Redis 7.2.4 for compatibility",
    });
  });
  it("is Redis and its version otherwise, with the fallback while the server is unknown", () => {
    expect(serverProduct({ version: "8.10.2", mode: "standalone", modules: [] })).toEqual({ name: "Redis", version: "8.10.2" });
    expect(serverProduct(undefined, "7.4.1")).toEqual({ name: "Redis", version: "7.4.1" });
    expect(serverProduct(undefined)).toEqual({ name: "Redis", version: undefined });
  });
});
