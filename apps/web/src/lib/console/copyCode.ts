import { binFromBytes, tokenizeCommandLineBytes } from "@rconsole/shared";
/** Copyable examples preserve raw redis-cli \xHH bytes as well as UTF-8 arguments. */
export function copyCode(line: string) {
  try {
    const argv = tokenizeCommandLineBytes(line).map(binFromBytes);
    if (!argv.length || argv[0]!.enc !== "utf8")
      return "Command cannot be parsed.";
    const node = argv
      .map((arg) =>
        arg.enc === "utf8"
          ? JSON.stringify(arg.data)
          : `Buffer.from(${JSON.stringify(arg.data)}, "base64")`,
      )
      .join(", ");
    const java = argv
      .slice(1)
      .map((arg) =>
        arg.enc === "utf8"
          ? `${JSON.stringify(arg.data)}.getBytes(StandardCharsets.UTF_8)`
          : `Base64.getDecoder().decode(${JSON.stringify(arg.data)})`,
      )
      .join(", ");
    return `// node-redis\nawait client.sendCommand([${node}]);\n// ioredis\nawait redis.call(${node});\n// Spring Data Redis (RedisConnection)\nconnection.execute(${JSON.stringify(argv[0]!.data)}${java ? `, ${java}` : ""});`;
  } catch {
    return "Command cannot be parsed.";
  }
}
