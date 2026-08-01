import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const bankAccountSchema = z.object({
  account_name: z.string().trim().min(2).max(120),
  beneficiary_name: z.string().trim().min(2).max(180),
  bank_name: z.string().trim().min(2).max(180),
  branch_name: z.string().trim().max(180).optional().nullable(),
  account_number: z.string().trim().max(100).optional().nullable(),
  iban: z.string().trim().max(100).optional().nullable(),
  swift_code: z.string().trim().max(60).optional().nullable(),
  currency: z.string().trim().min(3).max(10).default("USD"),
  correspondent_bank: z.string().trim().max(180).optional().nullable(),
  correspondent_account: z.string().trim().max(100).optional().nullable(),
  correspondent_swift_code: z.string().trim().max(60).optional().nullable(),
  instructions: z.string().trim().max(500).optional().nullable()
});

const columns = [
  "account_name", "beneficiary_name", "bank_name", "branch_name", "account_number",
  "iban", "swift_code", "currency", "correspondent_bank", "correspondent_account",
  "correspondent_swift_code", "instructions"
];

function values(input) {
  return columns.map((column) => input[column] || null);
}

export const bankAccountsRouter = Router();
bankAccountsRouter.use(authenticate);

bankAccountsRouter.get(
  "/",
  requirePermission("bank_accounts.view"),
  asyncHandler(async (_req, res) => {
    const [bankAccounts] = await pool.query(
      "SELECT * FROM bank_accounts WHERE is_active = TRUE ORDER BY account_name"
    );
    res.json({ bank_accounts: bankAccounts });
  })
);

bankAccountsRouter.post(
  "/",
  requirePermission("bank_accounts.create"),
  asyncHandler(async (req, res) => {
    const input = bankAccountSchema.parse(req.body);
    const [result] = await pool.execute(
      `INSERT INTO bank_accounts (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      values(input)
    );
    res.status(201).json({ id: result.insertId });
  })
);

bankAccountsRouter.put(
  "/:id",
  requirePermission("bank_accounts.edit"),
  asyncHandler(async (req, res) => {
    const input = bankAccountSchema.parse(req.body);
    const [result] = await pool.execute(
      `UPDATE bank_accounts SET ${columns.map((column) => `${column}=?`).join(", ")}
       WHERE id=? AND is_active=TRUE`,
      [...values(input), req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: "Bank account not found." });
    res.json({ message: "Bank account updated." });
  })
);

bankAccountsRouter.delete(
  "/:id",
  requirePermission("bank_accounts.delete"),
  asyncHandler(async (req, res) => {
    const [[usage]] = await pool.execute(
      "SELECT COUNT(*) AS contract_count FROM export_orders WHERE bank_account_id = ?",
      [req.params.id]
    );
    if (usage.contract_count) {
      return res.status(409).json({ message: "This bank account is used by sales contracts and cannot be removed." });
    }
    await pool.execute("UPDATE bank_accounts SET is_active=FALSE WHERE id=?", [req.params.id]);
    res.status(204).end();
  })
);
