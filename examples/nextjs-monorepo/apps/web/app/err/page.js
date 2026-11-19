export const dynamic = 'force-dynamic';
// Integracja zwraca 500
export default async function WebError() {
  const res = await fetch('http://127.0.0.1:4001/payments?ms=80&status=500', {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-123' },
    body: JSON.stringify({ amount: 10 }),
  });
  return <pre>payments status: {res.status}</pre>;
}
