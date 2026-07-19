import { Router } from "express";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const orderBalancesSql = `
  SELECT totals.*,
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
  FROM (
    SELECT o.id, o.client_id, o.invoice_number, o.status, o.contract_date,
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
  ) totals
  LEFT JOIN (
    SELECT export_order_id, COALESCE(SUM(amount), 0) AS additional_received
    FROM order_payments
    GROUP BY export_order_id
  ) payments ON payments.export_order_id = totals.id
`;

export const dashboardRouter = Router();
dashboardRouter.use(authenticate, requirePermission("dashboard.view"));

dashboardRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const [[orders]] = await pool.query(
      `SELECT COUNT(*) AS total,
        SUM(status = 'draft') AS drafts,
        SUM(status IN ('confirmed','in_production','ready_to_ship')) AS active,
        SUM(status = 'ready_to_ship') AS ready_to_ship,
        SUM(status = 'shipped') AS shipped,
        SUM(status = 'completed') AS completed,
        SUM(status = 'cancelled') AS cancelled
       FROM export_orders`
    );
    const [[masters]] = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM products WHERE is_active = TRUE) AS products,
        (SELECT COUNT(*) FROM products
         WHERE is_active = TRUE AND low_stock_alert > 0
           AND stock_in_hand <= low_stock_alert) AS low_stock_products,
        (SELECT COUNT(*) FROM parties WHERE party_type = 'client' AND is_active = TRUE) AS clients,
        (SELECT COUNT(*) FROM users WHERE is_active = TRUE) AS users`
    );
    const [financialSummary] = await pool.query(
      `SELECT balances.currency, COUNT(*) AS order_count,
        SUM(balances.order_total) AS total_amount,
        SUM(balances.paid_amount) AS paid_amount,
        SUM(balances.remaining_amount) AS remaining_amount
       FROM (${orderBalancesSql}) balances
       WHERE balances.status <> 'cancelled'
       GROUP BY balances.currency
       ORDER BY balances.currency`
    );
    const [statusSummary] = await pool.query(
      `SELECT status, COUNT(*) AS order_count
       FROM export_orders
       GROUP BY status
       ORDER BY order_count DESC`
    );
    const [monthlyExports] = await pool.query(
      `SELECT DATE_FORMAT(balances.contract_date, '%Y-%m') AS month,
        balances.currency, SUM(balances.order_total) AS total_amount
       FROM (${orderBalancesSql}) balances
       WHERE balances.status <> 'cancelled'
         AND balances.contract_date >= DATE_FORMAT(
           DATE_SUB(CURDATE(), INTERVAL 5 MONTH),
           '%Y-%m-01'
         )
       GROUP BY month, balances.currency
       ORDER BY month, balances.currency`
    );
    const [recentOrders] = await pool.query(
      `SELECT balances.id, balances.invoice_number, balances.status,
        balances.contract_date, balances.currency, balances.order_total,
        balances.paid_amount, balances.remaining_amount,
        p.name AS client_name
       FROM (${orderBalancesSql}) balances
       JOIN parties p ON p.id = balances.client_id
       ORDER BY balances.contract_date DESC, balances.id DESC
       LIMIT 6`
    );
    const [recentPayments] = await pool.query(
      `SELECT op.id, op.payment_date, op.amount, op.reference_number,
        o.id AS order_id, o.invoice_number, o.currency,
        p.name AS client_name, u.name AS recorded_by
       FROM order_payments op
       JOIN export_orders o ON o.id = op.export_order_id
       JOIN parties p ON p.id = o.client_id
       JOIN users u ON u.id = op.created_by
       ORDER BY op.payment_date DESC, op.id DESC
       LIMIT 5`
    );

    res.json({
      stats: { ...orders, ...masters },
      financialSummary,
      statusSummary,
      monthlyExports,
      recentOrders,
      recentPayments,
      generatedAt: new Date().toISOString()
    });
  })
);
