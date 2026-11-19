---
status: proposed
date: 2026-11-19
---

# 0007. Warstwa MCP bez SDK: tylko narzędzia, serwer obsługujący obie ery protokołu

## Kontekst

Prototyp implementuje MCP ręcznie: `initialize`, `ping`, `tools/list`, `tools/call` po stdio, około 30 linii. Potrzebujemy wyłącznie narzędzi i wyłącznie stdio.

Bieżąca rewizja specyfikacji (2026-07-28) jest bezstanowa: znosi `initialize`, wymaga `server/discover` i metadanych wersji w każdym żądaniu, a wyniki mają pole `resultType`. Według tabeli zgodności ze specyfikacji:

- klient obu er sonduje serwer stdio metodą `server/discover` i przy dowolnym niewspółczesnym błędzie wraca do `initialize`, więc prototyp z takim klientem działa;
- klient wyłącznie nowej ery z serwerem starej ery nie działa.

Rewizje specyfikacji wychodzą mniej więcej dwie na rok.

## Decyzja

Zostajemy bez SDK. `mcp/server.mjs` (szacunkowo 150 linii) obsługuje **obie ery**: handshake `initialize` oraz tryb bezstanowy (`server/discover`, metadane per żądanie, `resultType`, błąd nieobsługiwanej wersji). Wystawiamy tylko narzędzia i pole `instructions`. Funkcja `handle(message)` jest czysta, więc protokół testuje się bez procesów.

**Kiedy przechodzimy na oficjalny SDK** (wystarczy jeden warunek):

1. potrzebny jest transport HTTP;
2. potrzebne są funkcje poza narzędziami: zadania, żądania wielorundowe, subskrypcje;
3. druga z rzędu rewizja specyfikacji wymaga zmian większych niż około 100 linii;
4. test zgodności z oficjalnym klientem nie przechodzi, a poprawka nie jest oczywista.

Wymiana dotyczy jednego pliku: `mcp/tools.mjs` nie zna protokołu.

## Rozważane alternatywy

- **Oficjalny SDK TypeScript** (v1 `@modelcontextprotocol/sdk` albo pakiety v2). Zgodność ze specyfikacją utrzymuje ktoś inny. Odrzucone na teraz: narzędzie widzi sekrety i steruje procesami deweloperskimi, więc każda zależność to powierzchnia ataku; dochodzi czas instalacji i własne migracje między wersjami SDK. Używamy ułamka jego funkcji.
- **Zostać przy samej erze `initialize`.** Zero pracy dziś, ale narzędzie przestanie działać z klientami, które porzucą starą erę.
- **Zasoby i prompty MCP.** Zasoby mają nierówną obsługę w klientach, a dane są zależne od filtrów. Prompty zastępuje pole `instructions`.

## Konsekwencje

- Specyfikacji pilnujemy sami. Testy protokołu dla obu er są obowiązkowe; test z oficjalnym klientem może działać w CI jako zależność wyłącznie deweloperska.
- Narzędzie pozostaje czytelne w całości i uruchamia się bez instalowania czegokolwiek.
- Decyzja jest odwracalna małym kosztem, o ile `mcp/tools.mjs` nie zacznie polegać na szczegółach protokołu.
