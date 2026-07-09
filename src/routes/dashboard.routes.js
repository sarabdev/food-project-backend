import { Router } from "express";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const dashboardRouter = Router();
dashboardRouter.use(authenticate, requirePermission("dashboard.view"));

dashboardRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const [[orders]] = await pool.query(
      `SELECT COUNT(*) AS total,
        SUM(status = 'draft') AS drafts,
        SUM(status IN ('confirmed','in_production','ready_to_ship')) AS active,
        SUM(status = 'shipped') AS shipped
       FROM export_orders`
    );
    const [[masters]] = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM products WHERE is_active = TRUE) AS products,
        (SELECT COUNT(*) FROM parties WHERE party_type = 'client' AND is_active = TRUE) AS clients,
        (SELECT COUNT(*) FROM users WHERE is_active = TRUE) AS users`
    );
    const [recentOrders] = await pool.query(
      `SELECT o.id, o.invoice_number, o.status, o.contract_date, o.currency,
        p.name AS client_name,
        COALESCE(SUM(CASE WHEN i.is_sample = FALSE THEN i.quantity * i.client_price_per_carton ELSE 0 END), 0) AS client_value
       FROM export_orders o
       JOIN parties p ON p.id = o.client_id
       LEFT JOIN export_order_items i ON i.export_order_id = o.id
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT 6`
    );
    res.json({ stats: { ...orders, ...masters }, recentOrders });
  })
);

