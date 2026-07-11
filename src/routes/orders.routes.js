import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { reserveInvoiceNumber } from "../utils/orderNumber.js";

const itemSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive(),
  quantity_unit: z.string().trim().default("CTN"),
  units_per_carton: z.coerce.number().min(0),
  net_weight_per_carton: z.coerce.number().min(0),
  gross_weight_per_carton: z.coerce.number().min(0),
  client_price_per_carton: z.coerce.number().min(0),
  customs_price_per_kg: z.coerce.number().min(0),
  is_sample: z.boolean().default(false),
  description_override: z.string().trim().optional().nullable()
});

const optionalId = z.preprocess(
  (value) => value === "" || value === undefined ? null : value,
  z.coerce.number().int().positive().nullable()
);

const orderSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  customs_consignee_id: z.coerce.number().int().positive(),
  contract_date: z.string().date(),
  valid_until: z.string().date().optional().nullable(),
  sales_contract_number: z.string().trim().optional().nullable(),
  payment_term: z.string().trim().optional().nullable(),
  advance_percentage: z.coerce.number().min(0).max(100).default(0),
  freight_amount: z.coerce.number().min(0).default(0),
  currency: z.string().trim().default("USD"),
  port_of_loading: z.string().trim().optional().nullable(),
  port_of_destination: z.string().trim().optional().nullable(),
  final_destination: z.string().trim().optional().nullable(),
  shipping_type: z.string().trim().optional().nullable(),
  shipped_per: z.string().trim().optional().nullable(),
  container_number: z.string().trim().optional().nullable(),
  container_type: z.string().trim().optional().nullable(),
  cbm: z.coerce.number().min(0).default(0),
  freight_term: z.string().trim().optional().nullable(),
  customer_instructions: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  items: z.array(itemSchema).min(1)
});

const gatePassSchema = z.object({
  clearing_agent_id: optionalId,
  transporter_name: z.string().trim().optional().nullable(),
  transporter_contact: z.string().trim().optional().nullable(),
  transporter_phone: z.string().trim().optional().nullable(),
  truck_number: z.string().trim().optional().nullable(),
  driver_name: z.string().trim().optional().nullable(),
  driver_phone: z.string().trim().optional().nullable(),
  loading_address: z.string().trim().optional().nullable(),
  delivery_address: z.string().trim().optional().nullable(),
  seal_numbers: z.union([z.array(z.string().trim()), z.string().trim()]).optional().nullable()
});

const orderColumns = [
  "client_id", "customs_consignee_id", "contract_date", "valid_until",
  "sales_contract_number", "payment_term", "advance_percentage", "freight_amount",
  "currency", "port_of_loading", "port_of_destination", "final_destination",
  "shipping_type", "shipped_per", "container_number", "container_type", "cbm",
  "freight_term", "customer_instructions", "notes"
];

function orderValue(input, column) {
  return input[column] ?? null;
}

function sealValue(value) {
  if (!value) return null;
  const seals = Array.isArray(value)
    ? value
    : value.split(/\r?\n|,/);
  return JSON.stringify(seals.map((seal) => seal.trim()).filter(Boolean));
}

async function replaceItems(connection, orderId, items) {
  await connection.execute("DELETE FROM export_order_items WHERE export_order_id = ?", [orderId]);
  let cartonCursor = 1;
  for (const [index, item] of items.entries()) {
    const cartonQuantity = Math.floor(item.quantity);
    const start = cartonQuantity ? cartonCursor : null;
    const end = cartonQuantity ? cartonCursor + cartonQuantity - 1 : null;
    await connection.execute(
      `INSERT INTO export_order_items (
        export_order_id, product_id, line_number, carton_start, carton_end,
        quantity, quantity_unit, units_per_carton, net_weight_per_carton,
        gross_weight_per_carton, client_price_per_carton, customs_price_per_kg,
        is_sample, description_override
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId, item.product_id, index + 1, start, end, item.quantity,
        item.quantity_unit, item.units_per_carton, item.net_weight_per_carton,
        item.gross_weight_per_carton, item.client_price_per_carton,
        item.customs_price_per_kg, item.is_sample, item.description_override
      ]
    );
    if (cartonQuantity) cartonCursor = end + 1;
  }
}

export const ordersRouter = Router();
ordersRouter.use(authenticate);

ordersRouter.get(
  "/",
  requirePermission("orders.view"),
  asyncHandler(async (req, res) => {
    const [orders] = await pool.query(
      `SELECT o.id, o.invoice_number, o.status, o.contract_date, o.created_at,
        o.currency, c.name AS client_name, cc.name AS customs_consignee_name,
        COALESCE(SUM(i.quantity), 0) AS total_packages,
        COALESCE(SUM(i.quantity * i.net_weight_per_carton), 0) AS total_net_weight,
        COALESCE(SUM(i.quantity * i.gross_weight_per_carton), 0) AS total_gross_weight,
        COALESCE(SUM(CASE WHEN i.is_sample = FALSE THEN i.quantity * i.client_price_per_carton ELSE 0 END), 0) AS client_value
       FROM export_orders o
       JOIN parties c ON c.id = o.client_id
       JOIN parties cc ON cc.id = o.customs_consignee_id
       LEFT JOIN export_order_items i ON i.export_order_id = o.id
       GROUP BY o.id
       ORDER BY o.created_at DESC`
    );
    res.json({ orders });
  })
);

ordersRouter.get(
  "/:id",
  requirePermission("orders.view"),
  asyncHandler(async (req, res) => {
    const [orders] = await pool.execute(
      `SELECT o.*, c.name AS client_name, c.address_line_1 AS client_address,
        c.city AS client_city, c.country AS client_country,
        cc.name AS customs_consignee_name, cc.address_line_1 AS customs_consignee_address,
        cc.city AS customs_consignee_city, cc.country AS customs_consignee_country,
        ca.name AS clearing_agent_name, ca.phone AS clearing_agent_phone,
        ca.contact_person AS clearing_agent_contact
       FROM export_orders o
       JOIN parties c ON c.id = o.client_id
       JOIN parties cc ON cc.id = o.customs_consignee_id
       LEFT JOIN parties ca ON ca.id = o.clearing_agent_id
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!orders[0]) return res.status(404).json({ message: "Order not found." });
    const [items] = await pool.execute(
      `SELECT i.*, p.name AS product_name, p.hs_code, p.description AS product_description,
        p.unit_weight_grams AS product_unit_weight_grams,
        p.pieces_per_unit AS product_pieces_per_unit,
        p.package_type AS product_package_type,
        p.image_url AS product_image_url
       FROM export_order_items i
       JOIN products p ON p.id = i.product_id
       WHERE i.export_order_id = ?
       ORDER BY i.line_number`,
      [req.params.id]
    );
    const calculatedItems = items.map((item) => ({
      ...item,
      total_net_weight: item.quantity * item.net_weight_per_carton,
      total_gross_weight: item.quantity * item.gross_weight_per_carton,
      total_units: item.quantity * item.units_per_carton,
      client_value: item.is_sample ? 0 : item.quantity * item.client_price_per_carton,
      customs_value: item.is_sample ? 0 : item.quantity * item.net_weight_per_carton * item.customs_price_per_kg
    }));
    res.json({ order: { ...orders[0], items: calculatedItems } });
  })
);

ordersRouter.post(
  "/",
  requirePermission("orders.create"),
  asyncHandler(async (req, res) => {
    const input = orderSchema.parse(req.body);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[settings]] = await connection.query(
        "SELECT invoice_prefix FROM company_settings WHERE id = 1"
      );
      const number = await reserveInvoiceNumber(connection, settings?.invoice_prefix || "ZAFI");
      const values = orderColumns.map((column) => orderValue(input, column));
      const [result] = await connection.execute(
        `INSERT INTO export_orders (
          invoice_number, sequence_number, sequence_year, created_by,
          ${orderColumns.join(", ")}
        ) VALUES (${new Array(orderColumns.length + 4).fill("?").join(", ")})`,
        [number.invoiceNumber, number.sequence, number.year, req.user.id, ...values]
      );
      await replaceItems(connection, result.insertId, input.items);
      await connection.commit();
      res.status(201).json({ id: result.insertId, invoice_number: number.invoiceNumber });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  })
);

ordersRouter.put(
  "/:id",
  requirePermission("orders.edit"),
  asyncHandler(async (req, res) => {
    const input = orderSchema.parse(req.body);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[existingOrder]] = await connection.execute(
        "SELECT status FROM export_orders WHERE id = ? FOR UPDATE",
        [req.params.id]
      );
      if (!existingOrder) {
        const error = new Error("Order not found.");
        error.status = 404;
        throw error;
      }
      if (["shipped", "completed", "cancelled"].includes(existingOrder.status)) {
        const error = new Error("Shipped, completed or cancelled orders cannot be edited.");
        error.status = 409;
        throw error;
      }
      await connection.execute(
        `UPDATE export_orders SET ${orderColumns.map((column) => `${column}=?`).join(", ")}
         WHERE id=?`,
        [...orderColumns.map((column) => orderValue(input, column)), req.params.id]
      );
      await replaceItems(connection, req.params.id, input.items);
      await connection.commit();
      res.json({ message: "Order updated." });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  })
);

ordersRouter.patch(
  "/:id/gate-pass",
  requirePermission("orders.edit"),
  asyncHandler(async (req, res) => {
    const input = gatePassSchema.parse(req.body);
    const [result] = await pool.execute(
      `UPDATE export_orders SET
        clearing_agent_id=?, transporter_name=?, transporter_contact=?,
        transporter_phone=?, truck_number=?, driver_name=?, driver_phone=?,
        loading_address=?, delivery_address=?, seal_numbers=?
       WHERE id=?`,
      [
        input.clearing_agent_id,
        input.transporter_name || null,
        input.transporter_contact || null,
        input.transporter_phone || null,
        input.truck_number || null,
        input.driver_name || null,
        input.driver_phone || null,
        input.loading_address || null,
        input.delivery_address || null,
        sealValue(input.seal_numbers),
        req.params.id
      ]
    );
    if (!result.affectedRows) return res.status(404).json({ message: "Order not found." });
    res.json({ message: "Gate pass information updated." });
  })
);

ordersRouter.patch(
  "/:id/status",
  requirePermission("orders.confirm"),
  asyncHandler(async (req, res) => {
    const { status } = z.object({
      status: z.enum(["draft", "confirmed", "in_production", "ready_to_ship", "shipped", "completed", "cancelled"])
    }).parse(req.body);
    await pool.execute(
      `UPDATE export_orders
       SET status=?, confirmed_at=IF(?='confirmed' AND confirmed_at IS NULL, NOW(), confirmed_at)
       WHERE id=?`,
      [status, status, req.params.id]
    );
    res.json({ message: "Order status updated." });
  })
);

ordersRouter.post(
  "/:id/document-audit",
  requirePermission("documents.preview"),
  asyncHandler(async (req, res) => {
    const input = z.object({
      document_type: z.enum([
        "sale_contract", "customs_packing_list", "customs_commercial_invoice",
        "client_packing_list", "client_commercial_invoice", "gate_pass",
        "bl_instructions", "certificate_of_origin"
      ]),
      action_name: z.enum(["previewed", "printed", "downloaded"])
    }).parse(req.body);
    await pool.execute(
      `INSERT INTO document_audit_logs
       (export_order_id, user_id, document_type, action_name)
       VALUES (?, ?, ?, ?)`,
      [req.params.id, req.user.id, input.document_type, input.action_name]
    );
    res.status(201).json({ message: "Document activity recorded." });
  })
);
