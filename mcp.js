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
        "Bestillinger: en booking er { id, title, kind, url, ref, date, amount, paid, email } der kind er en av 'overnatting'|'transport'|'aktivitet'|'mat'|'annet'. De kan ligge (a) globalt i en section-blokk { type:'bookings', title, items:[...] }, eller (b) på en dag i days[].bookings:[...]. For å legge til én enkelt bestilling er verktøyet legg_til_bestilling enklere.",
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
        dag_id: z.string().optional().describe("legg på en dag i stedet for global seksjon"),
      },
    },
    async ({ tittel, type, lenke, ref, dato, belop, betalt, epost, dag_id }) => {
      const c = store.getContent();
      const booking = {
        id: uid(),
        title: tittel,
        kind: type || "annet",
        url: lenke || "",
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
