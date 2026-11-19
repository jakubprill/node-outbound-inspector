---
status: proposed
date: 2026-11-19
---

# 0011. Zgodność z eksperymentalną flagą Node: możliwości zamiast wersji i sondy zgodności

## Kontekst

Narzędzie stoi na API, które Node oznacza jako „1.1 Active development”, oraz na kilku szczegółach wewnętrznych. Różnice zmierzone między Node 22.23.5 a 24.22.3:

- treść odpowiedzi `fetch`: brak na 22 (pusty łańcuch bez błędu), pełna na 24;
- treść żądania: tylko `fetch` na 24 i tylko z `charset` w `content-type`;
- kanały `undici:request:bodyChunkSent/Received`: tylko na 24;
- bufor treści: na 24 domyślnie około 100 MB na sesję CDP.

Zachowania sprzeczne z intuicją na obu wersjach: `Network.enable` zwraca sukces bez flagi, a `wallTime` jest w milisekundach. Deweloperzy mają Node 26, którego tu nie było jak sprawdzić.

## Decyzja

1. **Możliwości zamiast wersji.** Kolektor ustala dla każdego procesu, co działa (flaga w `process.execArgv`, treść odpowiedzi, treść żądania, `requestId` w komunikatach haka, `Runtime.addBinding`), i pokazuje to w `inspector_status` razem z powodem i wskazówką naprawy. Numer wersji Node służy tylko do treści wskazówki.
2. **Jedno miejsce znające CDP.** Kształt zdarzeń `Network.*` zna wyłącznie `ingest`; normalizuje jednostki czasu i stany treści.
3. **Sondy zgodności.** Każde założenie o Node ma test w `test/compat/`. Sondy biegną w macierzy wersji (22, 24, bieżąca) przy każdej zmianie i raz w tygodniu na nightly. Czerwona sonda na nightly to ostrzeżenie, nie blokada.
4. **Nagrania per wersja.** Testy jednostkowe `ingest` używają nagrań zdarzeń z każdej wspieranej wersji.
5. **Wsparcie.** Kolektor i launcher: Node 22 lub nowszy. Proces aplikacji: 22.6 lub nowszy z ograniczeniami, 24 lub nowszy zalecany.

## Rozważane alternatywy

- **Warunki na numerze wersji** (`if major >= 24`). Proste, ale mylą się przy wersjach pośrednich, przeniesionych poprawkach i przyszłych zmianach.
- **Wymaganie Node 24 lub nowszego wszędzie.** Usuwa część gałęzi kodu. Do rozważenia, jeśli cały zespół ma Node 24 lub nowszy.
- **Przypięcie do jednej wersji Node.** Narzędzie przestaje działać przy pierwszej aktualizacji Node u dewelopera.
- **Brak sond, reagowanie na zgłoszenia.** Zmianę w Node zauważylibyśmy dopiero, gdy narzędzie po cichu przestanie pokazywać dane.

## Konsekwencje

- `inspector_status` staje się głównym narzędziem diagnostycznym: tabela „objaw, przyczyna, naprawa” w README jest na nim oparta.
- Sondy wykrywają także zmiany na lepsze. Gdyby flaga stała się dozwolona w `NODE_OPTIONS`, launcher można uprościć.
- Gdyby flaga zniknęła, hak może przejąć zbieranie metadanych z `diagnostics_channel` (bez treści) bez zmian w magazynie, analizatorach i warstwie MCP.
- Utrzymanie macierzy i nagrań to stały, mały koszt.
