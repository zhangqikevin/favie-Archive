import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { type Express } from "express";
import session from "express-session";
import MemoryStore from "memorystore";
import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { storage } from "./storage";
import type { User } from "@shared/schema";

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      password: string;
      selectedPlan: string | null;
      currentRestaurantId: string | null;
    }
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash, "hex");
  const derivedHash = scryptSync(password, salt, 64);
  return timingSafeEqual(hashBuffer, derivedHash);
}

const SessionStore = (MemoryStore as any)(session);

const SYSADMIN_PATH = /^\/api\/sysadmin/;

export function setupAuth(app: Express) {
  const customerSession = session({
    secret: process.env.SESSION_SECRET || "fallback-dev-secret",
    resave: false,
    saveUninitialized: false,
    store: new SessionStore({ checkPeriod: 86400000 }),
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
    },
  });

  // System Admin gets its own session cookie/store, scoped to /api/sysadmin/*.
  // Without this, logging in as an admin and a customer in the same browser
  // would fight over one session — passport's req.login() regenerates the
  // session on login, silently signing the other one out.
  const adminSession = session({
    name: "favie.admin.sid",
    secret: process.env.SESSION_SECRET || "fallback-dev-secret",
    resave: false,
    saveUninitialized: false,
    store: new SessionStore({ checkPeriod: 86400000 }),
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
    },
  });

  app.use("/api/sysadmin", adminSession);
  app.use((req, res, next) => (SYSADMIN_PATH.test(req.path) ? next() : customerSession(req, res, next)));

  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(
      { usernameField: "email" },
      async (email, password, done) => {
        try {
          const user = await storage.getUserByEmail(email);
          if (!user) {
            return done(null, false, { message: "No account found with that email." });
          }
          if (!verifyPassword(password, user.password)) {
            return done(null, false, { message: "Incorrect password." });
          }
          return done(null, user as Express.User);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  passport.serializeUser((user, done) => done(null, user.id));

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await storage.getUser(id);
      done(null, user as Express.User | undefined);
    } catch (err) {
      done(err);
    }
  });
}
