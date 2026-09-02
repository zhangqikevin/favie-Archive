import "./log-buffer"; // must be first — patches console.*
import express, { type Request, Response, NextFunction, Router } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupAuth } from "./auth";

const app = express();
const httpServer = createServer(app);

// Allow long-running API calls (e.g. agent chat with multi-step tool use) to
// outlive Node's defaults. Most upstream timeouts (Replit / Cloudflare Tunnel)
// are still shorter — for truly long ops the agent must use async cron delivery.
httpServer.requestTimeout = 10 * 60 * 1000;  // 10 min (default 5)
httpServer.headersTimeout = 11 * 60 * 1000;  // must be >= requestTimeout
httpServer.keepAliveTimeout = 65 * 1000;     // > typical proxy 60s

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ========== UBEREATS WEBHOOK ROUTES (BEFORE ANY MIDDLEWARE) ==========
// These routes must be registered FIRST to avoid Vite fallback

const uberEatsRouter = Router();

// Webhooks - support ALL methods
uberEatsRouter.all("/webhook/order-cancelled", (req, res) => {
  console.log("📨 Webhook received - Order Cancelled:", req.body);
  res.status(200).json({ received: true, method: req.method });
});

uberEatsRouter.all("/webhook/order-notification", (req, res) => {
  console.log("📨 Webhook received - Order Notification:", req.body);
  res.status(200).json({ received: true, method: req.method });
});

// Integration Config
uberEatsRouter.post("/api/integration/activate", (_req, res) => {
  console.log("✅ Integration activated");
  res.status(200).json({
    status: "success",
    message: "Integration activated",
    client_id: process.env.UBEREATS_CLIENT_ID || "demo-client",
  });
});

uberEatsRouter.get("/api/integration/details", (_req, res) => {
  res.status(200).json({
    status: "success",
    integration: {
      client_id: process.env.UBEREATS_CLIENT_ID || "demo-client",
      status: "active",
      webhooks_configured: true,
      store_id: "demo-store-001",
    },
  });
});

uberEatsRouter.delete("/api/integration", (_req, res) => {
  console.log("✅ Integration removed");
  res.status(204).send();
});

uberEatsRouter.put("/api/integration", (req, res) => {
  console.log("✅ Integration updated:", req.body);
  res.status(200).json({
    status: "success",
    message: "Integration details updated",
  });
});

// Menu
uberEatsRouter.post("/api/menu/upload", (req, res) => {
  console.log("✅ Menu uploaded:", req.body);
  res.status(200).json({
    status: "success",
    menu_id: "menu-" + Date.now(),
    items_processed: req.body.items?.length || 0,
  });
});

uberEatsRouter.put("/api/menu/item/:itemId", (req, res) => {
  console.log("✅ Item updated:", req.params.itemId, req.body);
  res.status(200).json({
    status: "success",
    item_id: req.params.itemId,
    message: "Item updated successfully",
  });
});

// Orders - SPECIFIC ROUTES FIRST (before :orderId)
uberEatsRouter.post("/api/order/:orderId/accept", (req, res) => {
  console.log("✅ Order accepted:", req.params.orderId);
  res.status(200).json({
    status: "success",
    order_id: req.params.orderId,
    state: "ACCEPTED",
  });
});

uberEatsRouter.post("/api/order/:orderId/deny", (req, res) => {
  console.log("✅ Order denied:", req.params.orderId);
  res.status(200).json({
    status: "success",
    order_id: req.params.orderId,
    state: "DENIED",
  });
});

uberEatsRouter.post("/api/order/:orderId/cancel", (req, res) => {
  console.log("✅ Order cancelled:", req.params.orderId);
  res.status(200).json({
    status: "success",
    order_id: req.params.orderId,
    state: "CANCELLED",
  });
});

uberEatsRouter.put("/api/order/:orderId", (req, res) => {
  console.log("✅ Order updated:", req.params.orderId, req.body);
  res.status(200).json({
    status: "success",
    order_id: req.params.orderId,
    message: "Order updated",
  });
});

// Generic order get - MUST BE LAST for /api/order/*
uberEatsRouter.get("/api/order/:orderId", (req, res) => {
  res.status(200).json({
    status: "success",
    order: {
      id: req.params.orderId,
      status: "pending",
      items: [],
      total: 0,
      customer: { name: "Demo Customer" },
      created_at: new Date().toISOString(),
    },
  });
});

// Store
uberEatsRouter.put("/api/store/holiday-hours", (req, res) => {
  console.log("✅ Holiday hours updated:", req.body);
  res.status(200).json({
    status: "success",
    message: "Holiday hours updated",
    store_id: "demo-store-001",
  });
});

// Mount router BEFORE any other middleware
app.use(uberEatsRouter);
console.log("🚀 UberEats routes registered");
// =====================================================================

app.use(
  express.json({
    // Default 100kb is too small for a base64-encoded chat image upload (~33% larger
    // than raw bytes); 12mb comfortably covers uploads.ts's 8MB raw-image cap.
    limit: "12mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

setupAuth(app);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      // Skip noisy polling endpoints from log buffer entirely
      if (req.method === "GET" && (path.startsWith("/api/chat/") || path === "/api/admin/logs")) {
        return;
      }
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        const body = JSON.stringify(capturedJsonResponse);
        logLine += ` :: ${body.length > 300 ? body.slice(0, 300) + "..." : body}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();