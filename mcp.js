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
        "Erstatt hele reiseplanen med et nytt dokument. Hent planen med hent_plan først, gjør endringene dine, og send HELE det oppdaterte dokumentet tilbake her. Ikke utelat felter du ikke endret.",
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
