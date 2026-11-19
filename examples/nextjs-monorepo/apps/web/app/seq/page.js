export const dynamic = 'force-dynamic';
// Trzy niezależne wywołania wykonywane jedno po drugim (waterfall)
export default async function WebSequential() {
  const opts = { cache: 'no-store' };
  const user = await fetch('http://127.0.0.1:4001/user?ms=150', opts).then(r => r.json());
  const orders = await fetch('http://127.0.0.1:4001/orders?ms=150', opts).then(r => r.json());
  const offers = await fetch('http://127.0.0.1:4001/offers?ms=150', opts).then(r => r.json());
  return <pre>{JSON.stringify({ user, orders, offers }, null, 2)}</pre>;
}
