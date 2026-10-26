import { expect, it } from "vitest";
import { copyCode } from "./copyCode.ts";
it("preserves binary escape bytes in Node and Java examples", () => {
  const code = copyCode('GET "\\xff"');
  expect(code).toContain(
    'client.sendCommand(["GET", Buffer.from("/w==", "base64")])',
  );
  expect(code).toContain('Base64.getDecoder().decode("/w==")');
});
it("keeps Unicode and quoted arguments intact and rejects malformed input", () => {
  expect(copyCode('SET "a b" "你好"')).toContain(
    'client.sendCommand(["SET", "a b", "你好"])',
  );
  expect(copyCode('GET "unfinished')).toBe("Command cannot be parsed.");
});
