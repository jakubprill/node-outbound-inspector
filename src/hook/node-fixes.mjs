// Obejścia błędów Node w inspekcji sieci, instalowane w procesie aplikacji PRZED Network.enable.
//
// nodejs/node#66551 (Node 24.16–24.22, 26.8 i inne; poprawka w PR #66552, niewydana w chwili pisania):
// gdy odpowiedź node:http ma setEncoding(), wewnętrzny nasłuchiwacz inspektora dostaje fragmenty tekstowe,
// wysyła Network.dataReceived bez dataLength i rzuca TypeError — strumień zostaje zniszczony, a aplikacja
// dostaje "aborted" albo pada. Dzieje się to tylko przy podłączonym kliencie z Network.enable, czyli
// właśnie wtedy, gdy podłącza się ten kolektor albo DevTools. Obejście: fragment tekstowy → Buffer.
// Gdy Node przekazuje już Buffer (błąd naprawiony), obejście nic nie robi.
//
// installNodeFixes musi być samowystarczalna (bez importów i domknięć): wysyłana jako tekst przez Runtime.evaluate.

export function installNodeFixes() {
  const applied = [];
  const { Network } = process.getBuiltinModule('node:inspector');
  if (Network && typeof Network.dataReceived === 'function') {
    if (!Network.dataReceived.__outboundFix66551) {
      const orig = Network.dataReceived;
      const fixed = function (params) {
        if (params && typeof params.data === 'string') {
          // kodowanie strumienia nie jest znane w tym miejscu; utf8 to najczęstsze setEncoding()
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

/** Wyrażenie dla Runtime.evaluate instalujące obejścia; zwraca listę zastosowanych (JSON). */
export const NODE_FIXES_EXPRESSION = `JSON.stringify((${installNodeFixes.toString()})())`;
