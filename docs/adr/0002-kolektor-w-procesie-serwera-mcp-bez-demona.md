---
status: proposed
date: 2026-11-19
---

# 0002. Kolektor działa w procesie serwera MCP, w pamięci, bez demona

## Kontekst

Klient MCP uruchamia serwer stdio jako własny proces potomny, więc każda sesja agenta (drugie okno, drugi edytor, drugi worktree) to osobny proces `outbound mcp`. Inspektor Node przyjmuje wiele sesji CDP naraz i każda dostaje te same zdarzenia. Trzeba zdecydować, czy ruch zbiera jeden wspólny proces, czy każdy klient sam.

## Decyzja

Każdy proces `outbound mcp` (oraz `outbound tail`) ma **własny kolektor**: własne sesje CDP i własny magazyn w pamięci. Nic nie jest zapisywane na dysk. Rdzeń (`createCollector`) nie zna transportu, więc wspólny proces można dodać później bez zmian w magazynie i analizatorach.

## Rozważane alternatywy

- **Wspólny demon** obsługujący wielu klientów. Daje historię sprzed startu sesji agenta i jedno pobranie każdej treści. Odrzucone na teraz: trzeba rozwiązać, kto go uruchamia i zatrzymuje, zgodność wersji demona i klientów, gniazdo lokalne z kontrolą dostępu i martwe demony po awarii. To więcej kodu niż cała reszta narzędzia.
- **Zapis ruchu na dysk** (NDJSON, SQLite). Daje historię i eksport. Odrzucone: treści odpowiedzi integracji i sekrety lądowałyby w plikach, dochodzi sprzątanie i zależność. Nagrywanie zdarzeń zostaje wyłącznie jako skrypt deweloperski do tworzenia danych testowych.

## Konsekwencje

- Bufor zaczyna się w chwili startu sesji agenta. Zalecany przebieg pracy to: wyczyść, odtwórz scenariusz, analizuj.
- Wiele sesji agentów oznacza wiele sesji CDP na aplikację. Hak musi więc obsługiwać wielu odbiorców naraz ([ADR 0004](0004-hak-preload-wypychanie-i-zlaczenie-po-requestid.md)), a każda sesja ma własny bufor treści w procesie aplikacji, stąd jawne limity.
- Do tematu demona wracamy, gdy trzy lub więcej równoległych sesji stanie się normą, gdy potrzebna będzie historia sprzed sesji albo gdy narzut wielu sesji będzie mierzalny.
