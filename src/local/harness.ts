import type { ModelRequest } from './source.js';

// Remove known harness context envelopes only; never rewrite the person's text.
export function userText(value: string): string {
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\r?\n?/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>\r?\n?/g, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>\r?\n?/g, '')
    .replace(/^# AGENTS\.md instructions for [^\n]*\r?\n(?:[\s\S]*?<\/INSTRUCTIONS>\r?\n?)/g, '')
    .replace(/^# Environment\r?\n(?:[ \t]*- [^\n]*(?:\r?\n|$))+/g, '');
}
export function userTurns(request: ModelRequest): string[] {
  if (request.userMessages) return request.userMessages;
  return request.messages.filter(m => m.role === 'user').map(m => userText(m.content)).filter(s => s.length > 0);
}
export function housekeeping(request: ModelRequest): string | undefined {
  const instructions = request.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n').replace(/^x-anthropic-billing-header:[^\n]*\n?/gm, '').replace(/^You are Claude Code, Anthropic's official CLI for Claude\.\n?/gm, '').trimStart();
  const side = /^(?:generate|create|write|provide|return)[\s\S]{0,100}(?:session title|conversation title|chat title|short title|concise title|topic|summary)|^(?:quota|warm[- ]?up) (?:probe|check)|^title for (?:this|the) (?:session|conversation)/i;
  const claudeTitle = /^You are naming a coding session so the user can pick it out of a long list of sessions\./.test(instructions);
  if (!claudeTitle && !side.test(instructions)) return;
  const first = userTurns(request)[0];
  const text = claudeTitle ? first?.match(/<session>\n([\s\S]*?)\n<\/session>/)?.[1] : first;
  const reply = text?.replace(/\s+/g, ' ').slice(0, 80) || 'Ready';
  return claudeTitle ? JSON.stringify({ title: reply }) : reply;
}
