import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { pool } from "../database/pool.js";
import { authenticate } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const authRouter = Router();

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = z.object({
      email: z.string().email(),
      password: z.string().min(6)
    }).parse(req.body);

    const [rows] = await pool.execute(
      `SELECT u.*, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.email = ? AND u.is_active = TRUE`,
      [input.email.toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(input.password, user.password_hash))) {
      return res.status(401).json({ message: "Email or password is incorrect." });
    }

    await pool.execute("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);
    const token = jwt.sign({ sub: user.id }, env.jwtSecret, { expiresIn: "12h" });
    res.json({ token });
  })
);

authRouter.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

