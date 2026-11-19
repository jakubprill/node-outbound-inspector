---
status: proposed
date: 2026-11-19
---

# 0004. Hak: ładowany przez `--import`, wypycha komunikaty przez wiązanie CDP, złączenie po `requestId`

## Kontekst

Prototyp wstrzykuje kod korelujący przez `Runtime.evaluate` do każdego znalezionego procesu, trzyma wpisy w buforze w procesie aplikacji i co sekundę opróżnia go przez `log.splice(0)`. Wpis łączy z zapytaniem po metodzie, URL i czasie.

Trzy problemy:

- przy dwóch kolektorach wpisy dostaje tylko jeden (zmierzone: 18/18 i 0/18);
- kod trafia do procesu bez zgody jego właściciela i dopiero po podłączeniu;
- dopasowanie po URL i czasie jest zgadywaniem, gdy dwa miejsca w kodzie wołają ten sam adres jednocześnie.

Ustalenia z eksperymentów: `Runtime.addBinding` działa w inspektorze Node bez `Runtime.enable` i dostarcza zdarzenie tylko sesji, która wiązanie założyła. Inspektor zapisuje `requestId` na obiekcie żądania pod `Symbol(kInspectorRequestId)`; hak widzi go w mikrozadaniu po zdarzeniu `create`.

## Decyzja

1. **Dostarczanie:** hak ładuje deweloper, przez `outbound run` albo `--import node-outbound-inspector/register`. Wstrzyknięcie przez `Runtime.evaluate` zostaje dla procesów znalezionych po porcie i wymaga włączenia (`OUTBOUND_INJECT=1`). Oba tryby instalują tę samą funkcję.
2. **Transport:** hak niczego nie buforuje. Każdy kolektor zakłada własne wiązanie (`Runtime.addBinding`) i zgłasza jego nazwę hakowi; hak wywołuje wszystkie zgłoszone wiązania z jednym komunikatem JSON.
3. **Złączenie:** komunikat niesie `requestId` inspektora odczytany z obiektu żądania. Dopasowanie po metodzie, URL i czasie zostaje jako druga ścieżka, gdy identyfikatora brak.
4. **Wersja:** protokół haka ma numer (`v: 1`); kolektor odrzuca nieznany.

## Rozważane alternatywy

- **Odpytywanie z kursorem zamiast `splice`.** Naprawia problem wielu odbiorców, ale zostawia bufor w procesie aplikacji, sekundowe opóźnienie i odpytywanie bezczynnych aplikacji.
- **Własne gniazdo z haka do kolektora** (gniazdo uniksowe, HTTP). Niezależne od CDP, ale to dodatkowy kanał z własnym adresowaniem i kontrolą dostępu, a połączenie CDP i tak już istnieje.
- **Nagłówek korelacyjny dopisywany do zapytań wychodzących.** Złączenie byłoby pewne, ale narzędzie zmieniałoby ruch do integracji.
- **Samo dopasowanie po URL i czasie.** Działa w testach, ale nie rozróżni dwóch miejsc w kodzie wołających ten sam adres w tej samej chwili.

## Konsekwencje

- Zależność od wewnętrznego szczegółu Node (nazwa symbolu). Jest sonda zgodności i ścieżka awaryjna.
- Kolektor dostaje tylko to, co wydarzyło się po jego podłączeniu. To spójne ze zdarzeniami `Network.*`, których Node też nie odtwarza.
- `installHook` musi pozostać samowystarczalną funkcją bez importów, żeby dało się ją wysłać jako tekst.
- Znika odpytywanie co sekundę i `pollAll()` przed każdym wywołaniem narzędzia. Bez `Runtime.addBinding` nie ma przypisania do stron; nie utrzymujemy ścieżki zastępczej.
