// Test app for data dependencies (issue #6), requests through node:http. A separate file, so the lines of
// fake-app.mjs (they appear in golden) do not shift. The body is collected as a Buffer, without setEncoding() (nodejs/node#66551).
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
  // fully dependent: status needs orderId from the POST response — Promise.all impossible
  '/order': async () => {
    const { orderId } = await call('POST', '/orders?ms=40');
    await call('GET', `/orders/status?ms=40&orderId=${encodeURIComponent(orderId)}`);
  },
  // partly: status (URL) and items (header) depend on POST, but not on each other
  '/order-full': async () => {
    const { orderId } = await call('POST', '/orders?ms=40');
    await call('GET', `/orders/status?ms=40&orderId=${orderId}`);
    await call('GET', '/orders/items?ms=40', { 'x-order-id': orderId });
  },
  // independent: the second request uses nothing from the first response
  '/indep': async () => { await call('GET', '/user?ms=40'); await call('GET', '/offers?ms=40'); },
};
http.createServer(async (req, res) => {
  try { await pages[req.url]?.(); res.end('ok'); }
  catch (e) { res.statusCode = 500; res.end(String(e.cause?.message ?? e.message)); }
}).listen(+process.env.PORT, '127.0.0.1');
