import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processWarnings } from '../../src/session.mjs';

test('network flag from execArgv: Network.enable without the flag is not enough (defect 2)', () => {
  const noFlag = processWarnings({ execArgv: ['--inspect=127.0.0.1:9231'], node: 'v24.1.0', networkEnabled: true });
  assert.equal(noFlag.networkInspection, false);
  assert.match(noFlag.warnings[0], /without --experimental-network-inspection/);
  const ok = processWarnings({ execArgv: ['--experimental-network-inspection'], node: 'v24.1.0', networkEnabled: true });
  assert.deepEqual(ok, { networkInspection: true, warnings: [] });
  const node22 = processWarnings({ execArgv: ['--experimental-network-inspection'], node: 'v22.23.5', networkEnabled: true });
  assert.equal(node22.networkInspection, false, 'Node < 24 is not inspected');
  assert.match(node22.warnings[0], /Node 22\.23\.5, but Node ≥ 24 is required/);
});

test('consent: through OUTBOUND_INSPECT or the network flag, the same user (audit B-01)', async () => {
  const { consent } = await import('../../src/session.mjs');
  assert.deepEqual(consent({ optIn: true, execArgv: [] }, 501), { allowed: true });
  assert.deepEqual(consent({ optIn: false, execArgv: ['--experimental-network-inspection'] }, 501), { allowed: true });
  assert.equal(consent({ optIn: false, execArgv: ['--inspect=9229'] }, 501).reason, 'no_consent');
  assert.equal(consent({ uid: 0, optIn: true, execArgv: [] }, 501).reason, 'other_user', 'another user despite consent');
  assert.deepEqual(consent({ uid: null, optIn: true }, 501), { allowed: true }, 'a system without uids (Windows)');
  assert.deepEqual(consent({ uid: 501, optIn: true }, null), { allowed: true });
});
