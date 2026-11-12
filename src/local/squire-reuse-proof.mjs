// Built setup connection proof using an isolated MCP broker stand-in.
// Run after pnpm build: node src/local/squire-reuse-proof.mjs
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
// Resolve dependencies through the repository's module resolver.
const { createRequire } = await import('node:module');
const require = createRequire(root + '/package.json');
const moduleUrl = name => pathToFileURL(require.resolve(name).replace('/dist/cjs/', '/dist/esm/')).href;
const dir = await mkdtemp('/tmp/grunt-reuse-mcp-');
try {
 const broker = join(dir, 'broker.mjs');
 await writeFile(broker, `
import { Server } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/server/stdio.js'))};
import { CallToolRequestSchema } from ${JSON.stringify(moduleUrl('@modelcontextprotocol/sdk/types.js'))};
const server = new Server({name:'reuse proof',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(CallToolRequestSchema, async ({params}) => {
 if(params.name !== 'list_credentials') throw new Error('Unexpected call');
 return {content:[{type:'text',text:JSON.stringify({credentials:[]})}]};
});
await server.connect(new StdioServerTransport());
`);
 const { StdioClientTransport } = await import(moduleUrl('@modelcontextprotocol/sdk/client/stdio.js'));
 const start = StdioClientTransport.prototype.start;
 StdioClientTransport.prototype.start = function() { this._serverParams.args = [broker]; return start.call(this); };
 const { connectSquire } = await import(pathToFileURL(root + '/dist/local/wizard.js').href);
 let installs = 0;
 process.env.MILO_SQUIRE_HOME = dir;
 process.env.MILO_SETUP_NO_HUMAN = '1';
 await connectSquire({run: async () => { installs++; throw new Error('Unexpected installer'); }});
 assert.equal(installs, 0);
 console.log('Reproduction SQUIRE-REUSE PASS: built setup connection, empty home, real MCP list_credentials exchange with stand-in broker; no installer or login.');
} finally {await rm(dir,{recursive:true,force:true});}
