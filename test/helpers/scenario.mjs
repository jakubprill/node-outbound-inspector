// Wspólny scenariusz testowy: serwisy + dwie aplikacje (fake-app) uruchomione równolegle,
// każda z własnym portem inspektora. Porty są parametrem, żeby pliki testów mogły działać równolegle.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const fx = p => fileURLToPath(new URL(`../fixtures/${p}`, import.meta.url));
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function startScenario({ servicesPort, apps, inspectorFlags = ['--experimental-network-inspection'] }) {
  const procs = [];
  procs.push(spawn(process.execPath, [fx('services.mjs')], { env: { ...process.env, PORT: servicesPort }, stdio: 'ignore' }));
  const started = apps.map(a => {
    const p = spawn(process.execPath, [...(a.flags ?? inspectorFlags), `--inspect=127.0.0.1:${a.inspect}`, fx('fake-app.mjs')],
      { cwd: fx(`apps/${a.dir}`), env: { ...process.env, PORT: a.port, SERVICES_PORT: servicesPort, npm_package_name: '' }, stdio: 'ignore' });
    procs.push(p);
    return { ...a, proc: p };
  });
  await sleep(800);
  return {
    apps: started,
    hit: (app, path, init) => fetch(`http://127.0.0.1:${app.port}${path}`, init).then(r => r.text()),
    stop: () => procs.forEach(p => p.kill()),
    procs,
  };
}
