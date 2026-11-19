// Udawane "wewnętrzne serwisy": ?ms=opóźnienie, ?status=kod odpowiedzi, ?bytes=rozmiar treści;
// POST /orders zwraca też nowy orderId (zależności danych, issue #6)
import http from 'node:http';
import { randomUUID } from 'node:crypto';
const port = +(process.env.PORT || 4711);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  setTimeout(() => {
    res.statusCode = +(u.searchParams.get('status') || 200);
    res.setHeader('content-type', 'application/json');
    const bytes = +(u.searchParams.get('bytes') || 0); // ?bytes=N → treść tekstowa o rozmiarze N
    const extra = req.method === 'POST' && u.pathname === '/orders' ? { orderId: `ord_${randomUUID()}` } : {};
    res.end(bytes ? JSON.stringify({ service: u.pathname, pad: 'x'.repeat(Math.max(0, bytes - 40)) }) : JSON.stringify({ service: u.pathname, ...extra }));
  }, +(u.searchParams.get('ms') || 20));
}).listen(port, '127.0.0.1', () => console.log('services on', port));
