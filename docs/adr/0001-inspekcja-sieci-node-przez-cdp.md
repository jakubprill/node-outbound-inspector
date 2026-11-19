---
status: proposed
date: 2026-11-19
---

# 0001. Źródłem danych o ruchu jest wbudowana inspekcja sieci Node (CDP)

## Kontekst

Narzędzie ma pokazać ludziom (Chrome DevTools) i agentom (MCP) zapytania wychodzące procesu Node: URL, nagłówki, status, treść, czasy. Node ma flagę `--experimental-network-inspection`, która wysyła zdarzenia `Network.*` do każdego podłączonego klienta CDP. Prototyp już na niej stoi.

Eksperymenty pokazały jej koszty: nie da się jej podać przez `NODE_OPTIONS` ani plik konfiguracyjny Node, `Network.enable` udaje sukces bez flagi, treść odpowiedzi `fetch` jest dopiero od Node 24, treść żądań jest dostępna tylko częściowo, a Node buforuje treści w procesie aplikacji osobno dla każdej sesji CDP. Dokumentacja Node oznacza tę część API jako „1.1 Active development”.

## Decyzja

Zostajemy przy wbudowanej inspekcji sieci jako **jedynym źródle danych o samym ruchu**. Własny kod w procesie aplikacji (hak) tylko wzbogaca rekordy o to, czego Node nie wie: żądanie strony, miejsce wywołania, znacznik. Kształt zdarzeń CDP zna wyłącznie moduł `ingest`.

## Rozważane alternatywy

- **Własny agent w procesie zbierający wszystko z `diagnostics_channel`**, ładowany przez `--import` (dozwolone w `NODE_OPTIONS`). Znika flaga eksperymentalna i potrzeba launchera. Odrzucone jako źródło podstawowe: treści odpowiedzi trzeba by przechwytywać samemu ze strumieni, DevTools nie pokazałyby niczego, a w procesie aplikacji działałoby dużo więcej naszego kodu. Zostaje jako plan awaryjny (metadane bez treści), gdyby flaga zniknęła.
- **Proxy przechwytujące** (mitmproxy, HTTP Toolkit). Niezależne od runtime, ale wymaga przekierowania undici oraz `http`/`https`, certyfikatów dla HTTPS i nie zna ani żądania strony, ani kodu. Odrzucone.
- **OpenTelemetry + Jaeger.** Inny cel: czasy i przepływ między serwisami, także poza dev. Domyślnie bez treści. Uzupełnienie, nie zamiennik.
- **Mechanizmy Next.js** (`logging.fetches`, `experimental.requestInsights` z Next DevTools MCP). Tylko Next i tylko `fetch`; widzą za to zachowanie cache. Uzupełnienie; warto porównać przed M6.

## Konsekwencje

- Flaga musi stać w linii poleceń procesu, stąd launcher ([ADR 0003](0003-rejestr-samorejestracja-i-launcher.md)).
- Ludzie i agenci patrzą na te same dane: zakładka Network w DevTools i narzędzia MCP mają wspólne źródło.
- Ograniczenia Node stają się ograniczeniami narzędzia. Kolektor je wykrywa i nazywa, zamiast zgadywać ([ADR 0011](0011-zgodnosc-z-eksperymentalna-flaga-node.md)).
- Kolektor zawsze podaje limity bufora w `Network.enable`, żeby nie zwiększać pamięci aplikacji bez kontroli.
