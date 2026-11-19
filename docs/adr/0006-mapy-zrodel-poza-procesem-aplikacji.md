---
status: proposed
date: 2026-11-19
---

# 0006. Mapy źródeł rozwiązuje kolektor, wbudowanym `SourceMap` z `node:module`

## Kontekst

Ramki ze stosu wskazują skompilowane chunki (`.next/dev/server/chunks/ssr/*.js`), a agent potrzebuje pliku źródłowego i linii. Obok chunków leżą pliki `.map`. Od Next 16.1 Turbopack zapisuje w mapach kodu serwera ścieżki względne. Klasa `SourceMap` z `node:module` obsługuje mapy zwykłe i indeksowe (`sections`) na Node 22 i 24.

## Decyzja

Hak wysyła pozycje wygenerowane. **Kolektor** czyta `//# sourceMappingURL=` z końca chunku, wczytuje mapę z dysku i tłumaczy pozycję klasą `SourceMap`. Wynik zapisuje w rekordzie zaraz po przyjęciu komunikatu. Pamięć podręczna map ma klucz: ścieżka i czas modyfikacji. Gdy chunk jest nowszy niż zapytanie, wynik dostaje `stale: true`.

Obsługiwane ścieżki źródeł: względne wobec mapy, `file://`, `turbopack:///[project]/…`, `webpack://…`. Dla webpacka w trybie dev (moduły w `eval`, mapa w adresie `data:`) podawany jest tylko plik wynikający z adresu ramki.

## Rozważane alternatywy

- **Rozwiązywanie w procesie aplikacji** (`--enable-source-maps`, `module.findSourceMap`). Zmienia sposób formatowania stosów w aplikacji i dokłada pracę w jej procesie. Sprzeczne z zasadą minimalnego śladu.
- **Domena Debugger** (`scriptParsed` z adresem mapy). Obsłużyłaby mapy inline webpacka, ale wymaga włączenia domeny, której kolektor ma nie włączać nigdy.
- **Biblioteka** (`@jridgewell/trace-mapping`, `source-map`). Szybsza przy dużych mapach, ale to pierwsza zależność uruchomieniowa. Do rozważenia dopiero, gdy pomiar pokaże problem.
- **Wewnętrzny punkt końcowy Next do mapowania ramek.** Nieudokumentowane API serwera dev.

## Konsekwencje

- Zero zależności i żadnej pracy w procesie aplikacji.
- Kolektor musi widzieć system plików aplikacji. W lokalnym dev to zawsze prawda.
- Między przechwyceniem a rozwiązaniem HMR może przebudować chunk. Okno jest krótkie, a przypadek oznaczony.
- Pełne mapowanie webpacka jest poza zakresem.
- Format map Turbopacka z Next 16.4 nie był sprawdzony w tym środowisku. Przy nieczytelnej mapie wynik zawiera ścieżkę chunku i `mapped: false`.
