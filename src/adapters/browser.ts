import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { z } from "zod";
import { MotiveError } from "../errors.ts";
import { checkDir } from "./fs.ts";
import type { Adapter, OpContext, OpDef } from "./types.ts";

export const Target = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    text: z.string().optional(),
    testId: z.string().optional(),
    css: z.string().optional(), // last resort
    exact: z.boolean().default(false),
  })
  .strict();
export type Target = z.infer<typeof Target>;

/** The one place a semantic target becomes a Playwright locator; the recorder validates targets with it too. */
export function buildLocator(page: Page, t: Target): Locator {
  const { role, name, label, text, testId, css, exact } = t;
  if (role) return page.getByRole(role as Parameters<Page["getByRole"]>[0], { ...(name ? { name } : {}), exact });
  if (label) return page.getByLabel(label, { exact });
  if (text) return page.getByText(text, { exact });
  if (testId) return page.getByTestId(testId);
  if (css) return page.locator(css);
  throw new MotiveError("invalid_args", "target needs one of role, label, text, testId, css");
}

export function chromePath(): string | undefined {
  const candidates = [
    process.env.MOTIVE_CHROME,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((c) => c && existsSync(c));
}

export function browserAdapter(): Adapter {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let disposed = false;

  const executable = chromePath();

  function locate(t: Target): Locator {
    if (!page) throw new MotiveError("precondition_failed", "no page is open; run browser.open first");
    return buildLocator(page, t);
  }

  /** Playwright errors become structured ones; auto-waiting already covered visibility/enabled/stability. */
  async function guarded<T>(ctx: OpContext, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (ctx.signal.aborted) throw new MotiveError("cancelled", "cancelled");
      const msg = e instanceof Error ? e.message : String(e);
      if (/strict mode violation/.test(msg)) throw new MotiveError("ambiguous", "the target matches more than one element; make it more specific");
      if (/Timeout .*exceeded/.test(msg)) throw new MotiveError("timeout", msg.split("\n")[0]!, { retryable: true });
      if (e instanceof MotiveError) throw e;
      throw new MotiveError("adapter_failed", msg.split("\n")[0]!);
    }
  }

  async function ensurePage(headless: boolean): Promise<Page> {
    if (page) return page;
    if (!executable) {
      throw new MotiveError("unsupported", "No Chrome or Edge found. Install one or set MOTIVE_CHROME to its path (no browser is downloaded automatically).");
    }
    browser = await chromium.launch({ executablePath: executable, headless });
    if (disposed) {
      await browser.close().catch(() => {});
      throw new MotiveError("cancelled", "cancelled");
    }
    context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    page = await context.newPage();
    return page;
  }

  const open: OpDef = {
    name: "browser.open",
    idempotent: false,
    args: z.object({ url: z.string(), headless: z.boolean().default(true) }).strict(),
    async run(a: { url: string; headless: boolean }, ctx) {
      let url: URL;
      try {
        // A relative path (./page.html) means a local file, resolved from the working directory.
        url = new URL(/^\.{1,2}[\\/]/.test(a.url) ? pathToFileURL(path.resolve(a.url)).href : a.url);
      } catch {
        throw new MotiveError("invalid_args", "url is not valid");
      }
      if (url.protocol === "file:") {
        await checkDir(fileURLToPath(url), ctx, true);
      } else if (url.protocol === "http:" || url.protocol === "https:") {
        if (!ctx.scopes.hosts.includes(url.hostname)) {
          throw new MotiveError("scope_denied", `${url.hostname} is not in this workflow's scopes.hosts`);
        }
      } else {
        throw new MotiveError("scope_denied", `${url.protocol} URLs are not allowed`);
      }
      return guarded(ctx, async () => {
        const p = await ensurePage(a.headless);
        const response = await p.goto(url.href, { timeout: ctx.budgetMs, waitUntil: "load" });
        return { url: p.url(), title: await p.title(), status: response?.status() ?? 0 };
      });
    },
  };

  const click: OpDef = {
    name: "browser.click",
    idempotent: false,
    args: z.object({ target: Target }).strict(),
    run: (a: { target: Target }, ctx) =>
      guarded(ctx, async () => {
        await locate(a.target).click({ timeout: ctx.budgetMs });
        return { clicked: true };
      }),
  };

  const fill: OpDef = {
    name: "browser.fill",
    idempotent: true,
    args: z.object({ target: Target, value: z.string() }).strict(),
    run: (a: { target: Target; value: string }, ctx) =>
      guarded(ctx, async () => {
        await locate(a.target).fill(a.value, { timeout: ctx.budgetMs });
        return { filled: true };
      }),
  };

  const read: OpDef = {
    name: "browser.read",
    idempotent: true,
    args: z.object({ target: Target }).strict(),
    run: (a: { target: Target }, ctx) =>
      guarded(ctx, async () => {
        const loc = locate(a.target);
        await loc.waitFor({ state: "attached", timeout: ctx.budgetMs });
        const text = ((await loc.textContent({ timeout: ctx.budgetMs })) ?? "").trim();
        return { text };
      }),
  };

  const select: OpDef = {
    name: "browser.select",
    idempotent: true,
    args: z.object({ target: Target, option: z.string() }).strict(),
    run: (a: { target: Target; option: string }, ctx) =>
      guarded(ctx, async () => {
        await locate(a.target).selectOption({ label: a.option }, { timeout: ctx.budgetMs });
        return { selected: a.option };
      }),
  };

  const press: OpDef = {
    name: "browser.press",
    idempotent: false,
    args: z.object({ target: Target, key: z.enum(["Enter", "Escape", "Tab"]) }).strict(),
    run: (a: { target: Target; key: string }, ctx) =>
      guarded(ctx, async () => {
        await locate(a.target).press(a.key, { timeout: ctx.budgetMs });
        return { pressed: a.key };
      }),
  };

  const wait: OpDef = {
    name: "browser.wait",
    idempotent: true,
    args: z.object({ target: Target, state: z.enum(["visible", "hidden", "attached", "detached"]).default("visible") }).strict(),
    run: (a: { target: Target; state: "visible" | "hidden" | "attached" | "detached" }, ctx) =>
      guarded(ctx, async () => {
        await locate(a.target).waitFor({ state: a.state, timeout: ctx.budgetMs });
        return { state: a.state };
      }),
  };

  return {
    id: "browser",
    ops: [open, click, fill, select, press, read, wait],
    capability: () => ({
      adapter: "browser",
      available: Boolean(executable),
      ...(executable ? {} : { reason: "No Chrome or Edge found (set MOTIVE_CHROME)" }),
      ops: ["browser.open", "browser.click", "browser.fill", "browser.select", "browser.press", "browser.read", "browser.wait"],
    }),
    async dispose() {
      disposed = true;
      const b = browser;
      browser = undefined;
      context = undefined;
      page = undefined;
      await b?.close().catch(() => {});
    },
  };
}

export { pathToFileURL };
