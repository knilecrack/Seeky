// Probe #3: does fff-mcp grep treat query as regex or literal? Any fuzzy behavior?
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const exe = 'O:/repos/knilecrack/Seeky/User/fff-mcp.exe';
const cwd = 'O:/repos/knilecrack/Seeky';
const proc = spawn(exe, [], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });

const pending = new Map();
let nextId = 1;
readline.createInterface({ input: proc.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
function call(name, args) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return new Promise((resolve, reject) => { pending.set(id, resolve); setTimeout(() => reject(new Error('timeout')), 20000); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }) + '\n');
await sleep(2500); // let it index
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tests = [
  ['literal-specials', 'SeekyModalWindowManager.cs'],
  ['regex-alternation', 'ShowCore|RegisterWindowClass'],
  ['regex-charclass', 'ShowCore[A-Z]'],
  ['fuzzy-ish', 'ShwCr'],
  ['plain-dot-escaped', 'index\\.html'],
];
for (const [label, q] of tests) {
  const res = await call('grep', { query: q, maxResults: 3 });
  const text = (res.result?.content ?? []).map(c => c.text).join(' | ').slice(0, 300);
  console.log(`${label} [${q}]: ${text}\n`);
}
const mg = await call('multi_grep', { patterns: ['ShowCore|Register'], maxResults: 3 });
console.log('multi_grep literal-with-pipe:', JSON.stringify(mg.result?.content ?? mg.error).slice(0, 300));

proc.kill();
process.exit(0);
