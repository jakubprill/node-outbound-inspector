export const dynamic = 'force-dynamic';
// Te same typy wywołań, ale równolegle
export default async function AdminParallel() {
  const opts = { cache: 'no-store' };
  const [user, reports, audit] = await Promise.all([
    fetch('http://127.0.0.1:4001/user?ms=150', opts).then(r => r.json()),
    fetch('http://127.0.0.1:4001/reports?ms=150', opts).then(r => r.json()),
    fetch('http://127.0.0.1:4001/audit?ms=150', opts).then(r => r.json()),
  ]);
  return <pre>{JSON.stringify({ user, reports, audit }, null, 2)}</pre>;
}
