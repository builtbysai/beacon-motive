// Measures how well the local model picks the right replacement control, on synthetic candidate lists (no apps needed).
// Positive cases have one right answer; negative cases have none, and the right answer is "none of these".
// Usage: node --disable-warning=ExperimentalWarning scripts/ai-eval.ts   (needs Ollama running with the model pulled)
import { ollamaProvider } from "../src/ai/provider.ts";
import { suggestTarget } from "../src/ai/recovery.ts";
import type { Candidate } from "../src/adapters/types.ts";

const C = (selector: Record<string, unknown>, describe: string): Candidate => ({ selector, describe });
const form = [C({ role: "textbox", name: "Email" }, 'textbox "Email"'), C({ role: "textbox", name: "Password" }, 'textbox "Password"'), C({ role: "link", name: "Forgot password?" }, 'link "Forgot password?"'), C({ role: "button", name: "Log in" }, 'button "Log in"'), C({ role: "link", name: "Help" }, 'link "Help"')];
const shop = [C({ role: "button", name: "Add to basket" }, 'button "Add to basket"'), C({ role: "link", name: "View basket" }, 'link "View basket"'), C({ role: "textbox", name: "Search" }, 'textbox "Search"'), C({ role: "button", name: "Sort" }, 'button "Sort"'), C({ role: "link", name: "Sign in" }, 'link "Sign in"')];
const win = [C({ automationId: "nameBox" }, 'Edit "Name" (automationId nameBox)'), C({ automationId: "pwBox" }, 'Edit "Secret" (automationId pwBox)'), C({ automationId: "goButton" }, 'Button "Go" (automationId goButton)'), C({ automationId: "loudBox" }, 'CheckBox "Shout" (automationId loudBox)'), C({ automationId: "resultLabel" }, 'Text "Ready" (automationId resultLabel)'), C({ name: "Close", controlType: "Button" }, 'Button "Close"')];

const cases: { name: string; original: Record<string, unknown>; list: Candidate[]; expect: string | null }[] = [
  { name: "typo in id", original: { automationId: "goButtn" }, list: win, expect: "goButton" },
  { name: "id renamed", original: { automationId: "submitButton" }, list: win, expect: "goButton" },
  { name: "button relabelled (Log in -> Sign in)", original: { role: "button", name: "Sign in" }, list: form, expect: "Log in" },
  { name: "button reworded (Add to cart)", original: { role: "button", name: "Add to cart" }, list: shop, expect: "Add to basket" },
  { name: "link reworded (View cart)", original: { role: "link", name: "View cart" }, list: shop, expect: "View basket" },
  { name: "field relabelled (E-mail address)", original: { role: "textbox", name: "E-mail address" }, list: form, expect: "Email" },
  { name: "no match: Export to PDF", original: { role: "button", name: "Export to PDF" }, list: shop, expect: null },
  { name: "no match: Delete account", original: { role: "button", name: "Delete account" }, list: form, expect: null },
  { name: "no match: Upload photo", original: { role: "button", name: "Upload photo" }, list: shop, expect: null },
  { name: "no match: id volumeSlider", original: { automationId: "volumeSlider" }, list: win, expect: null },
  { name: "no match: Checkout", original: { role: "button", name: "Checkout" }, list: form, expect: null },
  { name: "no match: Print", original: { role: "button", name: "Print receipt" }, list: shop, expect: null },
];

const provider = ollamaProvider();
const why = await provider.unavailableReason();
if (why) throw new Error(`local model unavailable: ${why}`);
let right = 0;
let falsePositive = 0;
let missed = 0;
let wrong = 0;
const times: number[] = [];
console.log(`model ${provider.model}\n`);
for (const c of cases) {
  const t0 = performance.now();
  const s = await suggestTarget(provider, { stepId: "step", op: "x.click", original: c.original, candidates: c.list }).catch(() => undefined);
  times.push(performance.now() - t0);
  const got = s ? s.candidate.describe : null;
  const ok = c.expect === null ? got === null : got !== null && got.includes(c.expect);
  if (ok) right++;
  else if (c.expect === null) falsePositive++;
  else if (got === null) missed++;
  else wrong++;
  console.log(`${ok ? "ok  " : "FAIL"} ${c.name.padEnd(40)} expected ${String(c.expect).padEnd(16)} got ${got}`);
}
times.sort((a, b) => a - b);
console.log(`\n${right}/${cases.length} correct; false positives ${falsePositive}; missed ${missed}; wrong control ${wrong}; median ${Math.round(times[Math.floor(times.length / 2)]!)} ms per suggestion`);
