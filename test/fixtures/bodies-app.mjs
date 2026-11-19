// Aplikacja testowa dla treści odpowiedzi: /fetch i /http (ta sama mała treść), /big?n=K (K odpowiedzi po 2 MB przez node:http),
// /gzip (node:http: gzip, br, deflate, gzip z charset; kolejno).
import http from 'node:http';
const SVC = `http://127.0.0.1:${process.env.SERVICES_PORT || 4711}`;
const httpGet = url => new Promise((ok, err) => http.get(url, r => { r.resume(); r.on('end', ok); }).on('error', err));
const pages = {
  '/fetch': async () => { await (await fetch(SVC + '/small')).text(); },
  '/http': () => httpGet(SVC + '/small'),
  '/gzip': async () => { for (const q of ['enc=gzip', 'enc=br', 'enc=deflate', 'enc=gzip&charset=1']) await httpGet(`${SVC}/packed?${q}`); },
  '/big': async n => { for (let i = 0; i < n; i++) await httpGet(`${SVC}/big?i=${i}&bytes=${2 * 1024 * 1024}`); },
};
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try { await pages[u.pathname]?.(+(u.searchParams.get('n') || 1)); res.end('ok'); }
  catch (e) { res.statusCode = 500; res.end(String(e.cause?.message ?? e.message)); }
}).listen(+process.env.PORT, '127.0.0.1');
