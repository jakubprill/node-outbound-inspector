// Pretends to be the Next.js CLI for `outbound-next` tests: like `next dev --inspect=<port>`, it opens the inspector
// (Next does it in the right process; here — in the same one), prints one JSON line about itself
// and waits on stdin. An "exit <code>" line or the end of stdin ends the process with that code (0 by default).
import inspector from 'node:inspector';

const arg = process.argv.slice(2).find(a => a.startsWith('--inspect='));
if (arg) {
  const v = arg.slice('--inspect='.length);
  const i = v.lastIndexOf(':');
  inspector.open(Number(i >= 0 ? v.slice(i + 1) : v), i >= 0 ? v.slice(0, i) : '127.0.0.1');
}
console.log(JSON.stringify({ pid: process.pid, execArgv: process.execArgv, argv: process.argv.slice(2), inspectorUrl: inspector.url() ?? null, optIn: process.env.OUTBOUND_INSPECT ?? null }));
let code = 0, buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  const m = /exit (\d+)/.exec(buf);
  if (m) { code = Number(m[1]); process.stdin.destroy(); inspector.close(); process.exit(code); }
});
process.stdin.on('end', () => { inspector.close(); process.exit(code); });
