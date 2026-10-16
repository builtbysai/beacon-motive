import { MotiveError } from "../errors.ts";

// Optional local model provider (ADR 0015). Nothing in the core imports this unless a run asks for AI recovery. It talks
// only to a model server on this machine (Ollama's HTTP API on a loopback address); a remote host is refused, so no
// screen content can be sent off the machine by this code path.

export interface ModelProvider {
  id: string;
  model: string;
  /** Resolves to a reason string when the provider cannot be used right now, otherwise undefined. */
  unavailableReason(): Promise<string | undefined>;
  /** Asks for a JSON object matching `schema`. The reply is parsed; anything else is an error. */
  json(system: string, user: string, schema: object, signal?: AbortSignal): Promise<unknown>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function ollamaConfig(env: NodeJS.ProcessEnv = process.env): { base: URL; model: string } {
  const base = new URL(env.MOTIVE_OLLAMA_HOST ?? "http://127.0.0.1:11434");
  if (!LOOPBACK.has(base.hostname)) throw new MotiveError("permission_denied", `MOTIVE_OLLAMA_HOST must be a loopback address, not ${base.hostname}: screen content is never sent off this machine`);
  if (base.protocol !== "http:") throw new MotiveError("invalid_args", "MOTIVE_OLLAMA_HOST must be an http:// loopback address");
  return { base, model: env.MOTIVE_OLLAMA_MODEL ?? "qwen2.5:1.5b" };
}

export function ollamaProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const { base, model } = ollamaConfig(env);
  const url = (p: string) => new URL(p, base).toString();
  return {
    id: "ollama",
    model,
    async unavailableReason() {
      try {
        const r = await fetch(url("/api/tags"), { signal: AbortSignal.timeout(2500) });
        if (!r.ok) return `Ollama answered ${r.status}`;
        const body = (await r.json()) as { models?: { name: string }[] };
        const have = (body.models ?? []).map((m) => m.name);
        return have.some((n) => n === model || n === `${model}:latest`) ? undefined : `model ${model} is not pulled (have: ${have.join(", ") || "none"})`;
      } catch {
        return "Ollama is not running on this machine (start it with: ollama serve)";
      }
    },
    async json(system, user, schema, signal) {
      const r = await fetch(url("/api/chat"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: false, format: schema, options: { temperature: 0, num_ctx: 4096 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      if (!r.ok) throw new MotiveError("adapter_failed", `model server answered ${r.status}`);
      const content = ((await r.json()) as { message?: { content?: string } }).message?.content ?? "";
      try {
        return JSON.parse(content);
      } catch {
        throw new MotiveError("adapter_failed", "the model did not return valid JSON");
      }
    },
  };
}
