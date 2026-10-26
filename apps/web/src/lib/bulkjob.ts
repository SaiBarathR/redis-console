import { useEffect, useRef } from "react";
import type { BulkDeleteJob, BulkDeleteJobResponse } from "@rconsole/shared";
import { dbPath, request } from "./api.ts";
import { useMemorySlot } from "./memory.tsx";
import type { ScanFilter } from "./keyscan.ts";

/** The pattern delete this tab started on a database, and its last reported state (session memory only). */
export interface BulkJobInfo {
  filter: ScanFilter;
  job: BulkDeleteJob;
  /** The finish was handled (the key list was refreshed). */
  seen?: boolean;
}

const POLL_MS = 500;

/**
 * A pattern delete as a server job (F20): starts it (the server's 428 impact challenge and typed confirmation come
 * first, through the usual confirmation dialog), polls its counts while it runs, stops it on request, and calls
 * `onFinished` once when it ends, also if the dialog was closed meanwhile.
 */
export function useBulkJob(databaseId: string, onFinished: (info: BulkJobInfo) => void) {
  const [info, setInfo] = useMemorySlot<BulkJobInfo | undefined>(`${databaseId}:bulk-job`, undefined);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  const running = info?.job.state === "running";
  const id = info?.job.id;

  useEffect(() => {
    if (!id || !running) return;
    let stop = false;
    const abort = new AbortController();
    const poll = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (stop) return;
        try {
          const { job } = await request<BulkDeleteJobResponse>(dbPath(databaseId, `/bulk-delete/jobs/${encodeURIComponent(id)}`), {
            signal: abort.signal,
            background: true,
          });
          if (stop) return;
          setInfo((current) => (current?.job.id === id ? { ...current, job } : current));
          if (job.state !== "running") return;
        } catch (caught) {
          if (stop || (caught instanceof DOMException && caught.name === "AbortError")) return;
          // The job is gone (server restart) or unreachable: report it as stopped rather than polling forever.
          setInfo((current) =>
            current?.job.id === id ? { ...current, job: { ...current.job, state: "stopped" } } : current,
          );
          return;
        }
      }
    };
    void poll();
    return () => {
      stop = true;
      abort.abort();
    };
  }, [databaseId, id, running]);

  useEffect(() => {
    if (info && info.job.state !== "running" && !info.seen) {
      setInfo({ ...info, seen: true });
      finished.current(info);
    }
  }, [info]);

  return {
    info,
    running,
    /** Starts the job (after the server's confirmation); resolves once it is running. */
    start: async (filter: ScanFilter) => {
      const { job } = await request<BulkDeleteJobResponse>(dbPath(databaseId, "/bulk-delete/jobs"), {
        method: "POST",
        body: { match: filter.match, ...(filter.type ? { type: filter.type } : {}) },
      });
      setInfo({ filter, job });
      return job;
    },
    /** Asks the server to stop between batches; what was deleted stays deleted. */
    cancel: async () => {
      if (!id) return;
      const { job } = await request<BulkDeleteJobResponse>(dbPath(databaseId, `/bulk-delete/jobs/${encodeURIComponent(id)}/cancel`), {
        method: "POST",
        body: {},
      });
      setInfo((current) => (current?.job.id === id ? { ...current, job } : current));
    },
    dismiss: () => setInfo(undefined),
  };
}

/** One line for a job's outcome: what was deleted, and why it ended early when it did. */
export function jobSummary(job: BulkDeleteJob): string {
  const n = (v: number) => v.toLocaleString();
  const counts = `Deleted ${n(job.deleted)} of ${n(job.scanned)} scanned keys`;
  const failed = job.failed ? `; ${n(job.failed)} could not be deleted` : "";
  switch (job.state) {
    case "running":
      return `Deleting… ${n(job.deleted)} deleted, ${n(job.scanned)} scanned${failed}.`;
    case "done":
      return `${counts}${failed}.`;
    case "cancelled":
      return `Stopped on request. ${counts}${failed}; keys not reached yet were left in place.`;
    case "failed":
      return `Stopped after repeated errors. ${counts}${failed}.`;
    default:
      return `Stopped ${
        job.stopReason === "time"
          ? "at the 10-minute limit"
          : job.stopReason === "keys"
            ? "after visiting 1,000,000 keys"
            : job.stopReason === "session"
              ? "because your session ended or your account changed"
              : job.stopReason === "shutdown"
                ? "because the server was shutting down"
                : "before the end"
      }. ${counts}${failed}. Run it again to continue.`;
  }
}
