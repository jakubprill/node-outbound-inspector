import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ignoreReason, isOtlpExport, OTLP_RULES } from '../../src/ignore.mjs';

const rules = { ignoreHosts: ['registry.npmjs.org'], inspectorPorts: [9231], ignoreOtlp: true };

test('OTLP/HTTP export on port 4318 skipped regardless of host (issue #4)', () => {
  for (const url of ['http://localhost:4318/v1/traces', 'http://127.0.0.1:4318/v1/metrics', 'http://[::1]:4318/v1/logs',
    'http://otel-collector:4318/v1/traces', 'https://localhost:4318/v1/traces/']) {
    assert.equal(ignoreReason(url, rules), 'otlp', url);
  }
});

test('OTLP/gRPC export recognized by the service path on any port', () => {
  assert.equal(ignoreReason('http://localhost:4317/opentelemetry.proto.collector.trace.v1.TraceService/Export', rules), 'otlp');
  assert.equal(ignoreReason('http://collector:9000/opentelemetry.proto.collector.logs.v1.LogsService/Export', rules), 'otlp');
});

test('traffic similar to OTLP but not OTLP stays (risk of hiding real traffic)', () => {
  for (const url of [
    'http://127.0.0.1:4001/v1/logs',            // your own backend with a /v1/logs API
    'https://api.example.com/v1/traces',        // the same path, another port (443)
    'http://localhost:4318/v1/traces/123',      // another path on port 4318
    'http://localhost:4318/api/v1/traces',
    'http://localhost:43180/v1/traces',
    'http://localhost:4318/v1/trace',
  ]) assert.equal(ignoreReason(url, rules), null, url);
});

test('OUTBOUND_IGNORE_OTLP=0: OTLP export reaches the store', () => {
  assert.equal(ignoreReason('http://localhost:4318/v1/traces', { ...rules, ignoreOtlp: false }), null);
  assert.equal(ignoreReason('http://localhost:4318/v1/traces', {}), null, 'off by default in the core — config decides');
});

test('existing rules: hosts (substring) and traffic to inspectors; a bad URL is not skipped', () => {
  assert.equal(ignoreReason('https://registry.npmjs.org/next', rules), 'hosts');
  assert.equal(ignoreReason('http://localhost:9231/json/list', rules), 'inspector');
  assert.equal(ignoreReason('http://127.0.0.1:9231/json/version', rules), 'inspector');
  assert.equal(ignoreReason('not-a-url', rules), null);
});

test('OTLP_RULES describes the rules for inspector_status', () => {
  assert.ok(Object.isFrozen(OTLP_RULES));
  assert.ok(OTLP_RULES.includes('*:4318/v1/traces'));
  assert.equal(isOtlpExport(new URL('http://x:4318/v1/metrics')), true);
});
