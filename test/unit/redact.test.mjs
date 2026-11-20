import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor } from '../../src/redact.mjs';

const key = Buffer.alloc(32, 7);

test('nagłówki: lista i wzorzec nazw; schemat, długość, skrót', () => {
  const r = createRedactor({ key });
  const out = r.headers({ Authorization: 'Bearer SECRET', cookie: 'a=b', 'Set-Cookie': 'sid=1', 'x-api-key': 'k', 'X-Session-Id': 's', 'x-auth-token': 't', 'content-type': 'application/json', 'keep-alive': 'timeout=5', 'x-request-id': 'req-1' });
  assert.match(out.Authorization, /^\[redacted: Bearer · 13 chars · #[0-9a-f]{6}\]$/);
  for (const h of ['cookie', 'Set-Cookie', 'x-api-key', 'X-Session-Id', 'x-auth-token']) assert.match(out[h], /^\[redacted: /, h);
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out['keep-alive'], 'timeout=5');
  assert.equal(out['x-request-id'], 'req-1');
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('ten sam sekret → ten sam skrót; inny klucz kolektora → inny skrót', () => {
  const a = createRedactor({ key }), b = createRedactor({ key: Buffer.alloc(32, 8) });
  assert.equal(a.describe('Bearer X'), a.describe('Bearer X'));
  assert.notEqual(a.describe('Bearer X'), a.describe('Bearer Y'));
  assert.notEqual(a.describe('Bearer X'), b.describe('Bearer X'));
});

test('dodatkowe nagłówki firmowe', () => {
  const r = createRedactor({ key, extraHeaders: ['X-Acme-Internal'] });
  assert.match(r.headers({ 'x-acme-internal': 'v' })['x-acme-internal'], /redacted/);
});

test('parametry URL', () => {
  const r = createRedactor({ key });
  const u = r.url('http://svc/a?token=abc&ms=150&api_key=k&sig=x');
  assert.ok(!u.includes('abc') && !u.includes('api_key=k'));
  assert.match(u, /ms=150/);
  assert.equal(r.url('http://svc/a?ms=150&status=500'), 'http://svc/a?ms=150&status=500', 'bez zmian, gdy nic do redakcji');
  assert.equal(r.url('nie-url?token=1'), 'nie-url?token=1');
});

test('wyłączona redakcja', () => {
  const r = createRedactor({ enabled: false, key });
  assert.deepEqual(r.headers({ authorization: 'Bearer S' }), { authorization: 'Bearer S' });
  assert.equal(r.url('http://s/?token=1'), 'http://s/?token=1');
});

test('URL: ścieżki, userinfo, fragment, nazwy krótkie i camelCase, webhooki (audyt B-05)', () => {
  const r = createRedactor();
  const out = u => r.url(u);
  const hidden = (u, secret) => { const v = out(u); assert.ok(!v.includes(secret), `${u} → ${v}`); return v; };
  hidden('https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ/sendMessage', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawZ');
  hidden('https://acc.blob.core.windows.net/c/f?sv=2022&sig=AbCdSeCrEt%3D&se=2026', 'AbCdSeCrEt');
  hidden('https://app/cb?code=4/0AbCdEfAuthCode&state=xyz', '0AbCdEfAuthCode');
  hidden('https://idp/token?client_assertion=eyJhbGciOiJSUzI1.eyJzdWIiOiIx.c2ln&jwt=eyJhbGciOiJIUz.eyJzdWIiOiIy.sig', 'eyJhbGciOiJSUzI1');
  hidden('https://x/login?user=a&pass=hunter2&pwd=hunter3', 'hunter');
  hidden('https://x/?privateKey=pk_abc&accessKeyId=AKIAABCDEFGHIJKLMNOP', 'pk_abc');
  hidden('https://admin:S3cretPass@db.internal/api', 'S3cretPass');
  hidden('https://x/y#access_token=abc123', 'abc123');
  hidden('https://hooks.slack.com/services/T000/B000/XXXXSECRET', 'XXXXSECRET');
  hidden('https://discord.com/api/webhooks/123456/AbCdEfSecret', 'AbCdEfSecret');
  assert.equal(out('https://x/a?country_code=PL&q=1'), 'https://x/a?country_code=PL&q=1', 'bez zmian, gdy nic do ukrycia');
  assert.equal(out('https://x/a%20b?q=1'), 'https://x/a%20b?q=1', 'ścieżka zakodowana bez zmian');
});

test('nagłówki: URL-e w Location i Link, wartości o znanym formacie (audyt B-05)', () => {
  const h = createRedactor().headers({ location: 'https://app/cb?access_token=LOC_SECRET', link: '<https://x/?token=LINK_SECRET>; rel=next',
    'x-forwarded-jwt': 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJl', 'x-gh': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'content-type': 'application/json' });
  const all = JSON.stringify(h);
  for (const s of ['LOC_SECRET', 'LINK_SECRET', 'eyJhbGciOiJIUzI1', 'ghp_abcdef']) assert.ok(!all.includes(s), s);
  assert.equal(h['content-type'], 'application/json');
});

test('treści: drzewo JSON, form-urlencoded, XML/tekst, przycięty JSON (audyt B-06)', () => {
  const r = createRedactor();
  const check = (text, type, secrets, count) => {
    const o = r.body(text, type);
    for (const s of secrets) assert.ok(!o.text.includes(s), `${s} w ${o.text}`);
    if (count != null) assert.equal(o.count, count, o.text);
    return o.text;
  };
  check('{"auth":{"value":"S3CR3T"},"credentials":{"u":"a","p":"S3CR3T2"},"tokens":["T1","T2"],"apiKeys":["k1"],"ok":1}', 'application/json', ['S3CR3T', 'T1', 'k1'], 4);
  assert.match(check('{"session":{"token":"a","refresh":"REFRESH_SECRET"}}', 'application/json', ['REFRESH_SECRET']), /"session":"\[redacted/);
  assert.match(check('{"pass\\u0077ord":"hunter2"}', 'application/json', ['hunter2']), /password/);
  check('access_token=gho_FORM_SECRET_456&scope=repo&token_type=bearer', 'application/x-www-form-urlencoded', ['gho_FORM_SECRET_456'], 1);
  check('access_token=gho_FORM_SECRET_456&scope=repo', 'text/plain', ['gho_FORM_SECRET_456']);
  check('<r><key>ghp_abcdefghijklmnopqrstuvwxyz0123456789</key></r>', 'text/xml', ['ghp_abcdef'], 1);
  check('{"data":"xxx","access_token":"AAAAAAAAAAAAA', 'application/json', ['AAAAAAAAAAAAA'], 1);
  assert.equal(r.body('{"name":"Jan","items":[1,2]}', 'application/json').text, '{"name":"Jan","items":[1,2]}', 'bez sekretów bez zmian');
  assert.equal(r.body('{\n  "a": 1,\n  "token": "x"\n}', 'application/json').text.includes('\n  "a": 1'), true, 'wcięcia zachowane');
});
