// Aplikacja testowa dla błędów połączeń (issue #3) i eksportu OpenTelemetry (issue #4).
// Jak na typowej maszynie localhost ma dwa adresy (::1 i 127.0.0.1): odrzucone połączenie kończy się
// wtedy AggregateError bez opisu, a inspektor Node podaje pusty errorText.
import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
const lookup = dns.lookup;
dns.lookup = (host, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (host !== 'localhost') return lookup(host, opts, cb);
  const all = [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
  return opts?.all ? cb(null, all) : cb(null, all[0].address, all[0].family);
};
const SVC = `http://127.0.0.1:${process.env.SERVICES_PORT || 4711}`;
// port, na którym nic nie nasłuchuje: wolny port od systemu tuż przed zapytaniem (stałe PORT+7 kolidowało
// z portami innych plików testów działających równolegle, np. na Windows w CI)
const refusedPort = () => new Promise(ok => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const swallow = p => p.then(r => r.text?.(), () => null);
const httpPost = url => new Promise(ok => http.request(url, { method: 'POST' }, r => { r.resume(); r.on('end', ok); }).on('error', ok).end('{}'));
const pages = {
  // @vercel/otel bez lokalnego kolektora: eksport na :4318 kończy się błędem; obok zwykłe zapytanie
  '/otel': async () => {
    await Promise.all([swallow(fetch('http://localhost:4318/v1/traces', { method: 'POST', body: '{}' })), httpPost('http://127.0.0.1:4318/v1/metrics')]);
    await swallow(fetch(SVC + '/user?ms=10'));
  },
  '/refused': async () => swallow(fetch(`http://localhost:${await refusedPort()}/api`)),
  '/timeout': () => swallow(fetch(SVC + '/slow?ms=2000', { signal: AbortSignal.timeout(100) })),
};
http.createServer(async (req, res) => { await pages[req.url]?.(); res.end('ok'); }).listen(+process.env.PORT, '127.0.0.1');
