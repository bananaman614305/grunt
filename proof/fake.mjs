// Offline proof adapter for the built CLI. Never use it for a deployment.
// Run with: MILO_DB=file:/tmp/milo-proof.db PORT=8788 node --import ./proof/fake.mjs dist/server.js
import { createServer } from 'node:http';
const realFetch = globalThis.fetch;
const jobs = [];
let workerCalls = 0;
const answer = (content, tool_calls = []) => Response.json({ choices: [{ message: { content, tool_calls } }], usage: { prompt_tokens: 100, completion_tokens: 80 } });
const tool = (name, args) => ({ type: 'function', function: { name, arguments: JSON.stringify(args) } });
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://openrouter.ai/api/v1/chat/completions')) return realFetch(input, init);
  const body = JSON.parse(init.body);
  const first = body.messages[0].content;
  if (first.startsWith('Complete Milo')) {
    workerCalls++;
    return new Promise((resolve, reject) => {
      const job = { resolve, reject }; jobs.push(job);
      init.signal?.addEventListener('abort', () => { const index = jobs.indexOf(job); if (index >= 0) jobs.splice(index, 1); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    });
  }
  if (first.includes('job just finished')) return answer('Your launch plan is ready. Start with a small TypeScript prototype, test it with five people, then launch to a focused audience. I kept the plan short. Open the job for the full result.');
  const text = body.messages.at(-1).content;
  if (/remember|keep answers short/i.test(text)) return answer('Got it.', [tool('remember', { fact: 'I write TypeScript. Keep answers short.' })]);
  if (/plan|compare/i.test(text)) return answer('I’ll put that together while we keep chatting.', [tool('dispatch', { title: 'A launch plan for your TypeScript app', brief: 'Write a concise one-page launch plan for a TypeScript app. Focus on a prototype, customer validation and a small public launch.', kind: 'writing' })]);
  if (/capital/i.test(text)) return answer('Paris. Your launch plan is still running — you can keep asking questions.');
  return answer('Hi, I’m Milo. Ask me a question or give me a bigger job to work on.');
};
const control = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/release') {
    for (const job of jobs.splice(0)) job.resolve(answer('Launch plan\n\n1. Prototype — build the core workflow in TypeScript. Keep the first version to one useful action.\n\n2. Validate — let five potential users try it. Watch where they get stuck and fix the biggest obstacle.\n\n3. Launch — publish a short walkthrough for one focused community. Invite feedback and measure repeat use.\n\nKeep the scope small, answer feedback quickly, and expand only after people return.'));
  }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ pending: jobs.length, workerCalls }));
});
control.listen(18789, '127.0.0.1');
process.on('SIGTERM', () => control.close());
process.on('SIGINT', () => control.close());
