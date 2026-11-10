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
  const instructions = request.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n');
  const latest = request.messages.at(-1)?.content ?? '';
  const side = /(?:generate|create|write|provide|return)[\s\S]{0,100}(?:session title|conversation title|chat title|short title|concise title|topic|summary)|(?:quota|warm[- ]?up) (?:probe|check)|title for (?:this|the) (?:session|conversation)/i;
  if (!side.test(instructions) && !side.test(latest)) return;
  return userTurns(request)[0]?.replace(/\s+/g, ' ').slice(0, 80) || 'Ready';
}
