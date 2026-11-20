// Workarounds for Node bugs in network inspection, installed in the app process BEFORE Network.enable.
//
// nodejs/node#66551 (Node 24.16–24.22, 26.8 and others; fixed in PR #66552, unreleased at the time of writing):
// when a node:http response has setEncoding(), the inspector's internal listener gets text chunks,
// sends Network.dataReceived without dataLength and throws a TypeError — the stream is destroyed, and the app
// gets "aborted" or crashes. It happens only with an attached client that called Network.enable, i.e.
// exactly when this collector or DevTools attaches. Workaround: text chunk → Buffer.
// When Node already passes a Buffer (bug fixed), the workaround does nothing.
//
// installNodeFixes must be self-contained (no imports or closures): sent as text through Runtime.evaluate.

export function installNodeFixes() {
  const applied = [];
  const { Network } = process.getBuiltinModule('node:inspector');
  if (Network && typeof Network.dataReceived === 'function') {
    if (!Network.dataReceived.__outboundFix66551) {
      const orig = Network.dataReceived;
      const fixed = function (params) {
        if (params && typeof params.data === 'string') {
          // the stream encoding is not known here; utf8 is the most common setEncoding()
          const data = Buffer.from(params.data, 'utf8');
          params = { ...params, data, dataLength: params.dataLength ?? data.byteLength, encodedDataLength: params.encodedDataLength ?? data.byteLength };
        }
        return orig.call(this, params);
      };
      fixed.__outboundFix66551 = true;
      Network.dataReceived = fixed;
    }
    applied.push('nodejs/node#66551');
  }
  return applied;
}

/** A Runtime.evaluate expression that installs the workarounds; returns the list of applied ones (JSON). */
export const NODE_FIXES_EXPRESSION = `JSON.stringify((${installNodeFixes.toString()})())`;
