---
status: accepted
date: 2026-11-19
---

# 0008. Kontrakt dla agenta: pięć narzędzi, domyślnie podsumowanie, twardy budżet znaków

## Kontekst

Wynik narzędzia MCP trafia do kontekstu modelu, więc jego rozmiar jest kosztem. Pomiar prototypu: `analyze_server_timeline` dla 132 zapytań zwraca 88 072 znaki (z czego 36% to wcięcia JSON), a rozmiar rośnie liniowo z buforem do 5000 zapytań. Claude Code ostrzega od 10 tys. tokenów i domyślnie obcina wynik na 25 tys. Same definicje pięciu narzędzi to 2659 znaków.

Wynik jest też kontraktem: polegają na nim testy, skrypt demonstracyjny i przyzwyczajenia agentów.

## Decyzja

1. **Pięć narzędzi, te same nazwy.** Nowe potrzeby obsługują parametry (`page_request_id`, `tag`, `status`, `detail`, `settle_ms`, `body_offset`), nie nowe narzędzia.
2. **Domyślnie podsumowanie.** `analyze_server_timeline` zwraca dzisiejsze pola bez `timeline`, dla 20 najnowszych żądań stron. Pełna oś czasu jest dostępna po `page_request_id` albo `detail: "full"`.
3. **Budżet.** Cel to 6000 znaków w typowym wyniku, twardy limit to 20 000. Wynik przycięty zawsze zawiera `truncated: true` i wskazówkę, jak zawęzić zapytanie.
4. **Forma.** JSON bez wcięć i bez pustych pól; w listach parametry URL skracane; stronicowanie kursorem po rosnącym `id`.
5. **Zmiany tylko addytywne** w ramach wersji głównej: istniejące pola nie znikają i nie zmieniają znaczenia. Opisy słowne (werdykty) dostają obok kody maszynowe.
6. **Model zorientowany na żądanie strony.** Podstawową jednostką analizy jest żądanie strony z listą zapytań, nie płaska lista zapytań.

## Rozważane alternatywy

- **Więcej wyspecjalizowanych narzędzi** (`list_page_requests`, `wait_for_idle`, `get_body`). Czytelniejsze pojedynczo, ale każde kosztuje kontekst w każdej sesji i mnoży decyzje modelu.
- **Tekst albo tabele zamiast JSON.** Mniej znaków, ale trudniejsze do testowania i mniej jednoznaczne.
- **Poleganie na limitach klienta.** Klient obcina wynik w dowolnym miejscu, a model nie wie, czego nie zobaczył.
- **Zasoby MCP dla dużych treści.** Nierówna obsługa w klientach; stronicowanie w narzędziu działa wszędzie.

## Konsekwencje

- Agent zwykle potrzebuje dwóch wywołań: podsumowanie, potem szczegóły jednej strony albo jednego zapytania.
- Zrzuty wyników (`test/golden/`) są częścią testów; każda ich zmiana wymaga wpisu w changelogu.
- Zmiana wartości domyślnej `analyze_server_timeline` to świadoma zmiana zachowania w M6. Pola używane przez dzisiejszy test e2e zostają.
- `settle_ms` usuwa wyścig „analiza przed końcem zapytań”, który dziś objawia się pominięciem zapytań w toku.
