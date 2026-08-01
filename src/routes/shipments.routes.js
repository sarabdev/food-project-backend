import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

function isGatePassOnlyUser(user) {
  return user.permissions.includes("gate_pass.view")
    && !user.permissions.includes("documents.preview")
    && !user.permissions.includes("orders.edit");
}

const optionalId = z.preprocess(
  (value) => value === "" || value === undefined ? null : value,
  z.coerce.number().int().positive().nullable()
);

const shipmentSchema = z.object({
  client_id: z.coerce.number().int().positive(),
  customs_consignee_id: z.coerce.number().int().positive(),
  shipment_date: z.string().date(),
  currency: z.string().trim().default("USD"),
  port_of_loading: z.string().trim().optional().nullable(),
  port_of_destination: z.string().trim().optional().nullable(),
  final_destination: z.string().trim().optional().nullable(),
  shipping_type: z.string().trim().optional().nullable(),
  shipped_per: z.string().trim().optional().nullable(),
  containers: z.array(z.object({
    container_number: z.string().trim().min(1).max(120),
    container_type: z.string().trim().max(80).optional().nullable(),
    cbm: z.coerce.number().min(0).default(0)
  })).min(1),
  freight_term: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  allocations: z.array(z.object({
    export_order_item_id: z.coerce.number().int().positive(),
    container_index: z.coerce.number().int().min(0),
    quantity: z.coerce.number().positive()
  })).min(1)
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

function sealValue(value) {
  if (!value) return null;
  const values = Array.isArray(value) ? value : value.split(/\r?\n|,/);
  return JSON.stringify(values.map((item) => item.trim()).filter(Boolean));
}

async function reserveShipmentNumber(connection) {
  const year = new Date().getFullYear();
  const [[latest]] = await connection.execute(
    "SELECT COALESCE(MAX(sequence_number), 0) AS current_sequence FROM shipments WHERE sequence_year = ? FOR UPDATE",
    [year]
  );
  const sequence = Number(latest.current_sequence) + 1;
  return { sequence, year, value: `SHP-${String(sequence).padStart(3, "0")}/${year}` };
}

async function allocationLines(connection, allocations, clientId, excludedShipmentId = null) {
  const ids = [...new Set(allocations.map((item) => Number(item.export_order_item_id)))];
  const placeholders = ids.map(() => "?").join(", ");
  const [lines] = await connection.execute(
    `SELECT i.*, o.client_id, o.invoice_number, o.sales_contract_number,
      o.status AS contract_status, p.name AS product_name,
      COALESCE((SELECT SUM(sa.quantity)
        FROM shipment_allocations sa JOIN shipments s ON s.id = sa.shipment_id
        WHERE sa.export_order_item_id = i.id AND s.status <> 'cancelled'
          AND (? IS NULL OR s.id <> ?)), 0) AS allocated_quantity
     FROM export_order_items i
     JOIN export_orders o ON o.id = i.export_order_id
     JOIN products p ON p.id = i.product_id
     WHERE i.id IN (${placeholders})
     ORDER BY i.id FOR UPDATE`,
    [excludedShipmentId, excludedShipmentId, ...ids]
  );
  if (lines.length !== ids.length) {
    const error = new Error("One or more selected contract lines no longer exist.");
    error.status = 409;
    throw error;
  }
  const requested = new Map();
  for (const allocation of allocations) {
    const lineId = Number(allocation.export_order_item_id);
    requested.set(lineId, (requested.get(lineId) || 0) + Number(allocation.quantity));
  }
  for (const line of lines) {
    if (Number(line.client_id) !== Number(clientId)) {
      const error = new Error("All selected sales contracts must belong to the shipment client.");
      error.status = 409;
      throw error;
    }
    if (line.contract_status === "cancelled") {
      const error = new Error(`Sales contract ${line.sales_contract_number || line.invoice_number} is cancelled.`);
      error.status = 409;
      throw error;
    }
    const remaining = Number(line.quantity) - Number(line.allocated_quantity);
    if (requested.get(Number(line.id)) > remaining + 0.0001) {
      const error = new Error(`${line.product_name} has only ${remaining.toLocaleString()} packages remaining on ${line.sales_contract_number || line.invoice_number}.`);
      error.status = 409;
      throw error;
    }
  }
  return lines;
}

function validateShipmentStructure(input) {
  const containerNumbers = input.containers.map((container) => container.container_number.toLowerCase());
  if (new Set(containerNumbers).size !== containerNumbers.length) {
    const error = new Error("Container numbers must be unique within a shipment.");
    error.status = 409;
    throw error;
  }
  const allocationKeys = new Set();
  const usedContainerIndexes = new Set();
  for (const allocation of input.allocations) {
    if (!input.containers[allocation.container_index]) {
      const error = new Error("One or more allocations reference an unavailable container.");
      error.status = 409;
      throw error;
    }
    const key = `${allocation.export_order_item_id}:${allocation.container_index}`;
    if (allocationKeys.has(key)) {
      const error = new Error("A contract line can appear only once in each container.");
      error.status = 409;
      throw error;
    }
    allocationKeys.add(key);
    usedContainerIndexes.add(allocation.container_index);
  }
  if (usedContainerIndexes.size !== input.containers.length) {
    const error = new Error("Allocate at least one product quantity to every container.");
    error.status = 409;
    throw error;
  }
}

async function replaceShipmentStructure(connection, shipmentId, input, replace = false) {
  if (replace) {
    await connection.execute("DELETE FROM shipment_allocations WHERE shipment_id=?", [shipmentId]);
    await connection.execute("DELETE FROM shipment_containers WHERE shipment_id=?", [shipmentId]);
  }
  const containerIds = [];
  for (const [index, container] of input.containers.entries()) {
    const [containerResult] = await connection.execute(
      `INSERT INTO shipment_containers (
        shipment_id, line_number, container_number, container_type, cbm
      ) VALUES (?, ?, ?, ?, ?)`,
      [shipmentId, index + 1, container.container_number, container.container_type || null, container.cbm]
    );
    containerIds.push(containerResult.insertId);
  }
  for (const [index, allocation] of input.allocations.entries()) {
    await connection.execute(
      `INSERT INTO shipment_allocations (
        shipment_id, shipment_container_id, export_order_item_id, line_number, quantity
      ) VALUES (?, ?, ?, ?, ?)`,
      [shipmentId, containerIds[allocation.container_index], allocation.export_order_item_id, index + 1, allocation.quantity]
    );
  }
}

export const shipmentsRouter = Router();
shipmentsRouter.use(authenticate);

shipmentsRouter.get("/", requirePermission("orders.view"), asyncHandler(async (req, res) => {
  const [shipments] = await pool.query(
    `SELECT s.id, s.shipment_number, s.status, s.shipment_date, s.currency,
      c.name AS client_name, COUNT(DISTINCT o.id) AS contract_count,
      (SELECT COUNT(*) FROM shipment_containers sc WHERE sc.shipment_id=s.id) AS container_count,
      COALESCE(SUM(sa.quantity), 0) AS total_packages,
      COALESCE(SUM(sa.quantity * i.net_weight_per_carton), 0) AS total_net_weight,
      COALESCE(SUM(sa.quantity * i.gross_weight_per_carton), 0) AS total_gross_weight,
      COALESCE(SUM(CASE WHEN i.is_sample = FALSE THEN sa.quantity * i.client_price_per_carton ELSE 0 END), 0) AS client_value
     FROM shipments s JOIN parties c ON c.id = s.client_id
     LEFT JOIN shipment_allocations sa ON sa.shipment_id = s.id
     LEFT JOIN export_order_items i ON i.id = sa.export_order_item_id
     LEFT JOIN export_orders o ON o.id = i.export_order_id
     GROUP BY s.id ORDER BY s.created_at DESC`
  );
  if (isGatePassOnlyUser(req.user)) {
    return res.json({ shipments: shipments.map((shipment) => ({
      id: shipment.id,
      shipment_number: shipment.shipment_number,
      status: shipment.status,
      shipment_date: shipment.shipment_date,
      client_name: shipment.client_name,
      contract_count: shipment.contract_count,
      container_count: shipment.container_count,
      total_packages: shipment.total_packages,
      total_net_weight: shipment.total_net_weight,
      total_gross_weight: shipment.total_gross_weight
    })) });
  }
  res.json({ shipments });
}));

shipmentsRouter.get("/available-lines", requirePermission("orders.view"), asyncHandler(async (req, res) => {
  const clientId = z.coerce.number().int().positive().parse(req.query.client_id);
  const excludedShipmentId = req.query.shipment_id
    ? z.coerce.number().int().positive().parse(req.query.shipment_id)
    : null;
  const [lines] = await pool.execute(
    `SELECT i.id AS export_order_item_id, i.product_id, i.quantity AS contract_quantity,
      i.quantity_unit, i.units_per_carton, i.net_weight_per_carton, i.gross_weight_per_carton,
      i.client_price_per_carton, i.customs_price_per_kg, i.is_sample,
      p.name AS product_name, o.id AS contract_id, o.invoice_number,
      COALESCE(o.sales_contract_number, o.invoice_number) AS contract_number,
      o.contract_date, o.currency,
      COALESCE((SELECT SUM(sa.quantity) FROM shipment_allocations sa
        JOIN shipments s ON s.id = sa.shipment_id
        WHERE sa.export_order_item_id = i.id AND s.status <> 'cancelled'
          AND (? IS NULL OR s.id <> ?)), 0) AS allocated_quantity
     FROM export_order_items i JOIN export_orders o ON o.id = i.export_order_id
     JOIN products p ON p.id = i.product_id
     WHERE o.client_id = ? AND o.status <> 'cancelled'
     HAVING contract_quantity - allocated_quantity > 0.0001
     ORDER BY o.contract_date, o.id, i.line_number`,
    [excludedShipmentId, excludedShipmentId, clientId]
  );
  res.json({ lines: lines.map((line) => ({
    ...line,
    remaining_quantity: Number(line.contract_quantity) - Number(line.allocated_quantity)
  })) });
}));

shipmentsRouter.get("/:id", requirePermission("orders.view"), asyncHandler(async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT s.*, s.shipment_number AS invoice_number, s.shipment_date AS contract_date,
      (SELECT GROUP_CONCAT(sc.container_number ORDER BY sc.line_number SEPARATOR ', ')
       FROM shipment_containers sc WHERE sc.shipment_id=s.id) AS container_number,
      (SELECT GROUP_CONCAT(DISTINCT sc.container_type ORDER BY sc.container_type SEPARATOR ', ')
       FROM shipment_containers sc WHERE sc.shipment_id=s.id) AS container_type,
      (SELECT COALESCE(SUM(sc.cbm), 0) FROM shipment_containers sc WHERE sc.shipment_id=s.id) AS cbm,
      c.name AS client_name, c.address_line_1 AS client_address, c.city AS client_city, c.country AS client_country,
      cc.name AS customs_consignee_name, cc.address_line_1 AS customs_consignee_address,
      cc.city AS customs_consignee_city, cc.country AS customs_consignee_country,
      ca.name AS clearing_agent_name, ca.phone AS clearing_agent_phone, ca.contact_person AS clearing_agent_contact,
      GROUP_CONCAT(DISTINCT COALESCE(o.sales_contract_number, o.invoice_number) ORDER BY o.contract_date SEPARATOR ', ') AS sales_contract_number
     FROM shipments s JOIN parties c ON c.id = s.client_id
     JOIN parties cc ON cc.id = s.customs_consignee_id
     LEFT JOIN parties ca ON ca.id = s.clearing_agent_id
     LEFT JOIN shipment_allocations sa ON sa.shipment_id = s.id
     LEFT JOIN export_order_items i ON i.id = sa.export_order_item_id
     LEFT JOIN export_orders o ON o.id = i.export_order_id
     WHERE s.id = ? GROUP BY s.id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ message: "Shipment not found." });
  const [containers] = await pool.execute(
    `SELECT id, line_number, container_number, container_type, cbm, seal_numbers
     FROM shipment_containers WHERE shipment_id=? ORDER BY line_number`,
    [req.params.id]
  );
  const [items] = await pool.execute(
    `SELECT sa.id, sa.line_number, sa.quantity, sa.shipment_container_id,
      sa.export_order_item_id,
      sc.line_number AS container_line_number, sc.container_number,
      sc.container_type, sc.cbm AS container_cbm,
      i.product_id, i.quantity_unit,
      i.units_per_carton, i.net_weight_per_carton, i.gross_weight_per_carton,
      i.client_price_per_carton, i.customs_price_per_kg, i.is_sample, i.description_override,
      p.name AS product_name, p.hs_code, p.description AS product_description,
      p.unit_weight_grams AS product_unit_weight_grams, p.pieces_per_unit AS product_pieces_per_unit,
      p.package_type AS product_package_type, p.packaging_details AS product_packaging_details,
      p.image_url AS product_image_url, o.id AS contract_id,
      COALESCE(o.sales_contract_number, o.invoice_number) AS contract_number
     FROM shipment_allocations sa
     JOIN shipment_containers sc ON sc.id = sa.shipment_container_id
     JOIN export_order_items i ON i.id = sa.export_order_item_id
     JOIN products p ON p.id = i.product_id JOIN export_orders o ON o.id = i.export_order_id
     WHERE sa.shipment_id = ? ORDER BY sc.line_number, sa.line_number`,
    [req.params.id]
  );
  const cartonCursors = new Map();
  const calculatedItems = items.map((item) => {
    const cartons = Math.floor(Number(item.quantity));
    const containerId = Number(item.shipment_container_id);
    const cartonCursor = cartonCursors.get(containerId) || 1;
    const cartonStart = cartons ? cartonCursor : null;
    const cartonEnd = cartons ? cartonCursor + cartons - 1 : null;
    if (cartons) cartonCursors.set(containerId, cartonEnd + 1);
    return {
      ...item, carton_start: cartonStart, carton_end: cartonEnd,
      total_net_weight: Number(item.quantity) * Number(item.net_weight_per_carton),
      total_gross_weight: Number(item.quantity) * Number(item.gross_weight_per_carton),
      total_units: Number(item.quantity) * Number(item.units_per_carton),
      client_value: item.is_sample ? 0 : Number(item.quantity) * Number(item.client_price_per_carton),
      customs_value: item.is_sample ? 0 : Number(item.quantity) * Number(item.net_weight_per_carton) * Number(item.customs_price_per_kg)
    };
  });
  if (isGatePassOnlyUser(req.user)) {
    const shipment = rows[0];
    return res.json({ shipment: {
      id: shipment.id,
      invoice_number: shipment.invoice_number,
      shipment_number: shipment.shipment_number,
      status: shipment.status,
      contract_date: shipment.contract_date,
      client_name: shipment.client_name,
      container_number: shipment.container_number,
      container_type: shipment.container_type,
      containers,
      clearing_agent_id: shipment.clearing_agent_id,
      clearing_agent_name: shipment.clearing_agent_name,
      clearing_agent_phone: shipment.clearing_agent_phone,
      clearing_agent_contact: shipment.clearing_agent_contact,
      transporter_name: shipment.transporter_name,
      transporter_contact: shipment.transporter_contact,
      transporter_phone: shipment.transporter_phone,
      truck_number: shipment.truck_number,
      driver_name: shipment.driver_name,
      driver_phone: shipment.driver_phone,
      loading_address: shipment.loading_address,
      delivery_address: shipment.delivery_address,
      seal_numbers: shipment.seal_numbers,
      items: calculatedItems.map((item) => ({
        id: item.id, product_id: item.product_id, product_name: item.product_name,
        description_override: item.description_override, quantity: item.quantity,
        quantity_unit: item.quantity_unit, units_per_carton: item.units_per_carton,
        is_sample: item.is_sample, product_unit_weight_grams: item.product_unit_weight_grams,
        product_pieces_per_unit: item.product_pieces_per_unit,
        product_package_type: item.product_package_type,
        total_net_weight: item.total_net_weight, total_gross_weight: item.total_gross_weight,
        shipment_container_id: item.shipment_container_id,
        container_number: item.container_number, container_type: item.container_type
      }))
    } });
  }
  res.json({ shipment: { ...rows[0], containers, items: calculatedItems } });
}));

shipmentsRouter.post("/", requirePermission("orders.create"), asyncHandler(async (req, res) => {
  const input = shipmentSchema.parse(req.body);
  validateShipmentStructure(input);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await allocationLines(connection, input.allocations, input.client_id);
    const number = await reserveShipmentNumber(connection);
    const firstContainer = input.containers[0];
    const [result] = await connection.execute(
      `INSERT INTO shipments (
        shipment_number, sequence_number, sequence_year, client_id, customs_consignee_id,
        created_by, shipment_date, currency, port_of_loading, port_of_destination,
        final_destination, shipping_type, shipped_per, container_number, container_type,
        cbm, freight_term, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        number.value, number.sequence, number.year, input.client_id, input.customs_consignee_id,
        req.user.id, input.shipment_date, input.currency, input.port_of_loading || null,
        input.port_of_destination || null, input.final_destination || null,
        input.shipping_type || null, input.shipped_per || null, firstContainer.container_number,
        firstContainer.container_type || null, firstContainer.cbm, input.freight_term || null, input.notes || null
      ]
    );
    await replaceShipmentStructure(connection, result.insertId, input);
    await connection.commit();
    res.status(201).json({ id: result.insertId, shipment_number: number.value });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

shipmentsRouter.put("/:id", requirePermission("orders.edit"), asyncHandler(async (req, res) => {
  const input = shipmentSchema.parse(req.body);
  validateShipmentStructure(input);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[shipment]] = await connection.execute(
      "SELECT id, status FROM shipments WHERE id=? FOR UPDATE",
      [req.params.id]
    );
    if (!shipment) {
      await connection.rollback();
      return res.status(404).json({ message: "Shipment not found." });
    }
    if (!["draft", "ready_to_ship"].includes(shipment.status)) {
      await connection.rollback();
      return res.status(409).json({ message: "Only draft or ready-to-ship shipments can be edited." });
    }

    await allocationLines(connection, input.allocations, input.client_id, Number(req.params.id));
    const firstContainer = input.containers[0];
    await connection.execute(
      `UPDATE shipments SET
        client_id=?, customs_consignee_id=?, shipment_date=?, currency=?,
        port_of_loading=?, port_of_destination=?, final_destination=?,
        shipping_type=?, shipped_per=?, container_number=?, container_type=?,
        cbm=?, freight_term=?, notes=?
       WHERE id=?`,
      [
        input.client_id, input.customs_consignee_id, input.shipment_date, input.currency,
        input.port_of_loading || null, input.port_of_destination || null,
        input.final_destination || null, input.shipping_type || null,
        input.shipped_per || null, firstContainer.container_number,
        firstContainer.container_type || null, firstContainer.cbm,
        input.freight_term || null, input.notes || null, req.params.id
      ]
    );
    await replaceShipmentStructure(connection, req.params.id, input, true);
    await connection.commit();
    res.json({ message: "Shipment updated." });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

shipmentsRouter.patch("/:id/gate-pass", requireAnyPermission("orders.edit", "gate_pass.edit"), asyncHandler(async (req, res) => {
  const input = gatePassSchema.parse(req.body);
  const [result] = await pool.execute(
    `UPDATE shipments SET clearing_agent_id=?, transporter_name=?, transporter_contact=?,
      transporter_phone=?, truck_number=?, driver_name=?, driver_phone=?, loading_address=?,
      delivery_address=?, seal_numbers=? WHERE id=? AND status NOT IN ('shipped','completed','cancelled')`,
    [
      input.clearing_agent_id, input.transporter_name || null, input.transporter_contact || null,
      input.transporter_phone || null, input.truck_number || null, input.driver_name || null,
      input.driver_phone || null, input.loading_address || null, input.delivery_address || null,
      sealValue(input.seal_numbers), req.params.id
    ]
  );
  if (!result.affectedRows) return res.status(409).json({ message: "Shipment not found or cannot be edited." });
  res.json({ message: "Gate pass information updated." });
}));

shipmentsRouter.patch("/:id/status", requirePermission("orders.confirm"), asyncHandler(async (req, res) => {
  const { status } = z.object({ status: z.enum(["draft", "ready_to_ship", "shipped", "completed", "cancelled"]) }).parse(req.body);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[shipment]] = await connection.execute("SELECT * FROM shipments WHERE id = ? FOR UPDATE", [req.params.id]);
    if (!shipment) {
      const error = new Error("Shipment not found.");
      error.status = 404;
      throw error;
    }
    if (shipment.status === "cancelled" && status !== "cancelled") {
      const error = new Error("A cancelled shipment cannot be reopened.");
      error.status = 409;
      throw error;
    }
    await connection.execute("UPDATE shipments SET status=? WHERE id=?", [status, req.params.id]);
    await connection.commit();
    res.json({ message: "Shipment status updated." });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}));

shipmentsRouter.post("/:id/document-audit", asyncHandler(async (req, res) => {
  const input = z.object({
    document_type: z.enum([
      "customs_packing_list", "customs_commercial_invoice", "client_packing_list",
      "client_commercial_invoice", "gate_pass", "bl_instructions", "certificate_of_origin"
    ]),
    action_name: z.enum(["previewed", "printed", "downloaded"])
  }).parse(req.body);
  const isPrint = input.action_name !== "previewed";
  const allowed = input.document_type === "gate_pass"
    ? req.user.permissions.includes(isPrint ? "gate_pass.print" : "gate_pass.view") || req.user.permissions.includes(isPrint ? "documents.print" : "documents.preview")
    : req.user.permissions.includes(isPrint ? "documents.print" : "documents.preview");
  if (!allowed) return res.status(403).json({ message: "You do not have permission for this document action." });
  await pool.execute(
    "INSERT INTO shipment_document_audit_logs (shipment_id, user_id, document_type, action_name) VALUES (?, ?, ?, ?)",
    [req.params.id, req.user.id, input.document_type, input.action_name]
  );
  res.status(201).json({ message: "Document activity recorded." });
}));
