// Probe fff-mcp.exe: MCP stdio handshake + tools/list + sample search calls.
// Usage: node probe-fff-mcp.mjs [workspaceDir]
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const exe = new URL('../User/fff-mcp.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cwd = process.argv[2] ?? 'O:/repos/knilecrack/Seeky';
const proc = spawn(exe, [], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });

const pending = new Map();
let nextId = 1;
const rl = readline.createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { console.error('NON-JSON:', line); return; }
  console.error('<<', JSON.stringify(msg).slice(0, 4000));
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  console.error('>>', JSON.stringify(msg));
  proc.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
  });
}

const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'probe', version: '0.0.1' },
});
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await send('tools/list');
console.log('\n=== TOOLS ===');
console.log(JSON.stringify(tools, null, 2));

// Try a file search and a grep with the first plausible tool names.
for (const tool of tools.result?.tools ?? []) {
  if (!/search|find|grep|file/i.test(tool.name)) continue;
  const args = {};
  const props = tool.inputSchema?.properties ?? {};
  for (const [k, v] of Object.entries(props)) {
    if (v.type === 'string') args[k] = /query|pattern|search/i.test(k) ? 'ShowCore' : (/path|dir|root|cwd/i.test(k) ? cwd : 'x');
    else if (v.type === 'number' || v.type === 'integer') args[k] = 10;
    else if (v.type === 'boolean') args[k] = true;
  }
  console.log(`\n=== SAMPLE CALL ${tool.name} ===`);
  console.log('args:', JSON.stringify(args));
  try {
    const res = await send('tools/call', { name: tool.name, arguments: args });
    console.log(JSON.stringify(res, null, 2).slice(0, 6000));
  } catch (e) {
    console.log('call failed:', e.message);
  }
}

proc.kill();
process.exit(0);
