/**
 * Lets a customer attach an image to a chat message. The ZooWork agent has no way to
 * receive file bytes directly (see server/zoowork-agent.ts's notes on attachments being
 * unverified/unsupported) — but it does have a built-in `image` tool that can fetch and
 * actually view an image given a plain URL, restricted to image/png|jpeg|gif|webp. So we
 * host the upload ourselves and pass its URL along as plain text in the user's message.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import fssync from "node:fs";
import sharp from "sharp";
import type { Express, Request, Response } from "express";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function publicBaseUrl(): string {
  const base = process.env.MCP_PROXY_BASE_URL;
  if (!base) throw new Error("MCP_PROXY_BASE_URL is not set");
  return base.replace(/\/$/, "");
}

export function registerUploadRoutes(app: Express) {
  fssync.mkdirSync(UPLOADS_DIR, { recursive: true });

  // POST /api/chat/upload — re-encodes whatever image format the user attaches to PNG
  // (the only format the agent's `image` tool is guaranteed to accept, and re-encoding
  // also strips anything malformed in the source file) and serves it back at a public
  // URL under this app's own tunnel domain, so the agent's sandbox can actually fetch it.
  app.post("/api/chat/upload", async (req: Request, res: Response) => {
    if (!req.isAuthenticated() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const { dataUrl } = req.body as { dataUrl?: string };
      if (!dataUrl || typeof dataUrl !== "string") {
        return res.status(400).json({ message: "dataUrl is required" });
      }
      const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
      if (!match) return res.status(400).json({ message: "dataUrl must be a base64 data URL" });
      const [, mimeType, base64] = match;
      if (!mimeType.startsWith("image/")) {
        return res.status(400).json({ message: "Only image uploads are supported right now" });
      }
      const raw = Buffer.from(base64, "base64");
      if (raw.length > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ message: "Image is too large (8MB max)" });
      }

      const png = await sharp(raw).png().toBuffer();
      const fileName = `${randomUUID()}.png`;
      await fs.writeFile(path.join(UPLOADS_DIR, fileName), png);

      res.json({ url: `${publicBaseUrl()}/uploads/${fileName}` });
    } catch (err: any) {
      res.status(500).json({ message: err.message || "Failed to process upload" });
    }
  });

  // GET /uploads/:fileName — intentionally unauthenticated: the ZooWork agent sandbox
  // fetches these directly and has no session cookie. Filenames are server-generated
  // UUIDs, so this isn't a browsable directory of anything sensitive.
  app.get("/uploads/:fileName", (req: Request, res: Response) => {
    const fileName = String(req.params.fileName);
    if (!/^[0-9a-f-]+\.png$/i.test(fileName)) return res.status(404).end();
    res.sendFile(path.join(UPLOADS_DIR, fileName), (err) => {
      if (err) res.status(404).end();
    });
  });
}
