// Udawane "wewnętrzne serwisy": ?ms=opóźnienie, ?status=kod odpowiedzi, ?bytes=rozmiar treści,
// ?enc=gzip|br|deflate (content-encoding), ?charset=1 (content-type z charset=utf-8);
// POST /orders zwraca też nowy orderId (zależności danych, issue #6)
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
    const bytes = +(u.searchParams.get('bytes') || 0); // ?bytes=N → treść tekstowa o rozmiarze N
    const extra = req.method === 'POST' && u.pathname === '/orders' ? { orderId: `ord_${randomUUID()}` } : {};
    const body = bytes ? JSON.stringify({ service: u.pathname, pad: 'x'.repeat(Math.max(0, bytes - 40)) }) : JSON.stringify({ service: u.pathname, ...extra });
    const enc = u.searchParams.get('enc');
    if (!ENCODERS[enc]) return res.end(body);
    res.setHeader('content-encoding', enc);
    res.end(ENCODERS[enc](Buffer.from(body)));
  }, +(u.searchParams.get('ms') || 20));
}).listen(port, '127.0.0.1', () => console.log('services on', port));
