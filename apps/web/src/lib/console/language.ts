import { commandKeyPositions } from "./keySpecs.ts";
import {
  isRedisSpace,
  tokenizeCommandLine,
  type CommandArg,
  type CommandDoc,
} from "@rconsole/shared";
export type ArgumentRole =
  | "command"
  | "subcommand"
  | "key"
  | "value"
  | "number"
  | "flag";
export interface CommandToken {
  from: number;
  to: number;
  text: string;
  role: ArgumentRole;
  argument?: CommandArg;
  /** A number argument that is not a number, or a command COMMAND DOCS does not know. */
  invalid?: boolean;
}
/** Tolerant lexing while a quote is still being typed; execution uses the strict shared tokenizer. */
export function lex(line: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    while (cursor < line.length && isRedisSpace(line[cursor]!)) cursor++;
    if (cursor === line.length) break;
    const from = cursor;
    let quote: string | undefined;
    while (cursor < line.length && (quote || !isRedisSpace(line[cursor]!))) {
      const char = line[cursor]!;
      if (quote) {
        if (
          char === "\\" &&
          cursor + 1 < line.length &&
          (quote === '"' || line[cursor + 1] === "'")
        ) {
          cursor += 2;
          continue;
        }
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") quote = char;
      cursor++;
    }
    let text = line.slice(from, cursor);
    try {
      text = tokenizeCommandLine(text)[0] ?? text;
    } catch {
      /* incomplete draft */
    }
    tokens.push({ from, to: cursor, text, role: "value" });
  }
  return tokens;
}
export function commandDoc(line: string, docs: CommandDoc[]) {
  const words = lex(line).map((token) => token.text.toUpperCase());
  return (
    docs.find(
      (doc) => doc.name.toUpperCase() === words.slice(0, 2).join(" "),
    ) ?? docs.find((doc) => doc.name.toUpperCase() === words[0])
  );
}
export function argumentLeaves(args: readonly CommandArg[]): CommandArg[] {
  return args.flatMap((arg) =>
    arg.arguments?.length ? argumentLeaves(arg.arguments) : [arg],
  );
}
/** Looks like a number of some kind: decides whether an optional numeric argument starts here. */
const numeric = (text: string) =>
  /^[-+]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|inf(?:inity)?)$/i.test(text);
/**
 * Whether Redis would parse the text as this argument's type (an advisory cue; the server decides).
 * Integers (string2ll): an optional minus and digits only, so 1.5, 1e3 and +5 are refused. Doubles
 * (strtod): decimals, exponents and ±inf/infinity; score ranges (min/max) may be exclusive, "(1.5".
 */
export function validNumber(text: string, arg: Pick<CommandArg, "name" | "type">) {
  if (arg.type !== "double") return /^-?\d+$/.test(text);
  const value = /^(min|max)$/i.test(arg.name) ? text.replace(/^\(/, "") : text;
  return /^[-+]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|inf(?:inity)?)$/i.test(value);
}
/** Walk the COMMAND DOCS grammar, including optional tokens, oneofs and repeated blocks. UI hints only. */
export function analyzeCommand(line: string, docs: CommandDoc[]) {
  const tokens = lex(line);
  const doc = commandDoc(line, docs);
  const commandWords = doc?.name.split(" ").length ?? 1;
  const keyPositions = commandKeyPositions(
    tokens.map((token) => token.text),
    doc?.keySpecs,
  );
  tokens.slice(0, commandWords).forEach((token, index) => {
    token.role = index ? "subcommand" : "command";
  });
  let position = commandWords;
  let next: CommandArg | undefined;
  const starts = (arg: CommandArg): boolean => {
    const text = tokens[position]?.text;
    if (text === undefined) return false;
    if (arg.token) return text.toUpperCase() === arg.token.toUpperCase();
    if (arg.type === "key" && keyPositions) return keyPositions.has(position);
    if (arg.type === "oneof") return !!arg.arguments?.some(starts);
    if (arg.type === "block")
      return !!arg.arguments?.[0] && starts(arg.arguments[0]);
    if (["integer", "double", "unix-time"].includes(arg.type))
      return numeric(text.replace(/^\(/, ""));
    return true;
  };
  const consume = (arg: CommandArg, depth: number) => {
    if (depth > 12) return;
    if (arg.optional && !starts(arg)) {
      if (position >= tokens.length && !next) next = arg;
      return;
    }
    if (arg.type === "key" && keyPositions && !keyPositions.has(position)) {
      // Key specs only describe words that exist: at the end of the line this is the next key to type.
      if (position >= tokens.length) next ??= arg;
      return;
    }
    let repeats = 0;
    do {
      const previous = position;
      if (arg.token) {
        const token = tokens[position];
        if (!token) {
          next ??= arg;
          return;
        }
        if (token.text.toUpperCase() !== arg.token.toUpperCase()) return;
        token.role = "flag";
        token.argument = arg;
        position++;
        if (arg.type === "pure-token") continue;
      }
      if (arg.type === "oneof") {
        const option = arg.arguments?.find(starts);
        if (option) consume(option, depth + 1);
        else next ??= arg;
      } else if (arg.type === "block") {
        const children = arg.arguments ?? [];
        // Parallel lists (XREAD STREAMS key [key …] id [id …]): without complete key specs the
        // remaining words split evenly, so IDs are not read as keys.
        if (
          !keyPositions &&
          children.length > 1 &&
          children.every((child) => child.multiple && !child.token && child.type !== "block" && child.type !== "oneof")
        ) {
          // Round up so a half-typed list ("a b 0-0") keeps the words typed first as keys.
          const share = Math.ceil((tokens.length - position) / children.length);
          children.forEach((child, index) => {
            const end =
              index === children.length - 1
                ? tokens.length
                : Math.min(tokens.length, position + share);
            if (position >= end) next ??= child;
            for (; position < end; position++) {
              const token = tokens[position]!;
              token.role =
                child.type === "key"
                  ? "key"
                  : ["integer", "double", "unix-time"].includes(child.type)
                    ? "number"
                    : "value";
              token.argument = child;
            }
          });
        } else children.forEach((child) => consume(child, depth + 1));
      } else if (arg.type !== "pure-token") {
        const token = tokens[position];
        if (!token) {
          next ??= arg;
          return;
        }
        token.role =
          arg.type === "key"
            ? "key"
            : ["integer", "double", "unix-time"].includes(arg.type)
              ? "number"
              : "value";
        token.argument = arg;
        position++;
      }
      if (position === previous) break;
    } while (
      arg.multiple &&
      position < tokens.length &&
      starts(arg) &&
      ++repeats < 1000
    );
    // A repeated untokened block (MSET key value …) continues with its first argument.
    if (arg.multiple && position === tokens.length) next ??= firstArgument(arg);
  };
  doc?.arguments.forEach((arg) => consume(arg, 0));
  // Redis options often permit a different order than their documentation lists.
  // Revisit only the remaining tail, so a positional value named "NX" stays a value.
  const withTokens = (args: readonly CommandArg[]): CommandArg[] =>
    args
      .flatMap((arg) => [arg, ...withTokens(arg.arguments ?? [])])
      .filter((arg) => !!arg.token);
  const options = withTokens(doc?.arguments ?? []);
  while (position < tokens.length) {
    const option = options.find(
      (arg) =>
        arg.token?.toUpperCase() === tokens[position]?.text.toUpperCase(),
    );
    const previous = position;
    if (option) consume(option, 0);
    if (position === previous) {
      const token = tokens[position++]!;
      if (numeric(token.text)) token.role = "number";
    }
  }
  if (keyPositions)
    tokens.forEach((token, index) => {
      if (keyPositions.has(index)) token.role = "key";
      else if (token.role === "key") token.role = "value";
    });
  for (const token of tokens)
    if (
      token.role === "number" &&
      token.argument &&
      !validNumber(token.text, token.argument)
    )
      token.invalid = true;
  // Only once the command word is finished, so a half-typed name is not flagged.
  if (!doc && docs.length && tokens[0] && (tokens.length > 1 || /\s$/.test(line)))
    tokens[0].invalid = true;
  const active = /\s$/.test(line) ? next : (tokens.at(-1)?.argument ?? next);
  return { doc, tokens, active, family: keyFamily(doc) };
}
const firstArgument = (arg: CommandArg): CommandArg =>
  arg.type === "block" && !arg.token && arg.arguments?.[0]
    ? firstArgument(arg.arguments[0])
    : arg;
/** Every option token a command accepts (SET: NX, XX, GET, EX, …), in documentation order. */
export function optionTokens(doc: Pick<CommandDoc, "arguments">): string[] {
  const walk = (args: readonly CommandArg[]): string[] =>
    args.flatMap((arg) => [
      ...(arg.token ? [arg.token.toUpperCase()] : []),
      ...walk(arg.arguments ?? []),
    ]);
  return [...new Set(walk(doc.arguments))];
}
const MODULE_FAMILIES: [RegExp, string][] = [
  [/^JSON\./, "json"],
  [/^TS\./, "timeseries"],
  [/^(BF|CF|CMS|TOPK|TDIGEST)\./, "probabilistic"],
  [
    /^V(ADD|SIM|REM|CARD|DIM|EMB|GETATTR|SETATTR|INFO|LINKS|RANDMEMBER|ISMEMBER|RANGE)$/,
    "vector",
  ],
];
const GROUP_FAMILIES: Record<string, string> = {
  string: "string",
  bitmap: "string",
  hyperloglog: "string",
  hash: "hash",
  list: "list",
  set: "set",
  "sorted-set": "zset",
  geo: "zset",
  stream: "stream",
};
/**
 * The Redis type a command's keys hold (docs/DESIGN.md type hues): from the COMMAND DOCS group,
 * or the module prefix. Generic commands (DEL, EXPIRE, TYPE) have no family.
 */
export function keyFamily(doc?: Pick<CommandDoc, "name" | "group">) {
  if (!doc) return undefined;
  const name = doc.name.split(" ")[0]!.toUpperCase();
  return (
    MODULE_FAMILIES.find(([pattern]) => pattern.test(name))?.[1] ??
    GROUP_FAMILIES[doc.group]
  );
}
/** Conservative spelling aid, offered only when the command itself is unknown. */
export function commandSuggestions(line: string, docs: CommandDoc[]) {
  const word = lex(line)[0]?.text.toUpperCase();
  if (
    !word ||
    word.length > 64 ||
    docs.some((doc) => doc.name.split(" ")[0] === word)
  )
    return [];
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++)
        next[j] = Math.min(
          next[j - 1]! + 1,
          row[j]! + 1,
          row[j - 1]! + Number(a[i - 1] !== b[j - 1]),
        );
      row = next;
    }
    return row[b.length]!;
  };
  return [...new Set(docs.map((doc) => doc.name.split(" ")[0]!))]
    .map((name) => ({ name, distance: distance(word, name) }))
    .filter((item) => item.distance <= Math.min(2, Math.floor(word.length / 2)))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((item) => item.name);
}
export function historySuggestion(value: string, history: readonly string[]) {
  return value && !value.includes("\n")
    ? ([...history]
        .reverse()
        .find(
          (item) =>
            item.startsWith(value) && item !== value && !item.includes("\n"),
        )
        ?.slice(value.length) ?? "")
    : "";
}
