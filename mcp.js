// ============================================================
//  MCP-server for roadtrip-planen
//  -----------------------------------------------------------
//  Eksponerer reiseplanen som MCP-verktøy slik at Claude (i appen,
//  via en custom connector) kan LESE og REDIGERE den i en samtale.
//
//  Transport: Streamable HTTP (moderne remote-MCP), stateless modus –
//  altså ingen sesjon å holde styr på; hvert kall er selvstendig.
//
//  Sikkerhet: serveren mountes på en HEMMELIG sti (MCP_PATH), og den
//  ligger FØR PIN-vakten i server.js. Den som kjenner den hemmelige
//  URL-en kan redigere planen – auth "light" for en ferieplan.
// ============================================================

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const express = require("express");

const uid = () => "b" + Math.random().toString(36).slice(2, 9);

// Finn en bestilling på tvers av globale bookings-blokker og dagers bookings.
function findBooking(c, id) {
  const lists = [];
  for (const s of c.sections || []) for (const b of s.blocks || []) if (b.type === "bookings" && Array.isArray(b.items)) lists.push(b.items);
  for (const d of c.days || []) if (Array.isArray(d.bookings)) lists.push(d.bookings);
  for (const list of lists) {
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) return { list, idx, item: list[idx] };
  }
  return null;
}

// Finn et sjekklistepunkt (i seksjoner ELLER på en dags egen sjekkliste) på id.
function findCheckItem(c, id) {
  const scan = (blocks) => {
    for (const b of blocks || []) {
      if (b.type !== "checklist" || !Array.isArray(b.items)) continue;
      const idx = b.items.findIndex((x) => x.id === id);
      if (idx >= 0) return { list: b.items, idx, item: b.items[idx] };
    }
    return null;
  };
  for (const s of c.sections || []) { const r = scan(s.blocks); if (r) return r; }
  for (const d of c.days || []) { const r = scan(d.blocks); if (r) return r; }
  return null;
}

// Bygger en fersk McpServer med alle verktøyene registrert.
// I stateless modus lager vi én server + transport per request,
// så dette kalles på hvert POST-kall (billig – to brukere totalt).
function buildServer(store) {
  const server = new McpServer({
    name: "roadtrip-2026",
    version: "1.0.0",
  });

  // --- Verktøy 1: les hele planen -------------------------------
  server.registerTool(
    "hent_plan",
    {
      title: "Hent reiseplan",
      description:
        "Hent hele roadtrip-planen som JSON (dager, tidsplaner, seksjoner, sjekklister, notater). Bruk denne først for å få oversikt før du endrer noe.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(store.getContent(), null, 2) }],
    })
  );

  // --- Verktøy 2: erstatt hele planen ---------------------------
  // Enkleste modell: hent plan → endre → send hele dokumentet tilbake.
  // Vi setter rev automatisk (siste skriving vinner). For to personer
  // som redigerer en ferieplan er det helt greit.
  server.registerTool(
    "oppdater_plan",
    {
      title: "Oppdater hele planen (siste utvei)",
      description:
        "SISTE UTVEI – treg, fordi hele planen (~20 KB) må skrives om. Bruk KUN for strukturelle endringer som ingen av de spesifikke verktøyene dekker: legge til / fjerne / omorganisere hele dager eller seksjoner, eller endre hero/intro/footer.\n\n" +
        "For ALT annet, bruk de raske verktøyene i stedet:\n" +
        "• Endre én dag (tidsplan/rader, dato, tittel, merkelapp, tips, kartlenker): oppdater_dag\n" +
        "• Bestillinger: legg_til_bestilling / rediger_bestilling / merk_betalt / slett_bestilling\n" +
        "• Sjekklister (pakkeliste, booking-sjekkliste): legg_til_punkt / rediger_punkt / slett_punkt / kryss_av\n" +
        "• Dagsnotat: sett_notat\n\n" +
        "Hvis du likevel bruker denne: hent planen med hent_plan først, gjør endringene, og send HELE dokumentet tilbake – ikke utelat felter.\n\n" +
        "Datamodell for bestillinger: { id, title, kind, url, location, ref, date, amount, paid, email, day }, kind ∈ overnatting|transport|aktivitet|mat|annet, location = adresse/kartlenke, day = valgfri dag-id som lager hopp-lenke. Bestillinger ligger ALLTID samlet i ÉN global section-blokk { type:'bookings', items:[...] } – aldri på en dag (days[].bookings brukes ikke).",
      inputSchema: {
        plan: z
          .object({
            hero: z.any().optional(),
            intro: z.any().optional(),
            days: z.array(z.any()),
            sections: z.array(z.any()),
            notes: z.any().optional(),
            footer: z.any().optional(),
          })
          .passthrough(),
      },
    },
    async ({ plan }) => {
      const rev = store.replaceContent(plan);
      return {
        content: [{ type: "text", text: `Planen er lagret (ny rev: ${rev}).` }],
      };
    }
  );

  // --- Verktøy 3: kryss av / av-kryss et sjekklistepunkt --------
  server.registerTool(
    "kryss_av",
    {
      title: "Kryss av punkt",
      description:
        "Huk av eller fjern haken på et sjekklistepunkt. Bruk id-en fra planen (f.eks. 'pk01', 'bk03').",
      inputSchema: {
        id: z.string().describe("id-en til sjekklistepunktet"),
        verdi: z.boolean().describe("true = kryss av, false = fjern haken"),
      },
    },
    async ({ id, verdi }) => {
      const ok = store.applyCheck(id, verdi);
      return {
        content: [
          { type: "text", text: ok ? `Oppdatert ${id} = ${verdi}.` : `Fant ikke punkt med id ${id}.` },
        ],
        isError: !ok,
      };
    }
  );

  // --- Verktøy 4: sett felles-notat på en dag ------------------
  server.registerTool(
    "sett_notat",
    {
      title: "Sett dagsnotat",
      description:
        "Skriv (eller tøm) det felles notatet på en dag. Bruk dagens id (f.eks. 'd1'). Tom tekst sletter notatet.",
      inputSchema: {
        id: z.string().describe("dagens id, f.eks. 'd1'"),
        tekst: z.string().describe("notat-teksten (tom = slett)"),
      },
    },
    async ({ id, tekst }) => {
      store.applyNote(id, tekst);
      return { content: [{ type: "text", text: `Notat lagret på ${id}.` }] };
    }
  );

  // --- Verktøy 5: legg til én bestilling -----------------------
  // ALLE bestillinger/betalinger samles i ÉN global seksjon
  // «Bestillinger & betalinger». En bestilling legges ALDRI inne på en
  // dag – knytt den heller til en dag med knyttet_dag (gir hopp-lenker).
  server.registerTool(
    "legg_til_bestilling",
    {
      title: "Legg til bestilling",
      description:
        "Legg til én bestilling/betaling (overnatting, transport, aktivitet, billett e.l.). " +
        "Den havner ALLTID i den ene globale seksjonen «Bestillinger & betalinger» – aldri inne på en enkelt dag. " +
        "Vil du at den skal vises/lenkes på en bestemt dag, sett knyttet_dag='d7' (lager automatisk hopp-lenker begge veier). " +
        "IKKE bruk oppdater_dag med et bookings-felt for dette.",
      inputSchema: {
        tittel: z.string().describe("f.eks. 'Airbnb – Stavanger'"),
        type: z.enum(["overnatting", "transport", "aktivitet", "mat", "annet"]).optional().describe("standard: annet"),
        lenke: z.string().optional().describe("URL til Airbnb/booking"),
        ref: z.string().optional().describe("bekreftelsesnummer"),
        dato: z.string().optional().describe("f.eks. '19.–20. juli'"),
        belop: z.string().optional().describe("f.eks. '2 400 kr'"),
        betalt: z.boolean().optional().describe("standard: false"),
        epost: z.string().optional().describe("lenke til bekreftelses-epost (Gmail-søk, mailto e.l.)"),
        sted: z.string().optional().describe("adresse eller kartlenke – blir en klikkbar kart-lenke"),
        knyttet_dag: z.string().optional().describe("dag-id (f.eks. 'd7') bestillingen gjelder – gir hopp-lenker mellom dagen og bestillingen"),
      },
    },
    async ({ tittel, type, lenke, ref, dato, belop, betalt, epost, sted, knyttet_dag }) => {
      const c = store.getContent();
      const booking = {
        id: uid(),
        title: tittel,
        kind: type || "annet",
        url: lenke || "",
        location: sted || "",
        ref: ref || "",
        date: dato || "",
        amount: belop || "",
        paid: !!betalt,
        email: epost || "",
        day: knyttet_dag || undefined,
      };
      let block = null;
      for (const s of c.sections || []) {
        for (const b of s.blocks || []) if (b.type === "bookings") { block = b; break; }
        if (block) break;
      }
      if (!block) {
        block = { type: "bookings", title: "", items: [] };
        c.sections.push({ id: "bestillinger", title: "Bestillinger & betalinger", blocks: [block] });
      }
      block.items = block.items || [];
      block.items.push(booking);
      const rev = store.replaceContent(c);
      const hvor = knyttet_dag ? `global seksjon, lenket til ${knyttet_dag}` : "global seksjon";
      return { content: [{ type: "text", text: `La til «${tittel}» (${hvor}, rev ${rev}).` }] };
    }
  );

  // --- Verktøy 6: oppdater én dag (rask – ikke hele planen) -----
  // Hovedverktøyet for «gjøre om en dag». Send BARE feltene som endres.
  server.registerTool(
    "oppdater_dag",
    {
      title: "Oppdater én dag",
      description:
        "Endre én dag uten å skrive om hele planen (mye raskere). Send bare feltene du vil endre i 'endringer' – andre felter beholdes. Eksempler: { rows: [{time,text},...] } for ny tidsplan, { date: 'Mandag 20. juli' } for å flytte datoen, { title, chip } for info. Mulige felt: title, date, chip, rows, maps ({label,url}), blocks, images. En blokk er enten en tips/tekst-blokk { md } ELLER en egen dags-sjekkliste { type:'checklist', title, items:[{id,text,done}] } (uavhengige haker fra pakkelista – bra for «pakk til dagsturen»). BESTILLINGER hører IKKE hjemme på en dag – bruk legg_til_bestilling med knyttet_dag i stedet. Hent planen med hent_plan først for å se gjeldende innhold.",
      inputSchema: {
        dag_id: z.string().describe("dagens id, f.eks. 'd4'"),
        endringer: z.object({}).passthrough().describe("kun feltene som skal endres"),
      },
    },
    async ({ dag_id, endringer }) => {
      const c = store.getContent();
      const day = (c.days || []).find((d) => d.id === dag_id);
      if (!day) return { content: [{ type: "text", text: `Fant ingen dag med id ${dag_id}.` }], isError: true };
      Object.assign(day, endringer);
      day.id = dag_id; // id skal aldri endres
      const rev = store.replaceContent(c);
      return { content: [{ type: "text", text: `Dag ${dag_id} oppdatert (rev ${rev}).` }] };
    }
  );

  // --- Verktøy 7: rediger en bestilling ------------------------
  server.registerTool(
    "rediger_bestilling",
    {
      title: "Rediger bestilling",
      description: "Endre felter på en eksisterende bestilling (finn id med hent_plan). Send bare feltene som skal endres.",
      inputSchema: {
        id: z.string().describe("bestillingens id"),
        endringer: z
          .object({
            title: z.string().optional(),
            kind: z.enum(["overnatting", "transport", "aktivitet", "mat", "annet"]).optional(),
            url: z.string().optional(),
            location: z.string().optional().describe("adresse eller kartlenke"),
            ref: z.string().optional(),
            date: z.string().optional(),
            amount: z.string().optional(),
            paid: z.boolean().optional(),
            email: z.string().optional(),
            day: z.string().optional().describe("dag-id bestillingen knyttes til (hopp-lenker)"),
          })
          .passthrough(),
      },
    },
    async ({ id, endringer }) => {
      const c = store.getContent();
      const found = findBooking(c, id);
      if (!found) return { content: [{ type: "text", text: `Fant ingen bestilling med id ${id}.` }], isError: true };
      Object.assign(found.item, endringer);
      found.item.id = id;
      const rev = store.replaceContent(c);
      return { content: [{ type: "text", text: `Bestilling ${id} oppdatert (rev ${rev}).` }] };
    }
  );

  // --- Verktøy 8: merk bestilling betalt/ubetalt ---------------
  server.registerTool(
    "merk_betalt",
    {
      title: "Merk betalt",
      description: "Sett en bestilling som betalt eller ikke betalt.",
      inputSchema: {
        id: z.string().describe("bestillingens id"),
        betalt: z.boolean().describe("true = betalt, false = ikke betalt"),
      },
    },
    async ({ id, betalt }) => {
      const c = store.getContent();
      const found = findBooking(c, id);
      if (!found) return { content: [{ type: "text", text: `Fant ingen bestilling med id ${id}.` }], isError: true };
      found.item.paid = betalt;
      const rev = store.replaceContent(c);
      return { content: [{ type: "text", text: `Bestilling ${id} markert ${betalt ? "betalt" : "ikke betalt"} (rev ${rev}).` }] };
    }
  );

  // --- Verktøy 9: slett en bestilling --------------------------
  server.registerTool(
    "slett_bestilling",
    {
      title: "Slett bestilling",
      description: "Fjern en bestilling (finn id med hent_plan).",
      inputSchema: { id: z.string().describe("bestillingens id") },
    },
    async ({ id }) => {
      const c = store.getContent();
      const found = findBooking(c, id);
      if (!found) return { content: [{ type: "text", text: `Fant ingen bestilling med id ${id}.` }], isError: true };
      found.list.splice(found.idx, 1);
      const rev = store.replaceContent(c);
      return { content: [{ type: "text", text: `Bestilling ${id} slettet (rev ${rev}).` }] };
    }
  );

  // --- Verktøy 10: legg til sjekklistepunkt --------------------
  server.registerTool(
    "legg_til_punkt",
    {
      title: "Legg til sjekklistepunkt",
      description:
        "Legg til et nytt punkt i samme sjekkliste som et eksisterende punkt. Oppgi id-en til et punkt som allerede finnes i lista (f.eks. 'bk13' for booking-sjekklista, 'pk10' for en pakkeliste-gruppe), så havner det nye punktet nederst i den samme lista. Teksten kan bruke markdown.",
      inputSchema: {
        i_samme_liste_som: z.string().describe("id-en til et punkt i mål-lista, f.eks. 'bk13'"),
        tekst: z.string().describe("punktteksten (markdown ok)"),
      },
    },
    async ({ i_samme_liste_som, tekst }) => {
      const c = store.getContent();
      const found = findCheckItem(c, i_samme_liste_som);
      if (!found) return { content: [{ type: "text", text: `Fant ingen sjekkliste med punkt-id ${i_samme_liste_som}.` }], isError: true };
      const nyId = "i" + Math.random().toString(36).slice(2, 9);
      found.list.push({ id: nyId, text: tekst, done: false });
      const rev = store.replaceContent(c);
      return { content: [{ type: "text", text: `La til punkt ${nyId} (rev ${rev}).` }] };
    }
  );

  // --- Verktøy 11: rediger teksten på et sjekklistepunkt -------
  server.registerTool(
    "rediger_punkt",
    {
      title: "Rediger sjekklistepunkt",
      description: "Endre teksten på et sjekklistepunkt (finn id med hent_plan). For å huke av/på, bruk kryss_av.",
      inputSchema: {
        id: z.string().describe("punktets id, f.eks. 'bk05'"),
        tekst: z.string().describe("ny tekst (markdown ok)"),
      },
    },
    async ({ id, tekst }) => {
      const c = store.getContent();
      const found = findCheckItem(c, id);
      if (!found) return { content: [{ type: "text", text: `Fant ingen punkt med id ${id}.` }], isError: true };
      found.item.text = tekst;
      const rev = store.replaceContent(c);
      return { content: [{ type: "text", text: `Punkt ${id} oppdatert (rev ${rev}).` }] };
    }
  );

  // --- Verktøy 12: slett et sjekklistepunkt --------------------
  server.registerTool(
    "slett_punkt",
    {
      title: "Slett sjekklistepunkt",
      description: "Fjern et sjekklistepunkt (finn id med hent_plan).",
      inputSchema: { id: z.string().describe("punktets id") },
    },
    async ({ id }) => {
      const c = store.getContent();
      const found = findCheckItem(c, id);
      if (!found) return { content: [{ type: "text", text: `Fant ingen punkt med id ${id}.` }], isError: true };
      found.list.splice(found.idx, 1);
      const rev = store.replaceContent(c);
      return { content: [{ type: "text", text: `Punkt ${id} slettet (rev ${rev}).` }] };
    }
  );

  return server;
}

// Mounter MCP-endepunktet på app-en under den hemmelige stien.
// `store` gir verktøyene tilgang til innholdet uten at mcp.js
// trenger å vite hvordan det lagres på disk.
function mountMcp(app, store, mcpPath) {
  // Stateless Streamable HTTP: nytt server+transport-par per request.
  app.post(mcpPath, express.json({ limit: "5mb" }), async (req, res) => {
    const server = buildServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.sendStatus(500);
    }
  });

  // GET/DELETE gir ikke mening i stateless modus – svar 405.
  const methodNotAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  app.get(mcpPath, methodNotAllowed);
  app.delete(mcpPath, methodNotAllowed);
}

module.exports = { mountMcp };
