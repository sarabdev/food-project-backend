import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const partySchema = z.object({
  party_type: z.enum(["client", "customs_consignee", "clearing_agent", "transporter"]),
  name: z.string().trim().min(2),
  contact_person: z.string().trim().optional().nullable(),
  business_id: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  email: z.union([z.string().email(), z.literal("")]).optional().nullable(),
  address_line_1: z.string().trim().optional().nullable(),
  address_line_2: z.string().trim().optional().nullable(),
  city: z.string().trim().optional().nullable(),
  state_region: z.string().trim().optional().nullable(),
  country: z.string().trim().optional().nullable(),
  postal_code: z.string().trim().optional().nullable()
});

export const partiesRouter = Router();
partiesRouter.use(authenticate);

partiesRouter.get(
  "/",
  requirePermission("parties.view"),
  asyncHandler(async (req, res) => {
    const values = [];
    let where = "WHERE is_active = TRUE";
    if (req.query.type) {
      where += " AND party_type = ?";
      values.push(req.query.type);
    }
    const [parties] = await pool.execute(
      `SELECT * FROM parties ${where} ORDER BY name`,
      values
    );
    res.json({ parties });
  })
);

partiesRouter.post(
  "/",
  requirePermission("parties.create"),
  asyncHandler(async (req, res) => {
    const input = partySchema.parse(req.body);
    const [result] = await pool.execute(
      `INSERT INTO parties (
        party_type, name, contact_person, business_id, phone, email,
        address_line_1, address_line_2, city, state_region, country, postal_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Object.values(input)
    );
    res.status(201).json({ id: result.insertId });
  })
);

partiesRouter.put(
  "/:id",
  requirePermission("parties.edit"),
  asyncHandler(async (req, res) => {
    const input = partySchema.parse(req.body);
    await pool.execute(
      `UPDATE parties SET
        party_type=?, name=?, contact_person=?, business_id=?, phone=?, email=?,
        address_line_1=?, address_line_2=?, city=?, state_region=?, country=?, postal_code=?
       WHERE id=?`,
      [...Object.values(input), req.params.id]
    );
    res.json({ message: "Party updated." });
  })
);

partiesRouter.delete(
  "/:id",
  requirePermission("parties.delete"),
  asyncHandler(async (req, res) => {
    await pool.execute("UPDATE parties SET is_active = FALSE WHERE id = ?", [req.params.id]);
    res.status(204).end();
  })
);

