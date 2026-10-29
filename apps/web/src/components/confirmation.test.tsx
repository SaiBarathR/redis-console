import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  binFromBytes,
  binFromString,
  type ConfirmationChallenge,
  type DatabaseSummary,
} from "@rconsole/shared";
import { post, setConfirmHandler, setCsrfToken } from "../lib/api.ts";
import { previewArgText, previewCommandText } from "../lib/preview.ts";
import { ChallengeDetails, ConfirmationProvider } from "./Confirmation.tsx";
import { ErrorState } from "./ui.tsx";

const s = binFromString;
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const databases: DatabaseSummary[] = [
  { id: "sandbox-e2e", name: "Sandbox E2E", environment: "dev", effectiveRole: "operator", features: { profiler: false }, readOnly: false, status: "connected" },
  { id: "orders-prod", name: "Orders", environment: "prod", effectiveRole: "admin", features: { profiler: false }, readOnly: false, status: "connected" },
];
function renderProvider() {
  const client = new QueryClient();
  client.setQueryData(["databases"], databases);
  return render(
    <QueryClientProvider client={client}>
      <ConfirmationProvider>
        <span>Workspace</span>
      </ConfirmationProvider>
    </QueryClientProvider>,
  );
}
function challengeFor(partial: Partial<ConfirmationChallenge>): ConfirmationChallenge {
  return {
    token: "confirmation-token-abcdefghijkl",
    level: "confirm",
    reasonRequired: false,
    summary: "Delete 2 keys",
    preview: { total: 1, commands: [{ argv: [{ kind: "command", v: s("UNLINK") }, { kind: "key", v: s("a") }, { kind: "key", v: s("b") }] }] },
    ...partial,
  };
}
function stub428(challenge: ConfirmationChallenge) {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ error: { code: "confirmation_required", message: "Confirm", confirmation: challenge } }, 428))
    .mockResolvedValueOnce(response({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => {
  setConfirmHandler(undefined);
  setCsrfToken("");
  vi.unstubAllGlobals();
});

describe("preview text", () => {
  it("quotes arguments with whitespace or quotes and keeps boundaries", () => {
    expect(previewArgText({ kind: "arg", v: s("hello world") })).toBe('"hello world"');
    expect(previewArgText({ kind: "arg", v: s("") })).toBe('""');
    expect(previewArgText({ kind: "arg", v: s('say "hi"\n') })).toBe('"say \\"hi\\"\\n"');
    expect(previewArgText({ kind: "key", v: s("user:1") })).toBe("user:1");
  });
  it("shows server-cut prefixes with their full size", () => {
    expect(previewArgText({ kind: "arg", v: s("0123456789abcdef"), bytes: 4096 })).toBe(`0123456789abcdef… (${(4096).toLocaleString()} bytes)`);
  });
  it("escapes binary bytes and invisible controls", () => {
    expect(previewArgText({ kind: "key", v: binFromBytes(new Uint8Array([0xff, 0x00, 0x41])) })).toBe("\\xff\\x00A");
    expect(previewArgText({ kind: "key", v: s("a‮b") })).toBe("a\\u202eb");
  });
  it("adds the count of unlisted arguments", () => {
    expect(previewCommandText({ argv: [{ kind: "command", v: s("HDEL") }, { kind: "key", v: s("h") }], moreArgs: 3 })).toBe("HDEL h … +3 more arguments");
  });
});

describe("confirmation preview rendering", () => {
  it("lists commands in a scrollable, labelled region with +N more and total", () => {
    const commands = Array.from({ length: 50 }, (_, i) => ({
      argv: [{ kind: "command" as const, v: s("DEL") }, { kind: "key" as const, v: s(`job:${i}`) }],
    }));
    render(<ChallengeDetails challenge={challengeFor({ preview: { total: 73, commands, more: 23 } })} />);
    const region = screen.getByRole("region", { name: "Commands that will run" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getAllByTestId("confirmation-command")).toHaveLength(50);
    expect(screen.getByTestId("confirmation-more")).toHaveTextContent("+23 more commands not listed");
    expect(screen.getByTestId("confirmation-total")).toHaveTextContent("73 commands");
    expect(within(region).getAllByTestId("confirmation-command")[49]).toHaveTextContent("DEL job:49");
  });
  it("shows shortened values and unlisted arguments as the server provides them", () => {
    render(
      <ChallengeDetails
        challenge={challengeFor({
          preview: {
            total: 1,
            commands: [{
              argv: [{ kind: "command", v: s("HSET") }, { kind: "key", v: s("profile") }, { kind: "arg", v: s("bio") }, { kind: "arg", v: s("Lorem ipsum dol"), bytes: 2048 }],
              moreArgs: 40,
            }],
          },
        })}
      />,
    );
    const line = screen.getByTestId("confirmation-command");
    expect(line).toHaveTextContent(`HSET profile bio "Lorem ipsum dol"… (${(2048).toLocaleString()} bytes)`);
    expect(line).toHaveTextContent("+40 more arguments");
    expect(line.querySelector(".arg.key")).toHaveTextContent("profile");
  });
  it("renders hostile key names as text only", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <ChallengeDetails
        challenge={challengeFor({
          preview: { total: 1, commands: [{ argv: [{ kind: "command", v: s("UNLINK") }, { kind: "key", v: s(hostile) }] }] },
          impact: { keys: 1, sample: [s(hostile)] },
        })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("confirmation-command")).toHaveTextContent(`UNLINK "${hostile}"`);
  });
  it("shows bulk pattern, type, counted impact and an incomplete count", () => {
    render(
      <ChallengeDetails
        challenge={challengeFor({
          summary: "Delete keys matching session:*",
          preview: {
            total: 2,
            commands: [
              { argv: [{ kind: "command", v: s("SCAN") }, { kind: "arg", v: s("0") }, { kind: "arg", v: s("MATCH") }, { kind: "pattern", v: s("session:*") }, { kind: "arg", v: s("COUNT") }, { kind: "arg", v: s("1000") }, { kind: "arg", v: s("TYPE") }, { kind: "arg", v: s("hash") }] },
              { argv: [{ kind: "command", v: s("UNLINK") }, { kind: "key", v: s("session:1") }], moreArgs: 4999 },
            ],
            bulk: { match: s("session:*"), type: "hash", keys: 5000, complete: false, sample: [s("session:1")] },
          },
        })}
      />,
    );
    expect(screen.getByTestId("confirmation-bulk")).toHaveTextContent("Patternsession:*Typehash");
    expect(screen.getByTestId("confirmation-impact")).toHaveTextContent(`At least ${(5000).toLocaleString()} keys affected`);
    expect(screen.getByTestId("confirmation-impact")).toHaveTextContent("scan budget");
    expect(screen.getByRole("list", { name: "Sample of affected keys" })).toHaveTextContent("session:1");
  });
});

describe("confirmation dialog", () => {
  it("names the database, environment and effective role", async () => {
    stub428(challengeFor({}));
    renderProvider();
    const result = post("/databases/sandbox-e2e/ops", { op: "key.delete", keys: [s("a"), s("b")] });
    // The target shows the bare id until the database list has loaded.
    await waitFor(() =>
      expect(screen.getByTestId("confirmation-target")).toHaveTextContent("Sandbox E2E"),
    );
    const target = screen.getByTestId("confirmation-target");
    expect(target).toHaveTextContent("dev");
    expect(target).toHaveTextContent("operator");
    expect(target).not.toHaveClass("prod");
    expect(await screen.findByRole("dialog")).toHaveAccessibleDescription("Delete 2 keys");
    expect(screen.queryByTestId("confirmation-typed")).toBeNull();
    expect(screen.queryByTestId("confirmation-reason")).toBeNull();
    await userEvent.click(screen.getByTestId("confirmation-submit"));
    await expect(result).resolves.toEqual({ ok: true });
  });
  it("is loud on production and keeps typed name and reason", async () => {
    const fetcher = stub428(challengeFor({ level: "typed", expectedText: "Orders", reasonRequired: true }));
    renderProvider();
    const result = post("/databases/orders-prod/ops", { op: "key.delete", keys: [s("a"), s("b")] });
    const dialog = await screen.findByTestId("confirmation-dialog");
    expect(dialog).toHaveClass("prod");
    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveTextContent("Confirm production change");
    const target = screen.getByTestId("confirmation-target");
    expect(target).toHaveClass("prod");
    expect(within(target).getByText("Production")).toHaveClass("production");
    expect(target).toHaveTextContent("admin");
    const submit = screen.getByTestId("confirmation-submit");
    expect(submit).toHaveTextContent("Confirm on production");
    await userEvent.type(screen.getByTestId("confirmation-typed"), "Orders");
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId("confirmation-reason"), "INC-42 cleanup");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await expect(result).resolves.toEqual({ ok: true });
    expect(JSON.parse((fetcher.mock.calls[1]![1] as RequestInit).body as string).confirmation).toEqual({
      token: "confirmation-token-abcdefghijkl",
      typed: "Orders",
      reason: "INC-42 cleanup",
    });
  });
  it("still names an unknown database by id", async () => {
    stub428(challengeFor({}));
    renderProvider();
    const result = post("/databases/elsewhere/cli", { line: "DEL a" }).catch((e: unknown) => e);
    expect(await screen.findByTestId("confirmation-target")).toHaveTextContent("elsewhere");
    await userEvent.click(screen.getByText("Cancel"));
    expect(await result).toBeInstanceOf(Error);
  });
  it("shows a dismissed confirmation as a neutral status, not an error alert", async () => {
    stub428(challengeFor({}));
    renderProvider();
    const error = await new Promise<unknown>((done) => {
      post("/databases/elsewhere/cli", { line: "DEL a" }).catch(done);
      void screen.findByTestId("confirmation-target").then(() => userEvent.click(screen.getByText("Cancel")));
    });
    render(<ErrorState error={error} />);
    expect(screen.getByRole("status")).toHaveTextContent("Action cancelled. No changes were made.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
