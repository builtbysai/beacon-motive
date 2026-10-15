import { isDeepStrictEqual } from "node:util";
import { interpolate, parseWorkflow, type Workflow } from "../workflow.ts";

export class InductionMismatch extends Error {}

export interface Induced {
  workflow: Workflow;
  /** One line per input saying what was decided and why, for the reviewer. */
  report: string[];
}

/**
 * Merges several demonstrations of the same task. Policy:
 *  - the demonstrations must have identical structure (same operations, same targets); anything else is a mismatch the
 *    user must resolve with another demonstration or by editing, never something to average away;
 *  - an input whose value differs between demonstrations is a variable (kept as an input, first value as default);
 *  - an input with the same value in every demonstration is treated as a constant and inlined, and the report says so,
 *    because identical demonstrations cannot prove a value never changes;
 *  - secrets stay secrets.
 */
export function induce(demos: Workflow[], name: string): Induced {
  if (demos.length < 2) throw new InductionMismatch("Need at least two demonstrations to tell constants from variables.");
  const [first, ...rest] = demos as [Workflow, ...Workflow[]];

  for (const [d, w] of rest.entries()) {
    if (w.steps.length !== first.steps.length) throw new InductionMismatch(`Demonstration ${d + 2} has ${w.steps.length} steps but demonstration 1 has ${first.steps.length}. Record the same task, or edit one to match.`);
    for (const [i, s] of w.steps.entries()) {
      const f = first.steps[i]!;
      if (s.op !== f.op) throw new InductionMismatch(`Step ${i + 1} differs: ${f.op} in demonstration 1, ${s.op} in demonstration ${d + 2}.`);
      if (!isDeepStrictEqual(s.args, f.args)) {
        const a = JSON.stringify(f.args);
        const b = JSON.stringify(s.args);
        throw new InductionMismatch(`Step ${i + 1} (${f.op}) differs between demonstrations:\n  1: ${a}\n  ${d + 2}: ${b}\nIf the target differs, the page may have changed; if the text differs, give the control a stable name.`);
      }
    }
    const names = [Object.keys(first.inputs).sort().join(), Object.keys(w.inputs).sort().join()];
    if (names[0] !== names[1]) throw new InductionMismatch(`Demonstration ${d + 2} has different inputs (${names[1]}) than demonstration 1 (${names[0]}).`);
  }

  const report: string[] = [];
  const constants: Record<string, unknown> = {};
  const inputs: Workflow["inputs"] = {};
  for (const [key, def] of Object.entries(first.inputs)) {
    if (def.secret) {
      inputs[key] = def;
      report.push(`${key}: secret, supplied at run time`);
      continue;
    }
    const values = demos.map((w) => w.inputs[key]!.default);
    if (values.every((v) => isDeepStrictEqual(v, values[0]))) {
      constants[key] = values[0];
      report.push(`${key}: the same in all ${demos.length} demonstrations (${JSON.stringify(values[0])}) → constant. If it should vary, demonstrate it with different values.`);
    } else {
      inputs[key] = { ...def, default: values[0]! };
      report.push(`${key}: varies (${values.map((v) => JSON.stringify(v)).join(", ")}) → input`);
    }
  }

  // Inline constants; references to remaining inputs and to steps are left for the engine.
  const keep = Object.fromEntries(Object.keys(inputs).map((k) => [k, `\${inputs.${k}}`]));
  const scope = { inputs: { ...keep, ...constants }, steps: {} };
  const steps = first.steps.map((s) => ({ ...s, args: interpolate(s.args, scope) as Record<string, unknown> }));

  const workflow = parseWorkflow({ ...first, name, description: `Induced from ${demos.length} demonstrations. Review before relying on it.`, inputs, steps });
  return { workflow, report };
}
