// Udawane "wewnętrzne serwisy": ?ms=opóźnienie, ?status=kod odpowiedzi
import http from 'node:http';
const port = +(process.env.PORT || 4001);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  setTimeout(() => {
    res.statusCode = +(u.searchParams.get('status') || 200);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ service: u.pathname }));
  }, +(u.searchParams.get('ms') || 20));
}).listen(port, '127.0.0.1', () => console.log('services on', port));
