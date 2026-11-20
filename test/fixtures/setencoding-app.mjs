// Test app: a node:http response read after res.setEncoding('utf8') (nodejs/node#66551).
import http from 'node:http';
const SVC = `http://127.0.0.1:${process.env.SERVICES_PORT || 4711}`;
http.createServer((req, res) => {
  http.get(SVC + '/small', r => {
    r.setEncoding('utf8'); let body = '';
    r.on('data', c => { body += c; });
    r.on('end', () => res.end(body));
  }).on('error', e => { res.statusCode = 502; res.end(`error: ${e.message}`); });
}).listen(+process.env.PORT, '127.0.0.1');
