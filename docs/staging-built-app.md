# Zbudowana aplikacja i staging — analiza (2026-11-20)

Pytanie z zespołu: czy node-outbound-inspector da się uruchomić na zbudowanej aplikacji Next.js
na środowisku stagingowym, żeby deweloperzy backendu widzieli ruch wychodzący serwera Next
(zapytania do ich serwisów)? Czy „kontrolny” build z flagą i podpięcie inspektora ma sens?

## Krótka odpowiedź

Technicznie tak, ale na **wspólnym** stagingu to zła droga. Nadaje się do doraźnego debugowania
**wydzielonej** instancji przez jedną osobę. Do stałego podglądu ruchu na stagingu właściwym
narzędziem jest **OpenTelemetry**.

## Jak to zrobić technicznie

Next.js 16.2 dodał `--inspect` dla `next start`, więc inspektor da się otworzyć na serwerze produkcyjnym.

```bash
# nasze narzędzie (flaga sieciowa + zgoda OUTBOUND_INSPECT=1)
outbound-next start --port 3000 --inspect=9230

# build standalone
OUTBOUND_INSPECT=1 node --experimental-network-inspection --inspect=127.0.0.1:9230 .next/standalone/server.js
```

Dostęp z maszyny dewelopera wyłącznie tunelem, inspektor nasłuchuje tylko na 127.0.0.1:

```bash
ssh -L 9230:127.0.0.1:9230 staging-host      # albo: kubectl port-forward pod/<pod> 9230:9230
outbound-hub                                 # lokalnie: chrome://inspect lub MCP (INSPECTOR_PORTS=9230)
```

Status: niezweryfikowane jeszcze na zbudowanej aplikacji (test `next build` + `outbound-next start` do zrobienia).

## Dlaczego nie na wspólnym stagingu

| Problem | Skutek |
|---|---|
| Otwarty port inspektora = zdalne wykonanie kodu | Kto dosięgnie portu, ma pełną kontrolę nad procesem. Dokumentacja Next podsuwa `--inspect=0.0.0.0` dla Dockera — na serwerze w sieci to otwarte drzwi. `outbound-next` blokuje hosty spoza loopbacku (bez `OUTBOUND_ALLOW_REMOTE_INSPECT=1`). |
| Ruch wszystkich użytkowników stagingu | Widać tokeny i dane wszystkich testerów; przez MCP trafiają do dostawcy modelu. Redakcja działa w trybie najlepszych starań. |
| Błąd Node nodejs/node#66551 | Samo Chrome DevTools (bez naszego kolektora) może zrywać zapytania używające `setEncoding` — dotknie wszystkich korzystających ze stagingu. Nasz kolektor łata to tylko, gdy jest podłączony. |
| Flaga `--experimental-network-inspection` jest eksperymentalna | Buforuje treści odpowiedzi w pamięci procesu. |
| Kilka instancji za load balancerem | Widać tylko jedną instancję. |
| Zminifikowany kod | Stosy wywołań („miejsce w kodzie”) mało czytelne bez source map. |

## Rekomendacja

1. **Staging dla backendu → OpenTelemetry.** `instrumentation.ts` + `@vercel/otel`; każde zapytanie
   serwera Next to span (Jaeger / Tempo / Grafana). Nagłówek `traceparent` łączy go ze spanami
   serwisów backendu, więc widać cały łańcuch: strona → Next → serwis. Obejmuje wszystkie instancje,
   dane zostają w firmie, nie ma portu z wykonaniem kodu, działa stale.
2. **node-outbound-inspector → lokalny development.**
3. **Kompromis do doraźnego debugowania:** wydzielona instancja stagingu, uruchamiana z flagą na żądanie,
   inspektor tylko na 127.0.0.1, dostęp tunelem dla jednej osoby, potem wyłączenie.

## Do zrobienia (gdy wrócimy do tematu)

- Test `outbound-next start --inspect=9230` na zbudowanej aplikacji (Next 16.4, monorepo testowe).
- Sekcja „Staging / built app” w README (en/pl) i notka w llms.txt.
- Ewentualnie szkic konfiguracji OpenTelemetry dla aplikacji zespołu.
