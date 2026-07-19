import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const statuses = [
  "draft", "confirmed", "in_production", "ready_to_ship",
  "shipped", "completed", "cancelled"
];

const reportFilterSchema = z.object({
  date_from: z.union([z.string().date(), z.literal("")]).optional(),
  date_to: z.union([z.string().date(), z.literal("")]).optional(),
  client_id: z.union([z.coerce.number().int().positive(), z.literal("")]).optional(),
  status: z.union([z.enum(statuses), z.literal("")]).optional(),
  currency: z.string().trim().max(10).optional()
});

const orderTotalsSql = `
  SELECT o.id, o.client_id, o.invoice_number, o.contract_date, o.valid_until,
    o.status, o.currency, o.advance_percentage, o.port_of_destination,
    o.final_destination,
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
  FROM (${orderTotalsSql}) totals
  LEFT JOIN (${paymentTotalsSql}) payments
    ON payments.export_order_id = totals.id
`;

function orderWhere(filters, alias = "balances") {
  const conditions = [`${alias}.status <> 'cancelled'`];
  const values = [];
  if (filters.date_from) {
    conditions.push(`${alias}.contract_date >= ?`);
    values.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push(`${alias}.contract_date <= ?`);
    values.push(filters.date_to);
  }
  if (filters.client_id) {
    conditions.push(`${alias}.client_id = ?`);
    values.push(filters.client_id);
  }
  if (filters.status) {
    conditions.push(`${alias}.status = ?`);
    values.push(filters.status);
  }
  if (filters.currency) {
    conditions.push(`${alias}.currency = ?`);
    values.push(filters.currency);
  }
  return { sql: conditions.join(" AND "), values };
}

function paymentWhere(filters) {
  const conditions = ["history.status <> 'cancelled'"];
  const values = [];
  if (filters.date_from) {
    conditions.push("history.payment_date >= ?");
    values.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push("history.payment_date <= ?");
    values.push(filters.date_to);
  }
  if (filters.client_id) {
    conditions.push("history.client_id = ?");
    values.push(filters.client_id);
  }
  if (filters.status) {
    conditions.push("history.status = ?");
    values.push(filters.status);
  }
  if (filters.currency) {
    conditions.push("history.currency = ?");
    values.push(filters.currency);
  }
  return { sql: conditions.join(" AND "), values };
}

function parseFilters(query) {
  const parsed = reportFilterSchema.parse(query);
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== "")
  );
}

export const reportsRouter = Router();
reportsRouter.use(authenticate, requirePermission("reports.view"));

reportsRouter.get(
  "/filters",
  asyncHandler(async (req, res) => {
    const [clients] = await pool.query(
      `SELECT id, name
       FROM parties
       WHERE party_type = 'client' AND is_active = TRUE
       ORDER BY name`
    );
    const [currencyRows] = await pool.query(
      `SELECT DISTINCT currency
       FROM export_orders
       WHERE currency IS NOT NULL AND currency <> ''
       ORDER BY currency`
    );
    res.json({
      clients,
      currencies: currencyRows.map((row) => row.currency),
      statuses
    });
  })
);

reportsRouter.get(
  "/executive",
  asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query);
    const where = orderWhere(filters);
    const [currencySummary] = await pool.execute(
      `SELECT balances.currency, COUNT(*) AS order_count,
        SUM(balances.order_total) AS total_amount,
        SUM(balances.paid_amount) AS paid_amount,
        SUM(balances.remaining_amount) AS remaining_amount
       FROM (${orderBalancesSql}) balances
       WHERE ${where.sql}
       GROUP BY balances.currency
       ORDER BY balances.currency`,
      where.values
    );
    const [statusSummary] = await pool.execute(
      `SELECT balances.status, COUNT(*) AS order_count
       FROM (${orderBalancesSql}) balances
       WHERE ${where.sql}
       GROUP BY balances.status
       ORDER BY order_count DESC`,
      where.values
    );
    const [monthlySales] = await pool.execute(
      `SELECT DATE_FORMAT(balances.contract_date, '%Y-%m') AS month,
        balances.currency, SUM(balances.order_total) AS total_amount
       FROM (${orderBalancesSql}) balances
       WHERE ${where.sql}
       GROUP BY month, balances.currency
       ORDER BY month, balances.currency`,
      where.values
    );
    const [topClients] = await pool.execute(
      `SELECT p.id AS client_id, p.name AS client_name, balances.currency,
        COUNT(*) AS order_count, SUM(balances.order_total) AS total_amount,
        SUM(balances.remaining_amount) AS remaining_amount
       FROM (${orderBalancesSql}) balances
       JOIN parties p ON p.id = balances.client_id
       WHERE ${where.sql}
       GROUP BY p.id, balances.currency
       ORDER BY total_amount DESC
       LIMIT 10`,
      where.values
    );
    res.json({ currencySummary, statusSummary, monthlySales, topClients });
  })
);

reportsRouter.get(
  "/sales",
  asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query);
    const where = orderWhere(filters);
    const [orders] = await pool.execute(
      `SELECT balances.*, p.name AS client_name
       FROM (${orderBalancesSql}) balances
       JOIN parties p ON p.id = balances.client_id
       WHERE ${where.sql}
       ORDER BY balances.contract_date DESC, balances.id DESC`,
      where.values
    );
    res.json({ orders });
  })
);

reportsRouter.get(
  "/receivables",
  asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query);
    const where = orderWhere(filters);
    const [receivables] = await pool.execute(
      `SELECT report.*,
        GREATEST(DATEDIFF(CURDATE(), COALESCE(report.valid_until, report.contract_date)), 0)
          AS days_outstanding,
        CASE
          WHEN DATEDIFF(CURDATE(), COALESCE(report.valid_until, report.contract_date)) <= 0
            THEN 'Current'
          WHEN DATEDIFF(CURDATE(), COALESCE(report.valid_until, report.contract_date)) <= 30
            THEN '1-30 days'
          WHEN DATEDIFF(CURDATE(), COALESCE(report.valid_until, report.contract_date)) <= 60
            THEN '31-60 days'
          WHEN DATEDIFF(CURDATE(), COALESCE(report.valid_until, report.contract_date)) <= 90
            THEN '61-90 days'
          ELSE 'Over 90 days'
        END AS aging_bucket
       FROM (
         SELECT balances.*, p.name AS client_name
         FROM (${orderBalancesSql}) balances
         JOIN parties p ON p.id = balances.client_id
         WHERE ${where.sql}
       ) report
       WHERE report.remaining_amount > 0.004
       ORDER BY days_outstanding DESC, report.remaining_amount DESC`,
      where.values
    );
    res.json({ receivables });
  })
);

reportsRouter.get(
  "/client-statement/:partyId",
  asyncHandler(async (req, res) => {
    const partyId = z.coerce.number().int().positive().parse(req.params.partyId);
    const [[party]] = await pool.execute(
      `SELECT id, name, contact_person, phone, email, country
       FROM parties
       WHERE id = ? AND party_type = 'client'`,
      [partyId]
    );
    if (!party) return res.status(404).json({ message: "Client not found." });

    const [orders] = await pool.execute(
      `SELECT balances.*
       FROM (${orderBalancesSql}) balances
       WHERE balances.client_id = ? AND balances.status <> 'cancelled'
       ORDER BY balances.contract_date, balances.id`,
      [partyId]
    );
    const [payments] = await pool.execute(
      `SELECT op.id, op.export_order_id AS order_id, op.payment_date,
        op.amount, op.reference_number, op.notes, o.invoice_number,
        o.currency, u.name AS recorded_by
       FROM order_payments op
       JOIN export_orders o ON o.id = op.export_order_id
       JOIN users u ON u.id = op.created_by
       WHERE o.client_id = ? AND o.status <> 'cancelled'
       ORDER BY op.payment_date, op.id`,
      [partyId]
    );

    const transactions = [];
    for (const order of orders) {
      transactions.push({
        id: `order-${order.id}`,
        date: order.contract_date,
        sort_order: 1,
        order_id: order.id,
        invoice_number: order.invoice_number,
        currency: order.currency,
        type: "order",
        description: "Export order",
        debit: order.order_total,
        credit: 0
      });
      if (Number(order.opening_advance) > 0.004) {
        transactions.push({
          id: `advance-${order.id}`,
          date: order.contract_date,
          sort_order: 2,
          order_id: order.id,
          invoice_number: order.invoice_number,
          currency: order.currency,
          type: "opening_advance",
          description: `Opening advance ${Number(order.advance_percentage)}%`,
          reference_number: `Advance ${Number(order.advance_percentage)}%`,
          debit: 0,
          credit: order.opening_advance
        });
      }
    }
    for (const payment of payments) {
      transactions.push({
        id: `payment-${payment.id}`,
        date: payment.payment_date,
        sort_order: 3,
        order_id: payment.order_id,
        invoice_number: payment.invoice_number,
        currency: payment.currency,
        type: "payment",
        description: "Received payment",
        reference_number: payment.reference_number,
        notes: payment.notes,
        recorded_by: payment.recorded_by,
        debit: 0,
        credit: payment.amount
      });
    }
    transactions.sort((left, right) =>
      String(left.date).localeCompare(String(right.date))
        || left.sort_order - right.sort_order
        || String(left.id).localeCompare(String(right.id))
    );

    const balances = new Map();
    const statement = transactions.map((transaction) => {
      const running = (balances.get(transaction.currency) || 0)
        + Number(transaction.debit) - Number(transaction.credit);
      balances.set(transaction.currency, running);
      return { ...transaction, running_balance: running };
    });
    const summary = [...balances.entries()].map(([currency, closing_balance]) => ({
      currency,
      closing_balance
    }));
    res.json({ party, summary, transactions: statement });
  })
);

reportsRouter.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const filters = parseFilters(req.query);
    const where = paymentWhere(filters);
    const [payments] = await pool.execute(
      `SELECT history.*
       FROM (
         SELECT CONCAT('advance-', balances.id) AS id,
           balances.contract_date AS payment_date, balances.client_id,
           p.name AS client_name, balances.id AS order_id,
           balances.invoice_number, balances.status, balances.currency,
           'opening_advance' AS payment_type,
           balances.opening_advance AS amount,
           CONCAT('Advance ', balances.advance_percentage, '%') AS reference_number,
           'Calculated from export order' AS notes,
           'Export order' AS recorded_by
         FROM (${orderBalancesSql}) balances
         JOIN parties p ON p.id = balances.client_id
         WHERE balances.opening_advance > 0.004

         UNION ALL

         SELECT CONCAT('payment-', op.id) AS id, op.payment_date, o.client_id,
           p.name AS client_name, o.id AS order_id, o.invoice_number,
           o.status, o.currency, 'later_receipt' AS payment_type,
           op.amount, op.reference_number, op.notes, u.name AS recorded_by
         FROM order_payments op
         JOIN export_orders o ON o.id = op.export_order_id
         JOIN parties p ON p.id = o.client_id
         JOIN users u ON u.id = op.created_by
       ) history
       WHERE ${where.sql}
       ORDER BY history.payment_date DESC, history.id DESC`,
      where.values
    );
    res.json({ payments });
  })
);
