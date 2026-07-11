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
      title: "Oppdater reiseplan",
      description:
        "Erstatt hele reiseplanen med et nytt dokument. Hent planen med hent_plan først, gjør endringene dine, og send HELE det oppdaterte dokumentet tilbake her. Ikke utelat felter du ikke endret.\n\n" +
        "Bestillinger: en booking er { id, title, kind, url, location, ref, date, amount, paid, email } der kind er en av 'overnatting'|'transport'|'aktivitet'|'mat'|'annet' og location er en adresse eller kartlenke. De kan ligge (a) globalt i en section-blokk { type:'bookings', title, items:[...] }, eller (b) på en dag i days[].bookings:[...]. For enkeltendringer er legg_til_bestilling / rediger_bestilling / oppdater_dag mye raskere.",
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
  // Presist skjema, så agenten slipper å gjette strukturen. Legger
  // enten på en dag (dag_id satt) eller i den globale bestillings-
  // seksjonen (opprettes hvis den ikke finnes).
  server.registerTool(
    "legg_til_bestilling",
    {
      title: "Legg til bestilling",
      description:
        "Legg til én bestilling/betaling (overnatting, transport, aktivitet e.l.). Uten dag_id havner den i den globale seksjonen «Bestillinger & betalinger» (opprettes automatisk). Med dag_id (f.eks. 'd2') legges den på den dagen.",
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
        dag_id: z.string().optional().describe("legg på en dag i stedet for global seksjon"),
      },
    },
    async ({ tittel, type, lenke, ref, dato, belop, betalt, epost, sted, dag_id }) => {
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
      };
      let hvor;
      if (dag_id) {
        const day = (c.days || []).find((d) => d.id === dag_id);
        if (!day) return { content: [{ type: "text", text: `Fant ingen dag med id ${dag_id}.` }], isError: true };
        day.bookings = day.bookings || [];
        day.bookings.push(booking);
        hvor = `dag ${dag_id}`;
      } else {
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
        hvor = "global seksjon";
      }
      const rev = store.replaceContent(c);
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
        "Endre én dag uten å skrive om hele planen (mye raskere). Send bare feltene du vil endre i 'endringer' – andre felter beholdes. Eksempler: { rows: [{time,text},...] } for ny tidsplan, { date: 'Mandag 20. juli' } for å flytte datoen, { title, chip } for info. Mulige felt: title, date, chip, rows, maps ({label,url}), blocks ({md}), bookings, images. Hent planen med hent_plan først for å se gjeldende innhold.",
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
