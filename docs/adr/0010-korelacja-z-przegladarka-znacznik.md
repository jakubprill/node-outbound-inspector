---
status: proposed
date: 2026-11-19
---

# 0010. Korelacja z przeglądarką: znacznik ustawiany przez agenta, bez własnej propagacji trace

## Kontekst

Agent pracuje z dwóch stron: Chrome DevTools MCP pokazuje ruch przeglądarki, to narzędzie pokazuje ruch serwera. Trzeba je połączyć: „to wejście na stronę w tej karcie wywołało te zapytania serwera”. W lokalnym dev zwykle jest jeden deweloper, ale strony renderują się równolegle, przeglądarka robi prefetch, a kilka kart bywa otwartych naraz.

Chrome DevTools MCP pozwala ustawić dodatkowe nagłówki HTTP dla całej karty (`emulate` z `extraHttpHeaders`) i odczytać nagłówki odpowiedzi (`get_network_request`). Hak widzi nagłówki żądania strony w `http.server.request.start`.

## Decyzja

1. **Domyślnie czas i URL.** Filtry `page_contains` i `last_ms` zostają i wystarczają w większości przypadków.
2. **Znacznik od agenta.** Hak zapisuje wartość nagłówka `x-outbound-tag` z żądania strony, a narzędzia przyjmują filtr `tag`. Agent ustawia nagłówek w przeglądarce i dostaje wyłącznie ruch swojej karty.
3. **Nagłówek odpowiedzi tylko po włączeniu.** Hak może dopisać do odpowiedzi `x-outbound-page-request: <id>`, żeby powiązać pojedyncze żądanie.
4. **Tylko odczyt istniejących identyfikatorów.** Jeśli żądanie strony albo zapytanie wychodzące niesie `traceparent` lub `x-request-id`, wartość trafia do rekordu.
5. **Nie dopisujemy niczego do zapytań wychodzących.**

Rodzaj żądania strony (dokument, RSC, Server Action, Route Handler) i identyfikator akcji hak odczytuje z nagłówków Next. Zamianę identyfikatora akcji na plik zostawiamy Next DevTools MCP.

## Rozważane alternatywy

- **Własna propagacja `traceparent`** do wewnętrznych serwisów. Dałaby powiązanie z ich logami, ale narzędzie diagnostyczne zmieniałoby ruch do integracji. To zadanie OpenTelemetry w aplikacji.
- **`Server-Timing` z wynikami analizy.** Nagłówki odpowiedzi wychodzą, zanim zapytania się skończą (streaming), więc wyniku nie da się w nich zmieścić.
- **Nagłówek odpowiedzi domyślnie włączony.** Pewne powiązanie bez udziału agenta, ale zmienia odpowiedzi aplikacji i mogą to zauważyć jej testy.
- **Identyfikatory wewnętrzne Next.** Nieudokumentowane.

## Konsekwencje

- Najpewniejsza korelacja wymaga jednego dodatkowego kroku agenta. Opisuje go pole `instructions` i dokumentacja.
- Nagłówek ustawiony w przeglądarce trafia też do jej zapytań do innych domen, co może wywołać preflight CORS. Dokumentacja o tym uprzedza.
- Nagłówki `rsc`, `next-action` i `next-router-prefetch` to założenie do potwierdzenia na prawdziwej aplikacji (M7).
