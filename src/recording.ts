import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MotiveError, toErrorInfo, type ErrorInfo } from "./errors.ts";
import { compile, type RecordedStep } from "./record/compile.ts";
import { compileWindow, recordWindow, type WinRecordedStep } from "./record/windows.ts";
import { recordSession } from "./record/recorder.ts";
import type { Store } from "./store.ts";
import type { Workflow } from "./workflow.ts";

// Teach Mode as a service (ADR 0010). One demonstration at a time. Recording is always visible on the machine (a real
// browser window, or the red indicator for a Windows app), is explicit (it exists only because a client asked for it
// and ends when the user finishes it), and its result is a draft that reaches the library only through `save`.

const Name = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const RecordSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("browser"), name: Name, url: z.string().url().max(2000), expectText: z.string().max(200).optional() }).strict(),
  z.object({
    kind: z.literal("windows"),
    name: Name,
    window: z.string().min(1).max(200),
    command: z.string().min(1).max(260).optional(),
    expect: z.object({ automationId: z.string().min(1).max(200), text: z.string().max(200) }).strict().optional(),
  }).strict(),
]);
export type RecordSpec = z.infer<typeof RecordSpec>;

export interface RecordingState {
  id: string;
  kind: RecordSpec["kind"];
  name: string;
  status: "starting" | "recording" | "finished" | "failed" | "discarded";
  startedAt: string;
  workflow?: Workflow;
  warnings?: string[];
  steps?: number;
  error?: ErrorInfo;
  saved?: boolean;
}

/** The two recorders, injectable so the lifecycle can be tested without a person at the keyboard. */
export interface Recorders {
  browser(url: string, onStarted: () => void, signal: AbortSignal): Promise<RecordedStep[]>;
  windows(window: { name: string }, signal: AbortSignal, onStarted: () => void): Promise<WinRecordedStep[]>;
}
const realRecorders: Recorders = { browser: recordSession, windows: recordWindow };

interface Active {
  state: RecordingState;
  abort: AbortController;
  done: Promise<void>;
}

export class RecordingManager {
  private store: Store;
  private recorders: Recorders;
  private current?: Active;
  private past = new Map<string, RecordingState>();

  constructor(store: Store, recorders: Recorders = realRecorders) {
    this.store = store;
    this.recorders = recorders;
  }

  start(spec: RecordSpec, actor = "api"): RecordingState {
    if (this.current && ["starting", "recording"].includes(this.current.state.status)) {
      throw new MotiveError("precondition_failed", "a recording is already in progress", { retryable: true });
    }
    const state: RecordingState = { id: randomUUID(), kind: spec.kind, name: spec.name, status: "starting", startedAt: new Date().toISOString() };
    const abort = new AbortController();
    const onStarted = () => {
      if (state.status === "starting") state.status = "recording";
    };
    this.store.audit(actor, "record.start", { id: state.id, kind: spec.kind, name: spec.name });
    const run = async () => {
      try {
        if (spec.kind === "browser") {
          const steps = await this.recorders.browser(spec.url, onStarted, abort.signal);
          const c = compile(steps, { name: spec.name, ...(spec.expectText ? { expectText: spec.expectText } : {}) });
          Object.assign(state, { workflow: c.workflow, warnings: c.warnings, steps: steps.length });
        } else {
          const steps = await this.recorders.windows({ name: spec.window }, abort.signal, onStarted);
          const c = compileWindow(steps, { name: spec.name, window: spec.window, ...(spec.command ? { command: spec.command } : {}), ...(spec.expect ? { expect: spec.expect } : {}) });
          Object.assign(state, { workflow: c.workflow, warnings: c.warnings, steps: steps.length });
        }
        if (state.status !== "discarded") state.status = "finished";
      } catch (e) {
        if (state.status !== "discarded") {
          state.status = "failed";
          state.error = toErrorInfo(e);
        }
      }
      this.store.audit(actor, "record.end", { id: state.id, status: state.status, steps: state.steps ?? 0 });
    };
    this.current = { state, abort, done: run() };
    this.past.set(state.id, state);
    return state;
  }

  get(id: string): RecordingState | undefined {
    return this.past.get(id);
  }

  /** The user is done demonstrating (the same as closing the browser window). Resolves once the draft exists. */
  async finish(id: string): Promise<RecordingState> {
    const cur = this.current;
    if (!cur || cur.state.id !== id) throw new MotiveError("not_found", "no such active recording");
    cur.abort.abort();
    await cur.done;
    return cur.state;
  }

  /** Stops and throws the demonstration away. */
  async discard(id: string, actor = "api"): Promise<void> {
    const s = this.past.get(id);
    if (!s) throw new MotiveError("not_found", "no such recording");
    if (this.current?.state.id === id && ["starting", "recording"].includes(s.status)) {
      s.status = "discarded";
      this.current.abort.abort();
      await this.current.done;
    }
    s.status = "discarded";
    delete s.workflow;
    this.store.audit(actor, "record.discard", { id });
  }

  /** The only path from a recording to the library. */
  save(id: string, actor = "api"): Workflow {
    const s = this.past.get(id);
    if (!s) throw new MotiveError("not_found", "no such recording");
    if (s.status !== "finished" || !s.workflow) throw new MotiveError("precondition_failed", `recording is ${s.status}, not finished`);
    this.store.saveWorkflow(s.workflow);
    this.store.audit(actor, "workflow.save", { name: s.workflow.name, recorded: true });
    s.saved = true;
    return s.workflow;
  }

  /** Stops an active recording without keeping it (server shutdown, emergency stop). */
  async stopAll(): Promise<void> {
    if (this.current && ["starting", "recording"].includes(this.current.state.status)) await this.discard(this.current.state.id, "system");
  }
}
