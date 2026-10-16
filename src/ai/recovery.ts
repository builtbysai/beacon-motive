import type { Candidate } from "../adapters/types.ts";
import type { ModelProvider } from "./provider.ts";

// Supervised recovery (ADR 0015). When a recorded target stops matching and no recorded alternative works, a local model
// may be asked which of the controls that are really on screen is the same control. It chooses only from that list (or
// says it cannot tell); the engine then checks the choice resolves to exactly one control and offers it as a proposal.
// Nothing is changed or retried: the run still fails and a person applies the repair.
//
// Small local models index badly (a 1.5B model named the wrong row of a numbered list while describing the right one), so
// the model answers with the text of a control, constrained by the JSON schema to one of the listed texts or "none", and
// gives its reason first. Candidates are listed most-similar-first so the likeliest one is not buried.

export const MAX_CANDIDATES = 40;
export const NONE = "none of these";

const SYSTEM = [
  "You repair a broken UI automation step.",
  "A step was recorded to act on one control, but that control can no longer be found, probably because it was renamed, retyped or moved.",
  "You are given the recorded target and a list of the controls currently on screen, most similar first.",
  `Say which one control is clearly the same control as the recorded one. If none is clearly the same, or several are equally likely, answer "${NONE}".`,
  "Never invent a control. Give a one-sentence reason first, then your answer. JSON only.",
].join(" ");

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

const strings = (o: unknown): string[] => Object.values((o ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => v.toLowerCase());

/** 0..1: how close the best-matching pair of strings in the recorded target and the candidate's selector is. */
export function similarity(original: unknown, candidate: Candidate): number {
  const want = strings(original);
  const have = [...strings(candidate.selector), candidate.describe.toLowerCase()];
  let best = 0;
  for (const w of want) for (const h of have) best = Math.max(best, 1 - distance(w, h) / Math.max(w.length, h.length, 1));
  return best;
}

const VERIFY_SYSTEM = [
  "You check a proposed repair for a UI automation step.",
  "A control was recorded and can no longer be found. Someone proposes a control that is on screen now as its replacement.",
  "Answer yes only if the proposed control would do the same job as the recorded one (the same control, renamed, reworded or retyped).",
  "Answer no if it is merely another control of the same kind, or if you are not sure. Give a one-sentence reason first. JSON only.",
].join(" ");

export interface Suggestion {
  candidate: Candidate;
  reason: string;
}

export async function suggestTarget(
  provider: ModelProvider,
  ask: { stepId: string; op: string; description?: string; original: unknown; candidates: Candidate[] },
  signal?: AbortSignal,
): Promise<Suggestion | undefined> {
  const ranked = [...ask.candidates].sort((a, b) => similarity(ask.original, b) - similarity(ask.original, a)).slice(0, MAX_CANDIDATES);
  if (!ranked.length) return undefined;
  // Unique, exact texts for the model to answer with.
  const seen = new Map<string, Candidate>();
  for (const c of ranked) {
    let text = c.describe;
    for (let n = 2; seen.has(text); n++) text = `${c.describe} #${n}`;
    seen.set(text, c);
  }
  const texts = [...seen.keys()];
  const schema = {
    type: "object",
    properties: { reason: { type: "string" }, choice: { type: "string", enum: [...texts, NONE] } },
    required: ["reason", "choice"],
  };
  const user = [
    `Step: ${ask.stepId} (${ask.op})`,
    `Recorded target: ${JSON.stringify(ask.original)}`,
    "Controls on screen now, most similar first:",
    ...texts.map((t) => `- ${t}`),
  ]
    .filter(Boolean)
    .join("\n");
  const out = (await provider.json(SYSTEM, user, schema, signal)) as { choice?: unknown; reason?: unknown };
  const chosen = typeof out.choice === "string" ? seen.get(out.choice) : undefined;
  if (!chosen) return undefined;
  // Picking the least-bad of a list is easy to get wrong when the right control is simply not there, so the choice has to
  // survive a separate yes/no check of that one pair.
  const check = (await provider.json(
    VERIFY_SYSTEM,
    `Recorded control: ${JSON.stringify(ask.original)}
Proposed replacement: ${chosen.describe}
Would the proposed control do the same job as the recorded one?`,
    { type: "object", properties: { reason: { type: "string" }, same_job: { type: "boolean" } }, required: ["reason", "same_job"] },
    signal,
  )) as { same_job?: unknown };
  if (check.same_job !== true) return undefined;
  return { candidate: chosen, reason: String(out.reason ?? "").slice(0, 300) };
}
