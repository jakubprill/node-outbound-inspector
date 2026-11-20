// Wspólny scenariusz testowy: serwisy + dwie aplikacje (fake-app) uruchomione równolegle,
// każda z własnym portem inspektora. Porty są parametrem, żeby pliki testów mogły działać równolegle.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const fx = p => fileURLToPath(new URL(`../fixtures/${p}`, import.meta.url));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * n różnych wolnych portów od systemu (wszystkie gniazda otwarte naraz, potem zamknięte).
 * Pliki testów działają równolegle — stałe numery portów kolidowały (np. 4851/9751 w trzech plikach).
 */
export async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((ok, err) => {
    const srv = net.createServer().once('error', err).listen(0, '127.0.0.1', () => ok(srv));
  })));
  const ports = servers.map(s => s.address().port);
  await Promise.all(servers.map(s => new Promise(r => s.close(r))));
  return ports;
}

export async function startScenario({ servicesPort, apps, inspectorFlags = ['--experimental-network-inspection'] }) {
  // brakujące porty (servicesPort, apps[].port, apps[].inspect) przydziela system; wpisujemy je do przekazanych obiektów
  const missing = [servicesPort == null, ...apps.flatMap(a => [a.port == null, a.inspect == null])].filter(Boolean).length;
  const pool = missing ? await freePorts(missing) : [];
  if (servicesPort == null) servicesPort = pool.shift();
  for (const a of apps) { if (a.port == null) a.port = pool.shift(); if (a.inspect == null) a.inspect = pool.shift(); }
  const procs = [];
  procs.push(spawn(process.execPath, [fx('services.mjs')], { env: { ...process.env, PORT: servicesPort }, stdio: 'ignore' }));
  const started = apps.map(a => {
    const p = spawn(process.execPath, [...(a.flags ?? inspectorFlags), `--inspect=127.0.0.1:${a.inspect}`, fx(a.script ?? 'fake-app.mjs')],
      { cwd: fx(`apps/${a.dir}`), env: { ...process.env, PORT: a.port, SERVICES_PORT: servicesPort, npm_package_name: '', ...(a.env ?? {}) }, stdio: 'ignore' });
    procs.push(p);
    return { ...a, proc: p };
  });
  await sleep(800);
  return {
    servicesPort,
    apps: started,
    hit: (app, path, init) => fetch(`http://127.0.0.1:${app.port}${path}`, init).then(r => r.text()),
    stop: () => procs.forEach(p => p.kill()),
    procs,
  };
}
