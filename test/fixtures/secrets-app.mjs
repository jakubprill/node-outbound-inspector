// Test app sending headers with secrets (redaction test, M2). A separate file, so the lines
// in fake-app.mjs, which appear in golden snapshots as call sites, do not shift.
import http from 'node:http';
const SVC = `http://127.0.0.1:${process.env.SERVICES_PORT || 4711}`;
http.createServer(async (req, res) => {
  try {
    await fetch(SVC + '/secure?ms=10', { headers: { authorization: 'Bearer secret-token', cookie: 'session=abc' } });
    res.end('ok');
  } catch (e) { res.statusCode = 500; res.end(String(e.cause?.message ?? e.message)); }
}).listen(+process.env.PORT, '127.0.0.1');
