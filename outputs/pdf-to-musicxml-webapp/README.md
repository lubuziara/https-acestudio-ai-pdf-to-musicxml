# PDF to MusicXML Web App

Prosta aplikacja webowa inspirowana przeplywem ACE Studio: upload PDF/obrazu z nutami, konwersja i natychmiastowy przycisk pobrania MusicXML.

## Uruchomienie

```bash
npm start
```

Domyslny adres: `http://localhost:4173`.

## Prawdziwa konwersja OMR

Frontend i backend sa gotowe. Do realnego PDF -> MusicXML potrzebny jest silnik OMR. Ta wersja obsluguje Audiveris CLI:

```bash
set AUDIVERIS_CMD=C:\sciezka\do\audiveris.bat
npm start
```

Jesli `audiveris` jest w `PATH`, zmienna nie jest potrzebna.

Mozesz tez utworzyc `audiveris.config.json` obok `server.js`:

```json
{
  "command": "C:\\Program Files\\Audiveris\\runtime\\bin\\java.exe",
  "args": [
    "--add-exports=java.desktop/sun.awt.image=ALL-UNNAMED",
    "--enable-native-access=ALL-UNNAMED",
    "-Dfile.encoding=UTF-8",
    "-Xms512m",
    "-Xmx8G",
    "-cp",
    "C:\\Program Files\\Audiveris\\app\\*",
    "Audiveris",
    "-constant",
    "org.audiveris.omr.step.LoadStep.maxPixelCount=0",
    "-constant",
    "org.audiveris.omr.image.ImageLoading.pdfResolution=72"
  ]
}
```

Status podlaczenia sprawdzisz pod `http://localhost:4173/api/engine`.

Bez Audiveris backend zwraca poprawny demonstracyjny `.musicxml`, zeby mozna bylo przetestowac caly przeplyw aplikacji bez instalowania zaleznosci.

## Limity

- PDF, PNG, JPG
- Do 5 MB
- PDF do 10 stron
- Backend jest przygotowany pod wielostronicowe partytury takie jak przykladowy PDF: wokal, fortepian, akordy, tekst i zmiany metrum.
- Jesli Audiveris nie potrafi wyeksportowac calego wielostronicowego PDF-a naraz, aplikacja probuje strony pojedynczo i zwraca ZIP z plikami MusicXML.
