import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";

declare module "express-session" {
  interface SessionData {
    adminUserId?: string;
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminId = req.session.adminUserId;
  if (!adminId) return res.status(401).json({ message: "Not authenticated" });
  const admin = await storage.getAdminById(adminId);
  if (!admin) {
    req.session.adminUserId = undefined;
    return res.status(401).json({ message: "Not authenticated" });
  }
  (req as any).admin = admin;
  next();
}
