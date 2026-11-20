// Udaje CLI Next.js dla testów `outbound-next`: jak `next dev --inspect=<port>` otwiera inspektor
// (Next robi to we właściwym procesie; tu — w tym samym), wypisuje jedną linię JSON o sobie
// i czeka na stdin. Linia "exit <kod>" albo koniec stdin kończy proces tym kodem (domyślnie 0).
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
