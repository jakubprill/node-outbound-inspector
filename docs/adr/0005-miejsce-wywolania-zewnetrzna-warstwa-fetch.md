---
status: proposed
date: 2026-11-19
---

# 0005. Miejsce wywołania łapie zewnętrzna warstwa `fetch`, nie stos inicjatora

Status dodatkowy: decyzja oparta na symulacji. Wymaga potwierdzenia na prawdziwym Next.js w M5 (sonda w załączniku B dokumentu architektury).

## Kontekst

W Next.js stos inicjatora ze zdarzenia CDP kończy się na wewnętrznych funkcjach frameworka, bo Next opakowuje `fetch` funkcją asynchroniczną. Agent dostaje URL i stronę, ale nie plik i linię.

Ustalenia z eksperymentów (Node 22 i 24, opakowanie symulowane):

- stos inicjatora CDP ma tylko ramki synchroniczne; domena Debugger i `setAsyncCallStackDepth` niczego nie dodają;
- zdarzenie `undici:request:create` jest publikowane synchronicznie wewnątrz `fetch`, pod 27–33 ramkami undici, więc przy domyślnym limicie 10 ramek kodu aplikacji nie widać nigdy;
- `new Error().stack` w subskrybencie po opakowaniu z `await` daje ramki `async` tylko wtedy, gdy między wywołaniem użytkownika a natywnym `fetch` miną co najmniej dwa mikrozadania. Przy dokładnie jednym nie ma żadnej ramki użytkownika. Ramka `async` wskazuje `await`, nie wywołanie, a w `Promise.all` jest wspólna dla wszystkich zapytań.

## Decyzja

Hak zamienia `globalThis.fetch` na **akcesor**, którego odczyt zwraca **Proxy** bieżącej funkcji. Pułapka `apply` jest wywoływana synchronicznie przez kod aplikacji: łapie stos (`Error.captureStackTrace`, surowe obiekty `CallSite`, limit 60 ramek) i uruchamia właściwe wywołanie w kontekście `AsyncLocalStorage`. Subskrybent `undici:request:create` odczytuje stos z kontekstu.

Zapis do `globalThis.fetch` (patch Next, inne biblioteki) podmienia tylko funkcję pod spodem, więc nasza warstwa zawsze zostaje zewnętrzna. Proxy przepuszcza właściwości, w tym znacznik, po którym Next rozpoznaje własny patch.

Kolejność degradacji: zewnętrzna warstwa → ramki `async` z subskrybenta → stos inicjatora CDP → samo żądanie strony. Wynik podaje, którą drogą powstał (`origin.via`).

## Rozważane alternatywy

- **Stos inicjatora CDP.** Tylko ramki synchroniczne. Wystarcza w zwykłym Node, nie w Next.
- **Sam subskrybent z podniesionym limitem ramek.** Bez patchowania globalu, ale zależny od liczby mikrozadań wewnątrz Next i mniej dokładny. Zostaje jako rezerwa.
- **Podmiana `fetch` przed Nextem jako warstwa najgłębsza.** Ten sam moment wywołania co subskrybent, więc te same ograniczenia, a dodatkowo patch.
- **Domena Debugger.** Nie rozszerza stosów, a włączona może zatrzymać proces na instrukcji `debugger`.
- **Wrapper w kodzie aplikacji.** Pewny, ale wymaga zmian i dyscypliny w aplikacjach.

## Konsekwencje

- Dokładna linia i kolumna wywołania, także dla każdego `fetch` w `Promise.all`. Koszt 10–14 µs na wywołanie.
- Deskryptor `globalThis.fetch` jest akcesorem. Typowe użycia działają (13 kontroli), ale kod badający deskryptor zobaczy różnicę.
- Nie obejmuje `node:http`. Tam hak łapie stos synchroniczny przy tworzeniu żądania, co pomaga tylko wtedy, gdy biblioteka woła `http.request` synchronicznie z kodu użytkownika.
- Zależność od zachowania Next (rozpoznawanie własnego patcha, sięganie po `fetch` przez global). Jeśli sonda na prawdziwym Next zawiedzie, wdrażana jest sama rezerwa i ten ADR dostaje następcę.
- Wyłącznik `OUTBOUND_HOOK=0` usuwa hak bez zmiany skryptów.
