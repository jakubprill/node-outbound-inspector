import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ignoreReason, isOtlpExport, OTLP_RULES } from '../../src/ignore.mjs';

const rules = { ignoreHosts: ['registry.npmjs.org'], inspectorPorts: [9231], ignoreOtlp: true };

test('eksport OTLP/HTTP na porcie 4318 pomijany niezależnie od hosta (issue #4)', () => {
  for (const url of ['http://localhost:4318/v1/traces', 'http://127.0.0.1:4318/v1/metrics', 'http://[::1]:4318/v1/logs',
    'http://otel-collector:4318/v1/traces', 'https://localhost:4318/v1/traces/']) {
    assert.equal(ignoreReason(url, rules), 'otlp', url);
  }
});

test('eksport OTLP/gRPC rozpoznawany po ścieżce usługi na dowolnym porcie', () => {
  assert.equal(ignoreReason('http://localhost:4317/opentelemetry.proto.collector.trace.v1.TraceService/Export', rules), 'otlp');
  assert.equal(ignoreReason('http://collector:9000/opentelemetry.proto.collector.logs.v1.LogsService/Export', rules), 'otlp');
});

test('ruch podobny do OTLP, ale nie OTLP, zostaje (ryzyko ukrycia prawdziwego ruchu)', () => {
  for (const url of [
    'http://127.0.0.1:4001/v1/logs',            // własny backend z API /v1/logs
    'https://api.example.com/v1/traces',        // ta sama ścieżka, inny port (443)
    'http://localhost:4318/v1/traces/123',      // inna ścieżka na porcie 4318
    'http://localhost:4318/api/v1/traces',
    'http://localhost:43180/v1/traces',
    'http://localhost:4318/v1/trace',
  ]) assert.equal(ignoreReason(url, rules), null, url);
});

test('OUTBOUND_IGNORE_OTLP=0: eksport OTLP trafia do magazynu', () => {
  assert.equal(ignoreReason('http://localhost:4318/v1/traces', { ...rules, ignoreOtlp: false }), null);
  assert.equal(ignoreReason('http://localhost:4318/v1/traces', {}), null, 'domyślnie w rdzeniu wyłączone — decyduje config');
});

test('dotychczasowe reguły: hosty (podłańcuch) i ruch do inspektorów; zły URL nie jest pomijany', () => {
  assert.equal(ignoreReason('https://registry.npmjs.org/next', rules), 'hosts');
  assert.equal(ignoreReason('http://localhost:9231/json/list', rules), 'inspector');
  assert.equal(ignoreReason('http://127.0.0.1:9231/json/version', rules), 'inspector');
  assert.equal(ignoreReason('nie-url', rules), null);
});

test('OTLP_RULES opisuje reguły dla inspector_status', () => {
  assert.ok(Object.isFrozen(OTLP_RULES));
  assert.ok(OTLP_RULES.includes('*:4318/v1/traces'));
  assert.equal(isOtlpExport(new URL('http://x:4318/v1/metrics')), true);
});
