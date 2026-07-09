import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const usersRouter = Router();
usersRouter.use(authenticate);

usersRouter.get(
  "/",
  requirePermission("users.view"),
  asyncHandler(async (req, res) => {
    const [users] = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.is_active, u.last_login_at,
        u.created_at, u.role_id, r.name AS role_name
       FROM users u JOIN roles r ON r.id = u.role_id
       ORDER BY u.name`
    );
    res.json({ users });
  })
);

usersRouter.post(
  "/",
  requirePermission("users.create"),
  asyncHandler(async (req, res) => {
    const input = z.object({
      name: z.string().trim().min(2),
      email: z.string().email(),
      phone: z.string().trim().optional().nullable(),
      role_id: z.coerce.number().int().positive(),
      password: z.string().min(8)
    }).parse(req.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const [result] = await pool.execute(
      `INSERT INTO users (name, email, phone, role_id, password_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [input.name, input.email.toLowerCase(), input.phone, input.role_id, passwordHash]
    );
    res.status(201).json({ id: result.insertId });
  })
);

usersRouter.patch(
  "/:id",
  requirePermission("users.edit"),
  asyncHandler(async (req, res) => {
    const input = z.object({
      name: z.string().trim().min(2),
      phone: z.string().trim().optional().nullable(),
      role_id: z.coerce.number().int().positive(),
      is_active: z.boolean()
    }).parse(req.body);
    await pool.execute(
      "UPDATE users SET name=?, phone=?, role_id=?, is_active=? WHERE id=?",
      [input.name, input.phone, input.role_id, input.is_active, req.params.id]
    );
    res.json({ message: "User updated." });
  })
);

