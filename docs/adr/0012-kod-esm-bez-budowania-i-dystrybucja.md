---
status: proposed
date: 2026-11-19
---

# 0012. Kod: moduły ESM bez budowania i bez zależności; dystrybucja jako devDependency monorepo

## Kontekst

Prototyp to jeden plik `.mjs` bez zależności, uruchamiany wprost przez Node. Wersja docelowa ma około 25 plików i trzy miejsca uruchomienia: proces kolektora, launcher oraz kod w procesie aplikacji. Wszystkie trzy muszą być w tej samej wersji, bo łączy je format rejestru i protokół haka. Zespół używa Bun jako menedżera pakietów; repozytorium narzędzia jest prywatne.

## Decyzja

1. **Zwykłe moduły ESM (`.mjs`), bez kroku budowania.** Typy w JSDoc; sprawdzanie typów (`tsc --checkJs`) może działać w CI jako zależność wyłącznie deweloperska.
2. **Zero zależności uruchomieniowych.** Wszystko, czego potrzeba, jest w Node 22: `WebSocket`, `fetch`, `node:test`, `util.parseArgs`, `SourceMap`, `diagnostics_channel`.
3. **Czysty rdzeń, I/O na krawędziach, jeden korzeń kompozycji.** Import modułu nie ma efektów ubocznych. `hook/*` importuje tylko moduły `node:` i `registry.mjs`.
4. **Jeden plik wykonywalny** `outbound` z poleceniami `mcp`, `run`, `status`, `tail`. `src/outbound-mcp.mjs` zostaje jako alias do wersji 1.0.
5. **Dystrybucja:** devDependency w katalogu głównym monorepo, przypięta do tagu (zależność z gita albo rejestr wewnętrzny). Skrypty aplikacji wołają `outbound run`, a `.mcp.json` w repozytorium wskazuje ścieżkę w `node_modules`.

## Rozważane alternatywy

- **TypeScript z kompilacją.** Lepsze typy i narzędzia, ale dochodzi krok budowania, katalog wynikowy i publikacja artefaktów; instalacja z gita przestaje być trywialna. Hak wysyłany jako tekst funkcji musiałby i tak być pisany ostrożnie.
- **Jeden plik jak dziś.** Najprostsza dystrybucja, ale przy tej wielkości nie da się testować części osobno, a import uruchamia zegary i gniazda.
- **Pakiet w publicznym npm i `npx`.** Wygodne poza zespołem. Wymaga decyzji o upublicznieniu i nazwie; `npx` z krótką nazwą grozi pobraniem obcego pakietu.
- **Instalacja globalna.** Launcher, hak i kolektor mogłyby się rozjechać wersjami między deweloperami.

## Konsekwencje

- Kod, który jest w repozytorium, jest kodem, który działa: nie ma artefaktów do śledzenia.
- Wersja narzędzia jest zapisana w pliku blokady monorepo, więc cały zespół ma tę samą.
- Brak kompilatora oznacza dyscyplinę: JSDoc, małe moduły, testy kontraktów między modułami.
- Reguła zależności jest konwencją. Pilnuje jej test „import bez efektów ubocznych” i przegląd kodu.
- Upublicznienie w npm pozostaje możliwe bez zmian w kodzie.
