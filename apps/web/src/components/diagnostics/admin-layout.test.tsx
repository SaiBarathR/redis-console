import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Audit } from "../../pages/Admin.tsx";
import { request } from "../../lib/api.ts";

vi.mock("../../lib/context.tsx", () => ({ useSession: () => ({ me: { role: "admin" } }) }));
vi.mock("../../lib/api.ts", async (original) => ({
  ...await original<typeof import("../../lib/api.ts")>(), request: vi.fn(),
}));
afterEach(cleanup);

function audit(args: string[]) {
  vi.mocked(request).mockResolvedValue({ events: [{
    id: "synthetic-audit", at: "2026-01-01T00:00:00Z", username: "qa-admin", ip: "127.0.0.1",
    action: "cli.exec", outcome: "allowed", databaseId: "sandbox-e2e", command: "MGET", argvRedacted: args,
    keyCount: args.length - 1,
  }] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Audit /></QueryClientProvider>);
}

it("expands a long redacted command without replacing or losing its arguments", async () => {
  const args = ["MGET", ...Array.from({ length: 60 }, (_, i) => `key#${String(i).padStart(12, "0")}`)];
  audit(args);
  const toggle = await screen.findByRole("button", { name: "Show full command" });
  const command = document.querySelector(".audit-command")!;
  expect(command).toHaveClass("clamped");
  expect(command.textContent).toContain(args.at(-1));
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(command).not.toHaveClass("clamped");
  expect(command.textContent).toContain(args.at(-1));
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(command).toHaveClass("clamped");
});

it("leaves short commands fully visible without an unnecessary expansion control", async () => {
  audit(["MGET", "key#000000000001"]);
  await screen.findByText("MGET");
  expect(screen.queryByRole("button", { name: "Show full command" })).toBeNull();
  expect(document.querySelector(".audit-command")).not.toHaveClass("clamped");
});
