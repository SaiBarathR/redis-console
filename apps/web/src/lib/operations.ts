import type {
  CliRequest,
  CliResponse,
  KeyOp,
  OpResult,
} from "@rconsole/shared";
import { dbPath, post } from "./api.ts";
/** Shown when "Create key" meets an existing key: creating never changes existing data. */
export const KEY_EXISTS =
  "This key already exists. Choose another name or edit the existing key.";
/** Guided actions must not turn Redis error replies carried by HTTP 200 into success messages. */
export async function executeCli(database: string, body: CliRequest) {
  const response = await post<CliResponse>(dbPath(database, "/cli"), body);
  if (response.reply.t === "err") throw new Error(response.reply.v);
  return response;
}
/** `note`: client-side context for the server's confirmation dialog (shown beside its summary and preview). */
export async function keyOperation(database: string, operation: KeyOp, note?: string) {
  const response = await post<OpResult>(
    dbPath(database, "/ops"),
    operation,
    note,
  );
  const result = response.result;
  if (result && typeof result === "object" && "t" in result) {
    if (operation.op === "key.expire" && result.t === "int" && "v" in result && result.v === "0")
      throw new Error("This key no longer exists.");
    if (operation.op === "string.set" && operation.nx && result.t === "nil")
      throw new Error(KEY_EXISTS);
    if (
      operation.op === "key.rename" &&
      operation.nx &&
      result.t === "int" &&
      "v" in result &&
      result.v === "0"
    )
      throw new Error(
        "The destination key already exists. Choose another name.",
      );
    if (result.t === "err" && "v" in result && typeof result.v === "string")
      throw new Error(result.v);
  }
  return response;
}
