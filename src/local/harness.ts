import { messageText } from './source.js';
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
  return request.messages.filter(m => m.role === 'user').map(m => userText(messageText(m.content))).filter(s => s.length > 0);
}
// Harnesses report finished subagents as new user-role messages: Codex wraps
// them in <subagent_notification>, Claude Code in <task-notification>. They
// are tool-result-like events for the same task, not a person starting a new one.
const notifications = /<(subagent_notification|task-notification)>[\s\S]*?<\/\1>\r?\n?/g;
// The person's text with harness notifications removed; empty when nothing else is left.
export function taskText(value: string): string {
  const text = userText(value).replace(notifications, '');
  return text.trim().length ? text : '';
}
// User turns that define a task's identity. Notification-only turns do not count,
// so an orchestrator keeps its task and source after a subagent finishes. The
// notification stays in request.messages for the model.
export function taskTurns(request: ModelRequest): string[] {
  return userTurns(request).map(taskText).filter(s => s.length > 0);
}
export function housekeeping(request: ModelRequest): string | undefined {
  const instructions = request.messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => messageText(m.content)).join('\n').replace(/^x-anthropic-billing-header:[^\n]*\n?/gm, '').replace(/^You are Claude Code, Anthropic's official CLI for Claude\.\n?/gm, '').trimStart();
  const side = /^(?:generate|create|write|provide|return)[\s\S]{0,100}(?:session title|conversation title|chat title|short title|concise title|topic|summary)|^(?:quota|warm[- ]?up) (?:probe|check)|^title for (?:this|the) (?:session|conversation)/i;
  const claudeTitle = /^You are naming a coding session so the user can pick it out of a long list of sessions\./.test(instructions);
  if (!claudeTitle && !side.test(instructions)) return;
  const first = userTurns(request)[0];
  const text = claudeTitle ? first?.match(/<session>\n([\s\S]*?)\n<\/session>/)?.[1] : first;
  const reply = text?.replace(/\s+/g, ' ').slice(0, 80) || 'Ready';
  return claudeTitle ? JSON.stringify({ title: reply }) : reply;
}
