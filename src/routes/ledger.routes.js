import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const paymentSchema = z.object({
  order_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive().max(999999999999.99),
  payment_date: z.string().date(),
  reference_number: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable()
});

const orderTotalsSql = `
  SELECT o.id, o.client_id, o.invoice_number, o.contract_date, o.status,
    o.currency, o.advance_percentage,
    COALESCE(SUM(
      CASE WHEN i.is_sample = FALSE
        THEN i.quantity * i.client_price_per_carton
        ELSE 0
      END
    ), 0) AS order_total
  FROM export_orders o
  LEFT JOIN export_order_items i ON i.export_order_id = o.id
  GROUP BY o.id
`;

const paymentTotalsSql = `
  SELECT export_order_id, COALESCE(SUM(amount), 0) AS additional_received
  FROM order_payments
  GROUP BY export_order_id
`;

export const ledgerRouter = Router();
ledgerRouter.use(authenticate);

ledgerRouter.get(
  "/",
  requirePermission("ledger.view"),
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      `SELECT p.id AS party_id, p.name AS party_name, p.country,
        balances.currency, balances.order_count, balances.total_amount,
        balances.paid_amount, balances.remaining_amount
       FROM parties p
       LEFT JOIN (
         SELECT totals.client_id, totals.currency, COUNT(*) AS order_count,
           SUM(totals.order_total) AS total_amount,
           SUM(LEAST(
             totals.order_total,
             ROUND(totals.order_total * totals.advance_percentage / 100, 2)
               + COALESCE(payments.additional_received, 0)
           )) AS paid_amount,
           SUM(GREATEST(
             totals.order_total
             - ROUND(totals.order_total * totals.advance_percentage / 100, 2)
             - COALESCE(payments.additional_received, 0),
             0
           )) AS remaining_amount
         FROM (${orderTotalsSql}) totals
         LEFT JOIN (${paymentTotalsSql}) payments
           ON payments.export_order_id = totals.id
         WHERE totals.status <> 'cancelled'
         GROUP BY totals.client_id, totals.currency
       ) balances ON balances.client_id = p.id
       WHERE p.party_type = 'client' AND p.is_active = TRUE
       ORDER BY p.name, balances.currency`
    );

    const parties = [];
    for (const row of rows) {
      let party = parties.find((item) => item.id === row.party_id);
      if (!party) {
        party = {
          id: row.party_id,
          name: row.party_name,
          country: row.country,
          balances: []
        };
        parties.push(party);
      }
      if (row.currency) {
        party.balances.push({
          currency: row.currency,
          order_count: row.order_count,
          total_amount: row.total_amount,
          paid_amount: row.paid_amount,
          remaining_amount: row.remaining_amount
        });
      }
    }
    res.json({ parties });
  })
);

ledgerRouter.get(
  "/parties/:partyId",
  requirePermission("ledger.view"),
  asyncHandler(async (req, res) => {
    const [[party]] = await pool.execute(
      `SELECT id, name, contact_person, phone, email, country
       FROM parties
       WHERE id = ? AND party_type = 'client'`,
      [req.params.partyId]
    );
    if (!party) return res.status(404).json({ message: "Client not found." });

    const [orders] = await pool.execute(
      `SELECT totals.*,
        ROUND(totals.order_total * totals.advance_percentage / 100, 2) AS opening_advance,
        COALESCE(payments.additional_received, 0) AS additional_received,
        LEAST(
          totals.order_total,
          ROUND(totals.order_total * totals.advance_percentage / 100, 2)
          + COALESCE(payments.additional_received, 0)
        ) AS paid_amount,
        GREATEST(
          totals.order_total
          - ROUND(totals.order_total * totals.advance_percentage / 100, 2)
          - COALESCE(payments.additional_received, 0),
          0
        ) AS remaining_amount
       FROM (${orderTotalsSql}) totals
       LEFT JOIN (${paymentTotalsSql}) payments
         ON payments.export_order_id = totals.id
       WHERE totals.client_id = ? AND totals.status <> 'cancelled'
       ORDER BY totals.contract_date DESC, totals.id DESC`,
      [req.params.partyId]
    );

    const [payments] = await pool.execute(
      `SELECT op.id, op.export_order_id AS order_id, op.amount, op.payment_date,
        op.reference_number, op.notes, op.created_at, u.name AS recorded_by
       FROM order_payments op
       JOIN export_orders o ON o.id = op.export_order_id
       JOIN users u ON u.id = op.created_by
       WHERE o.client_id = ?
       ORDER BY op.payment_date DESC, op.id DESC`,
      [req.params.partyId]
    );

    res.json({ party, orders, payments });
  })
);

ledgerRouter.post(
  "/payments",
  requirePermission("ledger.record_payment"),
  asyncHandler(async (req, res) => {
    const input = paymentSchema.parse(req.body);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[order]] = await connection.execute(
        `SELECT id, invoice_number, status, advance_percentage
         FROM export_orders
         WHERE id = ?
         FOR UPDATE`,
        [input.order_id]
      );
      if (!order) {
        const error = new Error("Export order not found.");
        error.status = 404;
        throw error;
      }
      if (order.status === "cancelled") {
        const error = new Error("Payments cannot be recorded against a cancelled order.");
        error.status = 409;
        throw error;
      }

      const [[totals]] = await connection.execute(
        `SELECT
           COALESCE(SUM(
             CASE WHEN is_sample = FALSE
               THEN quantity * client_price_per_carton
               ELSE 0
             END
           ), 0) AS order_total
         FROM export_order_items
         WHERE export_order_id = ?`,
        [input.order_id]
      );
      const [[payments]] = await connection.execute(
        `SELECT COALESCE(SUM(amount), 0) AS additional_received
         FROM order_payments
         WHERE export_order_id = ?`,
        [input.order_id]
      );
      const openingAdvance = Math.round(
        totals.order_total * Number(order.advance_percentage)
      ) / 100;
      const remaining = Math.max(
        0,
        totals.order_total - openingAdvance - payments.additional_received
      );
      if (remaining <= 0.004) {
        const error = new Error("This export order is already fully paid.");
        error.status = 409;
        throw error;
      }
      if (input.amount - remaining > 0.004) {
        const error = new Error(
          `Payment exceeds the remaining ${remaining.toFixed(2)} balance for ${order.invoice_number}.`
        );
        error.status = 409;
        throw error;
      }

      const [result] = await connection.execute(
        `INSERT INTO order_payments (
           export_order_id, amount, payment_date, reference_number, notes, created_by
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.order_id,
          input.amount,
          input.payment_date,
          input.reference_number || null,
          input.notes || null,
          req.user.id
        ]
      );
      await connection.commit();
      res.status(201).json({
        id: result.insertId,
        message: "Payment recorded.",
        remaining_amount: Math.max(0, remaining - input.amount)
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  })
);
