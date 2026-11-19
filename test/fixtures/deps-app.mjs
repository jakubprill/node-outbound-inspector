// Aplikacja testowa dla zależności danych (issue #6), zapytania przez node:http. Osobny plik, żeby nie przesuwać
// linii fake-app.mjs (występują w golden). Treść zbierana jako Buffer, bez setEncoding() (nodejs/node#66551).
import http from 'node:http';
const SVC = `http://127.0.0.1:${process.env.SERVICES_PORT || 4711}`;
const call = (method, path, headers = {}) => new Promise((ok, err) => {
  const req = http.request(SVC + path, { method, headers }, r => {
    const chunks = []; r.on('data', d => chunks.push(d)); r.on('end', () => ok(JSON.parse(Buffer.concat(chunks).toString())));
  });
  req.on('error', err);
  req.end(method === 'POST' ? '{"item":"book"}' : undefined);
});
const pages = {
  // w pełni zależne: status wymaga orderId z odpowiedzi POST — Promise.all niemożliwe
  '/order': async () => {
    const { orderId } = await call('POST', '/orders?ms=40');
    await call('GET', `/orders/status?ms=40&orderId=${encodeURIComponent(orderId)}`);
  },
  // częściowo: status (URL) i items (nagłówek) zależą od POST, ale nie od siebie nawzajem
  '/order-full': async () => {
    const { orderId } = await call('POST', '/orders?ms=40');
    await call('GET', `/orders/status?ms=40&orderId=${orderId}`);
    await call('GET', '/orders/items?ms=40', { 'x-order-id': orderId });
  },
  // niezależne: drugie zapytanie nie używa niczego z odpowiedzi pierwszego
  '/indep': async () => { await call('GET', '/user?ms=40'); await call('GET', '/offers?ms=40'); },
};
http.createServer(async (req, res) => {
  try { await pages[req.url]?.(); res.end('ok'); }
  catch (e) { res.statusCode = 500; res.end(String(e.cause?.message ?? e.message)); }
}).listen(+process.env.PORT, '127.0.0.1');
