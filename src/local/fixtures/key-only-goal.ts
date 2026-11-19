// Test helper: setup asks Squire only to sign in and capture or pair one
// credential. Registry providers are already vetted as free, so a goal must
// not ask Squire to pick a plan or tier, enable or choose a model, or
// activate a quota or allowance. Prohibitions ("No paid plan", "Never accept
// ... upgrade", "do not open billing or plan pages") are the safety clause
// and stay.
const planStep = new RegExp([
  'free plan', 'enable (only )?(its )?(daily )?free', 'free model', 'plan', 'tier', 'upgrade',
  'activate', 'allowance', 'quota', 'check-?in', 'free tokens', 'requested model',
  String.raw`\buse only\b[^.;]*\b(model|deepseek|glm|qwen|ernie)\b`
].join('|'), 'i');
const prohibition = /^(no|never|do not)\b/i;

export function planSteps(goal: string): string[] {
  return goal.split(/(?<=\.)\s+/).flatMap(sentence => sentence.split(/;\s+/))
    .filter(part => planStep.test(part) && !prohibition.test(part.trim()));
}
