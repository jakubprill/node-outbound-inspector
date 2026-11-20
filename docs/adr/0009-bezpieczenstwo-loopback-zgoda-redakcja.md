---
status: accepted
date: 2026-11-19
---

# 0009. Bezpieczeństwo: tylko pętla zwrotna, instrumentacja za zgodą, redakcja przy przyjęciu danych

## Kontekst

Inspektor Node daje pełną kontrolę nad procesem. Prototyp łączy się z każdym inspektorem w zakresie portów, wstrzykuje do niego kod bez pytania i zwraca agentowi nagłówki żądań oraz odpowiedzi bez zmian, w tym `Authorization`, `Cookie` i `Set-Cookie`. Wynik narzędzia trafia do dostawcy modelu, czyli poza maszynę dewelopera. Treści odpowiedzi serwisów mogą też zawierać tekst, który model weźmie za polecenie.

## Decyzja

1. **Tylko pętla zwrotna.** Kolektor łączy się wyłącznie z `127.0.0.1`. Launcher zawsze podaje `--inspect=127.0.0.1:<port>`. Inspektor słuchający na innym adresie jest zgłaszany w `inspector_status`.
2. **Instrumentacja za zgodą.** Hak działa tylko w procesach, w których deweloper sam go załadował (`outbound run` albo `--import`). Procesy znalezione po porcie są domyślnie tylko obserwowane; wstrzyknięcie wymaga `OUTBOUND_INJECT=1`. Wyłącznik: `OUTBOUND_HOOK=0`.
3. **Minimalny ślad w CDP.** Używamy `Network.*`, `Runtime.evaluate` z wyrażeniami tylko do odczytu i `Runtime.addBinding`. Nigdy nie włączamy domeny `Debugger` ani `Runtime`.
4. **Redakcja przy przyjęciu.** Wartości nagłówków uwierzytelniających i pasujących do wzorca nazw oraz wrażliwych parametrów URL i pól JSON są zastępowane opisem (schemat, długość, sześć znaków skrótu SHA-256), zanim trafią do magazynu. Domyślnie włączone; wyłączenie tylko jawnie (`OUTBOUND_REDACT=0`) i z ostrzeżeniem w statusie.
5. **Treści jako dane.** Treści są przycinane, zwracane w wyraźnie nazwanym polu, a `instructions` serwera mówi modelowi, żeby traktował je jako dane. Tryb treści (`eager`, `lazy`, `off`) wybiera zespół.
6. **Bez wykonywania kodu z repozytorium.** Konfiguracja to JSON. Rejestr ma prawa 0700 i 0600. Klient MCP uruchamia narzędzie przez ścieżkę, nie przez `npx` z krótką nazwą.

## Rozważane alternatywy

- **Redakcja dopiero w odpowiedzi narzędzia.** Sekret zostaje w pamięci kolektora i wypłynie każdą nową drogą wyjścia (eksport, nowe narzędzie, log). Odrzucone.
- **Pełne ukrycie wartości** (`***`). Agent nie stwierdzi wtedy, czy dwa zapytania niosły ten sam token, a to częste pytanie przy błędach 401. Skrót o długości sześciu znaków na to pozwala i nie odtwarza sekretu o dużej entropii.
- **Wstrzykiwanie domyślnie włączone** (stan obecny). Wygodne, ale kolektor wykonuje wtedy kod w każdym procesie, który akurat słucha na skanowanym porcie.
- **Token dostępu do kolektora.** Zbędny, dopóki kolektor nie słucha na żadnym gnieździe (stdio).

## Wdrożenie (2026-11-20, po przeglądzie bezpieczeństwa)

Przegląd ([docs/security-audit-2026-11-20.md](../security-audit-2026-11-20.md)) pokazał, że punkty 1–2 i 4 nie były wdrożone tak, jak opisano. Stan po poprawkach:

1. **Pętla zwrotna:** cel przyjmowany tylko z adresem WebSocket na skanowanym porcie 127.0.0.1/localhost (kolektor i hub). Launcher blokuje inspektor poza pętlą zwrotną (`OUTBOUND_ALLOW_REMOTE_INSPECT=1` to wyjątek). Zgłaszania w `inspector_status` procesu słuchającego na innym adresie nie ma.
2. **Zgoda:** zamiast `OUTBOUND_INJECT` — zgoda procesu: `OUTBOUND_INSPECT=1` (ustawia `outbound-next`) albo flaga `--experimental-network-inspection`, tylko ten sam użytkownik. Bez zgody: bez wyrażeń modyfikujących, łatek i `Network.enable`; jedynie odczyt tożsamości. Domyślne porty 9230–9249. `OUTBOUND_HOOK` nie istnieje; korelację wyłącza `PAGE_CORRELATION=0`.
3. **Ślad w CDP:** poza wyrażeniami do odczytu kolektor instaluje hak i łatę nodejs/node#66551 (`Runtime.evaluate`). `Runtime.addBinding` nie jest jeszcze używany (M4).
4. **Redakcja:** jak w README, sekcja „Security model”; HMAC-SHA256 zamiast SHA-256 (niżej).
5. **Dane niezaufane:** oznaczenie w opisach wszystkich narzędzi i w `instructions`, czyszczenie nazw i znaków sterujących.

## Konsekwencje

- **Uwaga z wdrożenia (M2):** zamiast czystego SHA-256 skrót to HMAC-SHA256 z kluczem losowanym przy starcie kolektora. Porównywanie sekretów w obrębie sesji działa tak samo, a krótkich sekretów (np. PIN-ów, prostych haseł) nie da się odgadnąć, przeliczając skróty słownikiem.

- Redakcja jest nieodwracalna w ramach sesji: żeby zobaczyć wartość, trzeba uruchomić kolektor z wyłączoną redakcją.
- Tryb zgodności (procesy bez launchera) domyślnie traci przypisanie do stron. To zmiana zachowania względem prototypu, opisana w changelogu.
- Redakcja pól JSON w treściach działa po nazwach kluczy, więc nie złapie danych osobowych pod neutralną nazwą. Ostateczną ochroną jest tryb treści `off`.
- Narzędzie pozostaje wyłącznie do lokalnego developmentu.
