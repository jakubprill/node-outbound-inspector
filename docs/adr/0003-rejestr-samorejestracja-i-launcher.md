---
status: proposed
date: 2026-11-19
---

# 0003. Aplikacje zgłaszają się same do rejestru, a launcher dokłada flagi i rezerwuje port

## Kontekst

Prototyp skanuje porty 9229–9249. W monorepo oznacza to ręczne planowanie portów, a pomyłka kończy się po cichu: druga aplikacja na zajętym porcie działa bez inspektora. Druga cicha awaria to proces uruchomiony bez flagi sieciowej.

Ustalenia z eksperymentów:

- flagi `--experimental-network-inspection` nie da się podać przez `NODE_OPTIONS` ani plik konfiguracyjny Node; musi stać w linii poleceń;
- `fork` domyślnie dziedziczy `execArgv`, więc flaga z procesu CLI przechodzi na proces serwera;
- `inspector.url()` w procesie podaje faktyczny adres inspektora (także po `inspector.open()`), a po nieudanym starcie zwraca `undefined`;
- proces zabity sygnałem nie emituje zdarzenia `exit`.

## Decyzja

1. **Samorejestracja.** Proces z aktywnym inspektorem sam zapisuje wpis `~/.outbound-inspector/apps/<pid>.json` z `wsUrl`, pid, nazwą, katalogiem i wersją Node. Robi to moduł ładowany przez `--import`.
2. **Launcher `outbound run -- <polecenie>`.** Składa polecenie (flaga sieciowa i `--import` w `execArgv`, port inspektora), rezerwuje port z zakresu 9230–9249 plikiem zakładanym atomowo, zaczynając od portu wynikającego ze skrótu nazwy aplikacji, czeka na zgłoszenie procesu i ostrzega, gdy go nie ma. Po zakończeniu sprząta wpisy i rezerwację.
3. **Kolektor czyta rejestr** i pokazuje tylko procesy z bieżącego repozytorium. Skanowanie portów zostaje do 1.0 jako tryb zgodności dla procesów uruchomionych ręcznie.

## Rozważane alternatywy

- **Skanowanie zakresu portów** (stan obecny). Nie rozwiązuje planowania portów ani cichych awarii.
- **`--inspect=0` i odczyt portu ze stderr.** Wymaga przechwycenia stderr, czyli utraty TTY i kolorów w terminalu.
- **Rejestr pisany tylko przez launcher.** Launcher nie wie, który proces w drzewie ma inspektor, i nie odróżni własnej aplikacji od obcego procesu, który zajął ten sam port.
- **Zawsze port 0.** Bez wyścigów, ale port zmienia się przy każdym starcie, więc `chrome://inspect` trzeba konfigurować od nowa.
- **Lista procesów systemu** (`ps`, `lsof`). Zależne od systemu, wolne, kruche.
- **Nakładka na `node` w `PATH`.** Działa dla dowolnego polecenia, ale instrumentuje każde narzędzie Node w drzewie procesów.

## Konsekwencje

- Skrypty aplikacji (`"dev:inspect": "outbound run -- next dev"`) zależą od CLI narzędzia, więc `outbound run` staje się publicznym API.
- Brak inspektora przestaje być cichy: launcher ostrzega, a `inspector_status` podaje powód.
- Dwie kopie tej samej aplikacji (worktree) dostają różne porty i nie mieszają się w kolektorze.
- Martwe wpisy po twardym zabiciu procesu są normalne; kolektor sprawdza pid przy każdym odczycie.
- Launcher rozpoznaje tylko polecenia `node`, pliki binarne pakietów uruchamiane przez Node i `next dev`. Dla pozostałych kończy się instrukcją ręczną.
- Do potwierdzenia na prawdziwym monorepo (M3): `--import` dociera do procesu serwera Next, a `next dev --inspect=127.0.0.1:<port>` przyjmuje adres z hostem.
