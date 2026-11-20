// Rules for skipping requests at ingestion (pure): hosts from IGNORE_HOSTS, traffic to inspectors
// and OpenTelemetry (OTLP) export. Skipped requests do not reach the store.
//
// OTLP is recognized by its signature, not by the path alone: `/v1/traces|metrics|logs` only on
// the default OTLP/HTTP port 4318 (any host: localhost, 127.0.0.1, a collector container),
// and the OTLP/gRPC service path on any port (it is unambiguous). A bare `/v1/logs` path
// without the port could hide real traffic, e.g. your own backend with such an API.

const OTLP_HTTP_PORT = '4318';
const OTLP_HTTP_PATH = /^\/v1\/(traces|metrics|logs)\/?$/;
const OTLP_GRPC_PATH = /^\/opentelemetry\.proto\.collector\.(trace|metrics|logs)\.v1\.(Trace|Metrics|Logs)Service\/Export$/;

/** Description of the OTLP rules for inspector_status (in the same form as the patterns: host:port/path). */
export const OTLP_RULES = Object.freeze([
  '*:4318/v1/traces', '*:4318/v1/metrics', '*:4318/v1/logs',
  '*/opentelemetry.proto.collector.{trace,metrics,logs}.v1.*Service/Export',
]);

/** @param {URL} u */
export function isOtlpExport(u) {
  return (u.port === OTLP_HTTP_PORT && OTLP_HTTP_PATH.test(u.pathname)) || OTLP_GRPC_PATH.test(u.pathname);
}

/**
 * Reason for skipping a request, or null when the request goes to the store.
 * @param {string} url
 * @param {{ ignoreHosts?: readonly string[], inspectorPorts?: readonly number[], ignoreOtlp?: boolean }} rules
 * @returns {'hosts' | 'inspector' | 'otlp' | null}
 */
export function ignoreReason(url, { ignoreHosts = [], inspectorPorts = [], ignoreOtlp = false }) {
  let u = null;
  try { u = new URL(url); } catch {}
  const host = u?.host ?? '';
  if (ignoreHosts.some(h => host.includes(h))) return 'hosts';
  if (inspectorPorts.some(port => host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return 'inspector';
  if (ignoreOtlp && u && isOtlpExport(u)) return 'otlp';
  return null;
}
