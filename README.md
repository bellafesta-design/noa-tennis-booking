# NoA Tennis Booking

Ett enkelt bokningssystem för NoA:s tennisbana:
- Onsdagar kl 12:00-13:00
- Bana 13
- Ett helt kalenderår genereras automatiskt
- Endast admin kan stänga datum eller rensa bokningar
- Deltagare bokar med e-post, namn och byrå
- Samma e-post kan bara ha en aktiv framtida bokning i taget

## Start

```bash
ADMIN_PASSWORD='byt-till-ett-starkt-losenord' node server.js
```

Öppna sedan:

- http://localhost:8787

## Miljövariabler

- `ADMIN_PASSWORD`: adminlösenord (måste sättas i produktion)
- `PORT`: port (default `8787`)
- `BOOKING_YEAR`: vilket år som ska initieras (default = innevarande år)
- `DATA_DIR`: valfri katalog för databasfiler (default `./data`)
- `RESEND_API_KEY`: valfritt, för att skicka avbokningskod via e-post (Resend)
- `RESEND_FROM_EMAIL`: avsändaradress för Resend, t.ex. `NoA Tennis <no-reply@din-domän.se>`

## Adminflöde

1. Logga in i Admin-sektionen.
2. Stäng/öppna datum med checkbox + orsak.
3. Rensa bokning om någon bokat fel.

## Avbokning för användare

1. Klicka på sitt bokade datum i kalendern.
2. Ange samma e-postadress som användes vid bokning.
3. Klicka på `Send code`.
4. Ange koden och klicka `Cancel my booking`.

Om `RESEND_*` inte är konfigurerat visas koden i UI:t (dev-läge).

## Datalagring

SQLite-databasen skapas här:

- `data/tennis-booking.db`

## Tips inför skarp drift

- Kör bakom HTTPS (t.ex. på Render/Fly.io eller intern server).
- Sätt ett starkt adminlösenord i miljövariabel.
- Ta gärna daglig backup av `data/tennis-booking.db`.

## Publicera på Render (rekommenderat)

Varför Render: appen använder SQLite och behöver en persistent disk för att bokningar inte ska försvinna vid omstart.

1. Lägg projektet i ett GitHub-repo.
2. I Render: `New +` -> `Blueprint`.
3. Välj repot. Render läser `render.yaml` automatiskt.
4. Sätt ett starkt värde för `ADMIN_PASSWORD`.
5. Om ni vill skicka avbokningskod via e-post, sätt även:
   - `RESEND_API_KEY`
   - `RESEND_FROM_EMAIL`
6. Klicka `Apply` / `Deploy`.
7. Öppna din publika URL från Render.

`render.yaml` skapar:
- en webbtjänst (`npm start`)
- persistent disk monterad på `/var/data`
- `DATA_DIR=/var/data` så SQLite lagras permanent
