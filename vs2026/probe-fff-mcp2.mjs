// Probe #2: check indexing behavior over time.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const exe = 'O:/repos/knilecrack/Seeky/User/fff-mcp.exe';
const cwd = 'O:/repos/knilecrack/Seeky';
const proc = spawn(exe, [], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

let stderrBuf = '';
proc.stderr.on('data', (d) => { stderrBuf += d; });

const pending = new Map();
let nextId = 1;
readline.createInterface({ input: proc.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});

function send(method, params = {}) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error('timeout ' + method)), 20000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

for (let i = 0; i < 5; i++) {
  const res = await send('tools/call', { name: 'find_files', arguments: { query: 'SeekyModal', maxResults: 5 } });
  console.log(`try ${i}:`, JSON.stringify(res.result ?? res.error).slice(0, 1500));
  await sleep(1500);
}
const g = await send('tools/call', { name: 'grep', arguments: { query: 'ShowCore', maxResults: 5 } });
console.log('grep:', JSON.stringify(g.result ?? g.error).slice(0, 2000));

console.log('\n=== STDERR ===');
console.log(stderrBuf.slice(0, 3000));
proc.kill();
process.exit(0);
