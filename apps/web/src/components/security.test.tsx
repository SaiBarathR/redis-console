import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationChallenge, DatabaseSummary } from "@rconsole/shared";
import { binFromBytes, binFromString } from "@rconsole/shared";
import { setConfirmHandler, setCsrfToken, post, request } from "../lib/api.ts";
import { DatabaseContext } from "../lib/context.tsx";
import { ConfirmationProvider } from "./Confirmation.tsx";
import { ReplyView } from "./Reply.tsx";
import { ValueViewer } from "./ValueViewer.tsx";
import { KeyContent } from "../pages/Keys.tsx";
import { PolicyBadge } from "../pages/Console.tsx";
const challenge: ConfirmationChallenge = {
  token: "confirmation-token-123456789",
  level: "typed",
  expectedText: "Production",
  reasonRequired: true,
  summary: "Delete selected keys",
  preview: {
    total: 1,
    commands: [
      {
        argv: [
          { kind: "command", v: binFromString("UNLINK") },
          { kind: "key", v: binFromString("k") },
        ],
      },
    ],
  },
  impact: { keys: 2, sample: [binFromString("<img src=x onerror=alert(1)>")] },
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
afterEach(() => {
  setConfirmHandler(undefined);
  setCsrfToken("");
  vi.unstubAllGlobals();
});
describe("safe Redis rendering", () => {
  it("renders hostile values as text, never elements", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <ReplyView reply={{ t: "str", v: binFromString(hostile) }} />,
    );
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
  it("renders binary and invisible characters visibly", () => {
    const { rerender } = render(
      <ReplyView
        reply={{ t: "str", v: binFromBytes(new Uint8Array([255, 0])) }}
      />,
    );
    expect(screen.getByText('"\\xff\\x00"')).toBeInTheDocument();
    rerender(
      <ReplyView
        reply={{ t: "str", v: binFromString("safe\u202Eevil\u200B") }}
      />,
    );
    expect(screen.getByText('"safe\\xe2\\x80\\xaeevil\\xe2\\x80\\x8b"')).toBeInTheDocument();
  });
  it("caps hostile long values", () => {
    const { container } = render(
      <ReplyView
        reply={{ t: "str", v: binFromString("x".repeat(2_000_000)) }}
      />,
    );
    expect(container.textContent!.length).toBeLessThan(101000);
  });
  it("renders typed maps and arrays without precision loss", () => {
    render(
      <ReplyView
        reply={{
          t: "map",
          v: [
            [
              { t: "status", v: "count" },
              { t: "int", v: "9223372036854775807" },
            ],
          ],
        }}
      />,
    );
    expect(screen.getByText("9223372036854775807")).toBeInTheDocument();
  });
  it("shows formatter errors instead of breaking the view", async () => {
    render(<ValueViewer value={binFromString("not-json")} />);
    await userEvent.click(screen.getByRole("tab", { name: "JSON" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
  it("shows policy and hint before execution", () => {
    const db: DatabaseSummary = {
      id: "db",
      name: "DB",
      environment: "prod",
      effectiveRole: "viewer",
      features: { profiler: false },
      readOnly: true,
      status: "connected",
    };
    render(
      <DatabaseContext value={db}>
        <PolicyBadge line="DEL key" docs={[]} />
      </DatabaseContext>,
    );
    expect(screen.getByTestId("policy-badge")).toHaveTextContent(
      "write · destructive · blocked",
    );
    expect(screen.getByTestId("policy-badge")).toHaveTextContent("read-only");
  });
});
describe("generic API confirmation", () => {
  it("sends credentials and CSRF on every mutation", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    setCsrfToken("csrf-test");
    await post("/test", { value: "a" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/test",
      expect.objectContaining({
        credentials: "same-origin",
        method: "POST",
        headers: expect.objectContaining({ "X-CSRF-Token": "csrf-test" }),
      }),
    );
  });
  it("requires exact typed text and reason then retries the original request once", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          {
            error: {
              code: "confirmation_required",
              message: "Confirm",
              confirmation: challenge,
            },
          },
          428,
        ),
      )
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    render(
      <ConfirmationProvider>
        <span>Workspace</span>
      </ConfirmationProvider>,
    );
    const result = post("/databases/test/ops", {
      op: "key.delete",
      keys: [binFromString("k")],
    });
    const input = await screen.findByTestId("confirmation-typed");
    const submit = screen.getByTestId("confirmation-submit");
    expect(submit).toBeDisabled();
    expect(screen.getByText(/2 keys affected/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    await userEvent.type(input, "production");
    await userEvent.type(screen.getByTestId("confirmation-reason"), "Cleanup");
    expect(submit).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, "Production");
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const options = fetcher.mock.calls[1]![1] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({
      op: "key.delete",
      keys: [binFromString("k")],
      confirmation: {
        token: challenge.token,
        typed: "Production",
        reason: "Cleanup",
      },
    });
  });
  it("does not retry if confirmation is cancelled", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response(
        {
          error: {
            code: "confirmation_required",
            message: "Confirm",
            confirmation: challenge,
          },
        },
        428,
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    render(
      <ConfirmationProvider>
        <span>Workspace</span>
      </ConfirmationProvider>,
    );
    const failure = post("/test", {}).catch((error) => error as Error);
    await screen.findByTestId("confirmation-dialog");
    await userEvent.click(screen.getByText("Cancel"));
    expect(await failure).toBeInstanceOf(Error);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not loop forever on expired challenges", async () => {
    const fetcher = vi.fn().mockImplementation(async () =>
      response(
        {
          error: {
            code: "confirmation_required",
            message: "Expired",
            confirmation: challenge,
          },
        },
        428,
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const handler = vi.fn().mockResolvedValue({
      token: challenge.token,
      typed: "Production",
      reason: "Test",
    });
    setConfirmHandler(handler);
    await expect(post("/test")).rejects.toThrow("Expired");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });
  it("surfaces non-JSON failures safely", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>bad gateway</html>", { status: 502 }),
        ),
    );
    await expect(request("/test")).rejects.toThrow("502");
  });
  it("never repeats a denied write", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        response({ error: { code: "read_only", message: "Read only" } }, 403),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(post("/test")).rejects.toThrow("Read only");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("truncated collection safety", () => {
  const db: DatabaseSummary = {
    id: "db",
    name: "DB",
    environment: "test",
    effectiveRole: "operator",
    features: { profiler: false },
    readOnly: false,
    status: "connected",
  };
  it("disables member removal when the original bytes are not available", () => {
    render(
      <DatabaseContext value={db}>
        <KeyContent
          details={{
            key: binFromString("s"),
            type: "set",
            ttl: -1,
            value: {
              type: "set",
              members: [binFromString("partial")],
              cursor: "0",
              total: 1,
              truncatedMembers: 1,
            },
          }}
          refresh={async () => {}}
        />
      </DatabaseContext>,
    );
    expect(screen.getByText(/truncated previews/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove entry" })).toBeNull();
  });
  it("offers the safe value inspector for collection entries", async () => {
    render(
      <DatabaseContext value={db}>
        <KeyContent
          details={{
            key: binFromString("h"),
            type: "hash",
            ttl: -1,
            value: {
              type: "hash",
              entries: [
                {
                  field: binFromString("f"),
                  value: binFromString("<img src=x onerror=alert(1)>"),
                },
              ],
              cursor: "0",
              total: 1,
            },
          }}
          refresh={async () => {}}
        />
      </DatabaseContext>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "<img src=x onerror=alert(1)>" }),
    );
    expect(screen.getByTestId("value-inspector-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("key-value")).toHaveTextContent(
      "<img src=x onerror=alert(1)>",
    );
    expect(document.querySelector("img")).toBeNull();
  });
});
