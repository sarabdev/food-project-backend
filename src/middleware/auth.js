import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { pool } from "../database/pool.js";

export async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ message: "Authentication required." });

    const payload = jwt.verify(token, env.jwtSecret);
    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.role_id, r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ? AND u.is_active = TRUE`,
      [payload.sub]
    );
    if (!rows[0]) return res.status(401).json({ message: "Account is unavailable." });

    const [permissions] = await pool.execute(
      `SELECT p.permission_key
       FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [rows[0].role_id]
    );
    req.user = {
      ...rows[0],
      permissions: permissions.map((permission) => permission.permission_key)
    };
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired session." });
  }
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user?.permissions.includes(permission)) {
      return res.status(403).json({ message: "You do not have permission for this action." });
    }
    next();
  };
}

export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!permissions.some((permission) => req.user?.permissions.includes(permission))) {
      return res.status(403).json({ message: "You do not have permission for this action." });
    }
    next();
  };
}
