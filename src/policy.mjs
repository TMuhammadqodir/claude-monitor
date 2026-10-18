// What a machine may use: which model families, and up to which effort. The agent writes these into Claude
// Code's own settings (availableModels, maxEffortLevel), so Claude Code itself keeps to them, and checks them in
// its hooks too; the server tells the owner when a request went past them anyway.

// The families Claude Code's availableModels understands as aliases ("opus" allows every Opus version).
export const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

// Claude Code's effort levels, lowest first. "max" as a cap means no cap.
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The family of a model id: "claude-opus-5-5" → "opus" (Mythos counts as Fable); null when it names none. */
export function familyOf(model) {
  const match = /(fable|mythos|opus|sonnet|haiku)/.exec(String(model ?? '').toLowerCase());
  if (!match) return null;
  return match[1] === 'mythos' ? 'fable' : match[1];
}

/** The families in a stored or sent list, known ones only, in a fixed order; null for "every model". */
export function parseModels(value) {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(list)) return null;
  const chosen = MODEL_FAMILIES.filter((family) => list.includes(family));
  return chosen.length ? chosen : null;
}

/** A cap as stored: one of the levels below "max"; null for no cap. */
export const parseEffort = (value) => (EFFORTS.includes(value) && value !== 'max' ? value : null);

/** A machine's rules, as the gate hands them to its agent. */
export const policyOf = (machine) => ({ models: parseModels(machine.allowed_models), maxEffort: parseEffort(machine.max_effort) });

/** Whether the rules let the model run: a model of no known family (an internal one) is not judged. */
export function modelAllowed(policy, model) {
  if (!policy?.models) return true;
  const family = familyOf(model);
  return family === null || policy.models.includes(family);
}

/** Whether an effort level is above the cap. */
export function effortAbove(policy, level) {
  if (!policy?.maxEffort || !EFFORTS.includes(level)) return false;
  return EFFORTS.indexOf(level) > EFFORTS.indexOf(policy.maxEffort);
}
