import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { buildLocator, chromePath, type Target } from "../adapters/browser.ts";
import { MotiveError } from "../errors.ts";
import type { RecordedStep } from "./compile.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SCRIPT = path.join(here, "page-script.js");

interface RawEvent {
  seq: number;
  kind: "click" | "fill" | "select" | "press";
  candidates: Target[];
  label?: string;
  value?: string;
  secret?: boolean;
  key?: "Enter";
}

/** Turns the page's DOM events into recorded steps, checking each target against Playwright's own matching. */
export class Recorder {
  steps: RecordedStep[] = [];
  private chain: Promise<void> = Promise.resolve();
  private lastUserEvent = 0;

  /** Starts recording on a context. Recording exists only for the lifetime of this context. */
  async attach(context: BrowserContext, startUrl: string): Promise<void> {
    await context.exposeBinding("__motiveEvent", (source, ev: RawEvent) => {
      this.lastUserEvent = Date.now();
      this.chain = this.chain.then(() => this.handle(source.page, ev)).catch(() => {});
    });
    await context.addInitScript({ path: PAGE_SCRIPT });
    const watch = (page: Page) =>
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame() || frame.url() === "about:blank") return;
        const consequence = Date.now() - this.lastUserEvent < 2500;
        const last = this.steps.at(-1);
        if (!consequence && !(last?.kind === "open" && last.url === frame.url())) this.steps.push({ kind: "open", url: frame.url() });
      });
    for (const p of context.pages()) watch(p);
    context.on("page", watch);
    this.steps.push({ kind: "open", url: startUrl });
  }

  async idle(): Promise<void> {
    await this.chain;
  }

  private async handle(page: Page, ev: RawEvent): Promise<void> {
    const attr = `data-motive-${ev.seq}`;
    let chosen: Target | undefined;
    const alternatives: Target[] = [];
    let verified: RecordedStep["verified"] = "ambiguous";
    let pageGone = false;
    try {
      // Every candidate that identifies exactly the touched element is kept: the first is used, the rest are
      // stored as alternatives so a later repair can be proposed if the first stops matching.
      for (const c of ev.candidates) {
        for (const exact of [false, true]) {
          const target = { ...c, exact } as Target;
          const loc = buildLocator(page, target);
          if ((await loc.count()) !== 1) continue;
          if (await loc.evaluate((el, a) => el.hasAttribute(a), attr)) {
            const found = c.css || !exact ? { ...c } : target;
            if (!chosen) {
              chosen = found;
              verified = "unique";
            } else alternatives.push(found);
            break;
          }
        }
      }
    } catch {
      pageGone = true; // the click navigated away before we could check
    }
    if (pageGone) {
      chosen = ev.candidates.find((c) => !c.css) ?? ev.candidates[0];
      verified = "unverified";
    }
    await page.evaluate((a) => document.querySelectorAll(`[${a}]`).forEach((e) => e.removeAttribute(a)), attr).catch(() => {});
    const step: RecordedStep = { kind: ev.kind, verified, ...(alternatives.length && !pageGone ? { alternatives: alternatives.slice(0, 3) } : {}), ...(ev.label ? { label: ev.label } : {}), ...(chosen ? { target: chosen } : {}) };
    if (ev.kind === "fill") {
      step.secret = Boolean(ev.secret);
      if (!ev.secret) step.value = ev.value ?? "";
    }
    if (ev.kind === "select") step.value = ev.value ?? "";
    if (ev.kind === "press") step.key = "Enter";
    this.steps.push(step);
  }
}

/** Interactive session: opens a visible Chrome with the recorder attached and resolves when the user closes it or aborts. */
export async function recordSession(url: string, onStarted: () => void, abort: AbortSignal): Promise<RecordedStep[]> {
  const exe = chromePath();
  if (!exe) throw new MotiveError("unsupported", "No Chrome or Edge found (set MOTIVE_CHROME).");
  const browser = await chromium.launch({ executablePath: exe, headless: false });
  const context = await browser.newContext({ viewport: null });
  const recorder = new Recorder();
  await recorder.attach(context, url);
  const page = await context.newPage();
  await page.goto(url);
  onStarted();
  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => resolve());
    abort.addEventListener("abort", () => resolve(), { once: true });
  });
  await recorder.idle();
  await browser.close().catch(() => {});
  return recorder.steps;
}
