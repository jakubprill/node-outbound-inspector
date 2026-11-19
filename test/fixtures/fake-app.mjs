// Udaje serwer aplikacji (np. Next.js): każda ścieżka to "strona" wołająca wewnętrzne serwisy.
// Wspólny kod dla wszystkich aplikacji — jak wspólny `next` w node_modules monorepo.
import http from 'node:http';
const SVC = `http://127.0.0.1:${process.env.SERVICES_PORT || 4711}`;
const get = p => fetch(SVC + p).then(r => r.json());
const pages = {
  '/seq': async () => { await get('/user?ms=150'); await get('/orders?ms=150'); await get('/offers?ms=150'); },
  '/par': async () => { await Promise.all([get('/user?ms=150'), get('/reports?ms=150'), get('/audit?ms=150')]); },
  '/err': async () => { await fetch(SVC + '/payments?ms=60&status=500', { method: 'POST', headers: { 'x-request-id': 'req-123' }, body: '{}' }); },
  '/http': () => new Promise(ok => http.get(SVC + '/legacy?ms=30', r => { r.resume(); r.on('end', ok); })),
};
http.createServer(async (req, res) => { await pages[req.url]?.(); res.end('ok'); })
  .listen(+process.env.PORT, '127.0.0.1', () => console.log('app on', process.env.PORT));
