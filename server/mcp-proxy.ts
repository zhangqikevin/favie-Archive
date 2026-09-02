/**
 * Public, unauthenticated MCP reverse proxy — the ZooWork "option 1" workaround
 * documented in the SDK's not-supported notes: ZooWork's `mcp.url` must be a
 * public, unauthenticated endpoint, so we host one here and inject the real
 * customer's key server-side before forwarding to the actual (authenticated)
 * MCP server. Security comes from the unguessable `proxyToken` in the path,
 * not from any auth check on this route.
 */
import type { Express, Request, Response as ExpressResponse } from "express";
import { storage } from "./storage";
import { decryptSecret } from "./crypto";

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "host", "connection", "content-length", "authorization",
]);
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "content-encoding", "content-length", "transfer-encoding", "connection",
]);

export function registerMcpProxyRoutes(app: Express) {
  app.all("/mcp/:token", async (req: Request, res: ExpressResponse) => {
    const cred = await storage.getUserMcpCredentialByToken(String(req.params.token));
    if (!cred) {
      res.status(404).json({ error: "unknown proxy token" });
      return;
    }
    const server = await storage.getMcpServer(cred.mcpServerId);
    if (!server) {
      res.status(404).json({ error: "mcp server not found" });
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (!value || HOP_BY_HOP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }

    let targetUrl = server.targetUrl;
    if (server.authStyle === "query_param_shared_key") {
      if (!server.encryptedAdminKey) {
        res.status(500).json({ error: "mcp server missing admin key" });
        return;
      }
      const adminKey = decryptSecret(server.encryptedAdminKey);
      headers.set(server.authHeaderName, `${server.authScheme}${adminKey}`);
      const routingId = decryptSecret(cred.encryptedKey);
      const url = new URL(server.targetUrl);
      url.searchParams.set("user_id", routingId);
      targetUrl = url.toString();
    } else {
      const realKey = decryptSecret(cred.encryptedKey);
      headers.set(server.authHeaderName, `${server.authScheme}${realKey}`);
    }

    const hasBody = !["GET", "HEAD"].includes(req.method);
    let body: string | undefined;
    if (hasBody) {
      body = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : undefined;
      if (body) headers.set("content-type", "application/json");
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
      });
    } catch (err: any) {
      res.status(502).json({ error: `mcp upstream fetch failed: ${err?.message ?? err}` });
      return;
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) res.setHeader(name, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      res.end();
    }
  });
}
