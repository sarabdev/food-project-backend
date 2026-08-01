import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const usersRouter = Router();
usersRouter.use(authenticate);

const createUserSchema = z.object({
  name: z.string().trim()
    .min(2, "Name must contain at least 2 characters.")
    .max(120, "Name cannot exceed 120 characters."),
  email: z.string().trim()
    .min(1, "Email address is required.")
    .email("Enter a valid email address."),
  phone: z.string().trim()
    .max(40, "Phone number cannot exceed 40 characters.")
    .optional().nullable(),
  role_id: z.coerce.number()
    .int("Select a valid role.")
    .positive("Select a role."),
  password: z.string()
    .min(8, "Password must contain at least 8 characters.")
    .max(72, "Password cannot exceed 72 characters.")
});

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
    const input = createUserSchema.parse(req.body);
    const normalizedEmail = input.email.toLowerCase();
    const [[existingUser]] = await pool.execute(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [normalizedEmail]
    );
    if (existingUser) {
      return res.status(409).json({
        message: "This email address is already registered.",
        errors: { fieldErrors: { email: ["This email address is already registered."] } }
      });
    }
    const passwordHash = await bcrypt.hash(input.password, 12);
    const [result] = await pool.execute(
      `INSERT INTO users (name, email, phone, role_id, password_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [input.name, normalizedEmail, input.phone || null, input.role_id, passwordHash]
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
