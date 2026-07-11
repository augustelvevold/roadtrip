# Roadtrip 2026 – prosjektinstruksjoner

Selvhostet, delt reiseplan (Node/Express i Docker) for roadtrip 18.–29. juli 2026.
Deployes på en Proxmox LXC med docker compose; nås via subdomene bak reverse proxy.

## Arkitektur

- `server.js` – Express-server: PIN-auth (cookie eller `Authorization: Bearer <PIN>`),
  innholds-API, bildeopplasting. Ingen database – alt i `data/content.json`.
- `public/index.html` – hele frontenden (vanilla JS, én fil): visning + redigeringsmodus,
  markdown via marked + DOMPurify (kopieres til `public/vendor/` i Docker-builden).
- `default-content.json` – utgangsinnholdet; kopieres til `data/content.json` ved
  FØRSTE oppstart. Etter det er `data/content.json` sannheten – ikke rediger
  `default-content.json` for å endre live-innhold.
- `data/` – gitignorert runtime-tilstand (innhold, secret, opplastede bilder). Rør aldri.

## API

- `GET /api/content` → hele planen (JSON, med `rev`-versjonsnummer)
- `PUT /api/content` → erstatt planen; `rev` må matche serverens, ellers 409
- `POST /api/check {id, value}` / `POST /api/note {id, text}` → lettvekts-oppdateringer
- `POST /api/upload?name=x.jpg` (rå body) → `{url}`

Datamodellen er dokumentert i README.md.

## Git-arbeidsflyt

- Remote: `https://github.com/augustelvevold/roadtrip` (branch `main`)
- Start alltid med `git pull` før endringer; avslutt med commit + `git push`
- Commit-meldinger på norsk, korte og beskrivende
- Ikke commit `data/`, `node_modules/` eller PIN-koder (`.gitignore` dekker dette –
  la PIN stå som plassholder i `docker-compose.yml`)

## Test lokalt

```bash
npm install
mkdir -p public/vendor
cp node_modules/marked/marked.min.js public/vendor/
cp node_modules/dompurify/dist/purify.min.js public/vendor/
PIN=test123 node server.js   # → http://localhost:3000
```

(`public/vendor/` er gitignorert-vennlig bygge-artefakt; i prod gjøres kopieringen i Dockerfile.)

## Deploy på LXC

```bash
git pull && docker compose up -d --build
```
