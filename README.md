# Roadtrip 2026 – delt, redigerbar reiseplan

Selvhostet reiseplan for turen 18.–29. juli 2026. **Alt innhold redigeres direkte
på nettsiden** – dager, tidspunkter, rader, tips, sjekklister, bilder. Delt
mellom alle som er innlogget, med PIN.

## Funksjoner

- **Redigeringsmodus** («✏️ Rediger»-knapp): endre alt – tittel, dager, tidsrader
  (legg til/slett/flytt), kartlenker, tips-blokker, sjekklister, seksjoner.
  Legg til nye dager og seksjoner. Lagres med «💾 Lagre».
- **Markdown overalt**: **fet**, [lenker](…), lister – og GitHub-admonitions:

  ```markdown
  > [!TIP]
  > Dette blir en grønn tipsboks.
  ```

  Støtter `[!TIP]`, `[!NOTE]`, `[!WARNING]`, `[!IMPORTANT]`, `[!CAUTION]`.
- **Bildeopplasting**: last opp flere bilder per dag (vanlig filvelger,
  funker fra kamerarullen på mobil). Lagres i `data/uploads/`.
- **Delte sjekkbokser og notater**: synkes live (uten å måtte inn i redigeringsmodus).
- **Konfliktvern**: lagrer to personer samtidig, får sistemann beskjed (409)
  i stedet for at endringer overskrives i stillhet.
- PIN-innlogging, sesjon 120 dager. All tilstand i `data/` – overlever
  restart og image-oppdateringer.

## Oppsett på Proxmox LXC

```bash
git clone <dette repoet> roadtrip && cd roadtrip
# 1. Sett PIN i docker-compose.yml
# 2. Ev. endre port (standard 8080)
docker compose up -d --build
```

Test: `http://<lxc-ip>:8080` — pek deretter subdomenet mot LXC-en i reverse
proxyen din og **skru på HTTPS** (PIN sendes ved innlogging).

Ved første oppstart kopieres `default-content.json` til `data/content.json`.
Etter det er `data/content.json` sannheten – `default-content.json` brukes aldri
igjen (så en ny deploy overskriver ikke endringene deres).

## API (for skript, automatisering og Claude)

Alle endepunkter godtar `Authorization: Bearer <PIN>` i stedet for cookie —
dermed kan hvem som helst med PIN-en (deg, et skript, eller en AI-agent)
redigere planen programmatisk:

```bash
BASE=https://ferie.dittdomene.no
PIN=hemmelig

# Hent hele planen
curl -H "Authorization: Bearer $PIN" $BASE/api/content

# Endre planen: hent, modifiser JSON (behold rev-feltet!), send tilbake
curl -X PUT -H "Authorization: Bearer $PIN" -H "Content-Type: application/json" \
     --data @plan.json $BASE/api/content
# → 409 hvis noen lagret i mellomtiden (hent på nytt og prøv igjen)

# Huk av et sjekklistepunkt
curl -X POST -H "Authorization: Bearer $PIN" -H "Content-Type: application/json" \
     -d '{"id":"bk01","value":true}' $BASE/api/check

# Skriv dagsnotat
curl -X POST -H "Authorization: Bearer $PIN" -H "Content-Type: application/json" \
     -d '{"id":"d1","text":"Husk gass!"}' $BASE/api/note

# Last opp bilde
curl -X POST -H "Authorization: Bearer $PIN" --data-binary @kart.png \
     "$BASE/api/upload?name=kart.png"   # → {"url":"/uploads/…"}
```

Tips: skal Claude redigere planen, gi den URL + PIN og be den bruke
`GET /api/content` → modifisere JSON → `PUT /api/content`.

### Datamodell (content.json)

```
hero {title, subtitle, badge}
intro                      markdown-streng
days[] {id, title, date, chip,
        rows[]   {time, text(markdown)},
        maps[]   {label, url},
        images[] {url, caption},
        blocks[] {md}}
sections[] {id, title, blocks[]}
  blocks: {type:"md", md} eller
          {type:"checklist", title, items[]{id, text, done}}
notes {dagId: tekst}
footer                     markdown-streng
rev                        versjonsnummer (styres av serveren)
```

## Drift

- **Backup**: ta vare på `data/` (content.json + uploads/)
- Bytt PIN: endre i `docker-compose.yml`, `docker compose up -d`
  (slett `data/secret` for å logge ut alle enheter)
- Slettede bilder fjernes fra planen, men fila blir liggende i
  `data/uploads/` – rydd manuelt ved behov
- Logger: `docker compose logs -f`
- Tilbakestill alt innhold: stopp containeren, slett `data/content.json`, start
