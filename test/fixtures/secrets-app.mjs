// Aplikacja testowa wysyłająca nagłówki z sekretami (test redakcji, M2). Osobny plik, żeby nie
// przesuwać linii w fake-app.mjs, które występują w zrzutach golden jako miejsca wywołania.
import http from 'node:http';
const SVC = `http://127.0.0.1:${process.env.SERVICES_PORT || 4711}`;
http.createServer(async (req, res) => {
  try {
    await fetch(SVC + '/secure?ms=10', { headers: { authorization: 'Bearer secret-token', cookie: 'session=abc' } });
    res.end('ok');
  } catch (e) { res.statusCode = 500; res.end(String(e.cause?.message ?? e.message)); }
}).listen(+process.env.PORT, '127.0.0.1');
