// Mock "internal services": ?ms=delay, ?status=response code, ?bytes=body size,
// ?enc=gzip|br|deflate (content-encoding), ?charset=1 (content-type with charset=utf-8);
// POST /orders also returns a new orderId (data dependencies, issue #6); /secure returns an access_token
import http from 'node:http';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
const ENCODERS = { gzip: zlib.gzipSync, br: zlib.brotliCompressSync, deflate: zlib.deflateSync };
const port = +(process.env.PORT || 4711);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  setTimeout(() => {
    res.statusCode = +(u.searchParams.get('status') || 200);
    res.setHeader('content-type', u.searchParams.has('charset') ? 'application/json; charset=utf-8' : 'application/json');
    const bytes = +(u.searchParams.get('bytes') || 0); // ?bytes=N → a text body of size N
    const extra = req.method === 'POST' && u.pathname === '/orders' ? { orderId: `ord_${randomUUID()}` }
      : u.pathname === '/secure' ? { access_token: 'body-secret-tok', expires_in: 60 } : {}; // /secure: a secret in the body (redaction, M6)
    const body = bytes ? JSON.stringify({ service: u.pathname, pad: 'x'.repeat(Math.max(0, bytes - 40)) }) : JSON.stringify({ service: u.pathname, ...extra });
    const enc = u.searchParams.get('enc');
    if (!ENCODERS[enc]) return res.end(body);
    res.setHeader('content-encoding', enc);
    res.end(ENCODERS[enc](Buffer.from(body)));
  }, +(u.searchParams.get('ms') || 20));
}).listen(port, '127.0.0.1', () => console.log('services on', port));
