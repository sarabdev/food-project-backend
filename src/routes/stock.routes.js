import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { recordStockMovement } from "../services/stockMovements.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const manualMovementTypes = [
  "restock", "customer_return", "damage", "adjustment_in", "adjustment_out"
];

const movementSchema = z.object({
  product_id: z.coerce.number().int().positive(),
  movement_date: z.string().date(),
  movement_type: z.enum(manualMovementTypes),
  quantity: z.coerce.number().positive(),
  reference_number: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  low_stock_alert: z.coerce.number().min(0).optional(),
  net_weight_per_carton: z.coerce.number().min(0).optional(),
  gross_weight_per_carton: z.coerce.number().min(0).optional(),
  default_client_price: z.coerce.number().min(0).optional(),
  default_customs_price_per_kg: z.coerce.number().min(0).optional()
}).superRefine((input, context) => {
  if (input.movement_type !== "restock") return;
  for (const field of [
    "low_stock_alert",
    "net_weight_per_carton",
    "gross_weight_per_carton",
    "default_client_price",
    "default_customs_price_per_kg"
  ]) {
    if (input[field] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: "Required for restock entries"
      });
    }
  }
});

const reportSchema = z.object({
  date_from: z.union([z.string().date(), z.literal("")]).optional(),
  date_to: z.union([z.string().date(), z.literal("")]).optional(),
  product_id: z.union([z.coerce.number().int().positive(), z.literal("")]).optional()
});

function signedQuantity(type, quantity) {
  return ["damage", "adjustment_out"].includes(type) ? -quantity : quantity;
}

export const stockRouter = Router();
stockRouter.use(authenticate);

stockRouter.get(
  "/products",
  requirePermission("stock.view"),
  asyncHandler(async (req, res) => {
    const [products] = await pool.query(
      `SELECT id, sku, name, package_type, units_per_carton,
        stock_in_hand, low_stock_alert, net_weight_per_carton,
        gross_weight_per_carton, default_client_price,
        default_customs_price_per_kg
       FROM products
       WHERE is_active = TRUE
       ORDER BY name`
    );
    res.json({ products });
  })
);

stockRouter.get(
  "/movements",
  requirePermission("stock.view"),
  asyncHandler(async (req, res) => {
    const filters = reportSchema.parse(req.query);
    const productConditions = ["p.is_active = TRUE"];
    const productValues = [];
    if (filters.product_id) {
      productConditions.push("p.id = ?");
      productValues.push(filters.product_id);
    }

    const [products] = await pool.execute(
      `SELECT p.id, p.sku, p.name, p.package_type, p.units_per_carton,
        p.stock_in_hand, p.low_stock_alert
       FROM products p
       WHERE ${productConditions.join(" AND ")}
       ORDER BY p.name`,
      productValues
    );

    const movementConditions = ["p.is_active = TRUE"];
    const movementValues = [];
    if (filters.product_id) {
      movementConditions.push("sm.product_id = ?");
      movementValues.push(filters.product_id);
    }
    if (filters.date_from) {
      movementConditions.push("sm.movement_date >= ?");
      movementValues.push(filters.date_from);
    }
    if (filters.date_to) {
      movementConditions.push("sm.movement_date <= ?");
      movementValues.push(filters.date_to);
    }

    const openingConditions = ["1 = 1"];
    const openingValues = [];
    if (filters.product_id) {
      openingConditions.push("product_id = ?");
      openingValues.push(filters.product_id);
    }
    if (filters.date_from) {
      openingConditions.push("movement_date < ?");
      openingValues.push(filters.date_from);
    } else {
      openingConditions.push("1 = 0");
    }

    const [openingRows] = await pool.execute(
      `SELECT product_id, COALESCE(SUM(quantity_change), 0) AS opening_balance
       FROM stock_movements
       WHERE ${openingConditions.join(" AND ")}
       GROUP BY product_id`,
      openingValues
    );
    const [movements] = await pool.execute(
      `SELECT sm.id, sm.product_id, sm.movement_date, sm.movement_type,
        sm.quantity_change, sm.reference_number, sm.notes, sm.created_at,
        sm.low_stock_alert, sm.net_weight_per_carton,
        sm.gross_weight_per_carton, sm.client_price_per_carton,
        sm.customs_price_per_kg,
        p.name AS product_name, p.sku, p.package_type,
        o.invoice_number, u.name AS recorded_by
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       LEFT JOIN export_orders o ON o.id = sm.export_order_id
       JOIN users u ON u.id = sm.created_by
       WHERE ${movementConditions.join(" AND ")}
       ORDER BY sm.movement_date, sm.created_at, sm.id`,
      movementValues
    );

    const openingByProduct = new Map(
      openingRows.map((row) => [Number(row.product_id), Number(row.opening_balance)])
    );
    const runningByProduct = new Map(openingByProduct);
    const transactions = movements.map((movement) => {
      const productId = Number(movement.product_id);
      const runningBalance = (runningByProduct.get(productId) || 0)
        + Number(movement.quantity_change);
      runningByProduct.set(productId, runningBalance);
      return { ...movement, running_balance: runningBalance };
    });
    const summary = products.map((product) => {
      const productMovements = movements.filter(
        (movement) => Number(movement.product_id) === Number(product.id)
      );
      const openingBalance = openingByProduct.get(Number(product.id)) || 0;
      const stockIn = productMovements.reduce(
        (sum, movement) => sum + Math.max(Number(movement.quantity_change), 0),
        0
      );
      const stockOut = productMovements.reduce(
        (sum, movement) => sum + Math.max(-Number(movement.quantity_change), 0),
        0
      );
      return {
        ...product,
        opening_balance: openingBalance,
        stock_in: stockIn,
        stock_out: stockOut,
        closing_balance: openingBalance + stockIn - stockOut
      };
    });

    res.json({ summary, transactions });
  })
);

stockRouter.post(
  "/movements",
  requirePermission("stock.record"),
  asyncHandler(async (req, res) => {
    const input = movementSchema.parse(req.body);
    const quantityChange = signedQuantity(input.movement_type, input.quantity);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[product]] = await connection.execute(
        `SELECT id, name, package_type, stock_in_hand, is_active
         FROM products
         WHERE id = ?
         FOR UPDATE`,
        [input.product_id]
      );
      if (!product || !product.is_active) {
        const error = new Error("Product is unavailable.");
        error.status = 404;
        throw error;
      }
      const updatedStock = Number(product.stock_in_hand) + quantityChange;
      if (updatedStock < -0.0001) {
        const error = new Error(
          `Insufficient stock. ${product.name} currently has ${Number(product.stock_in_hand).toLocaleString()} ${String(product.package_type).toLowerCase()}s.`
        );
        error.status = 409;
        throw error;
      }
      await connection.execute(
        "UPDATE products SET stock_in_hand = stock_in_hand + ? WHERE id = ?",
        [quantityChange, input.product_id]
      );
      if (input.movement_type === "restock") {
        await connection.execute(
          `UPDATE products SET
            low_stock_alert=?, net_weight_per_carton=?,
            gross_weight_per_carton=?, default_client_price=?,
            default_customs_price_per_kg=?
           WHERE id=?`,
          [
            input.low_stock_alert,
            input.net_weight_per_carton,
            input.gross_weight_per_carton,
            input.default_client_price,
            input.default_customs_price_per_kg,
            input.product_id
          ]
        );
      }
      await recordStockMovement(connection, {
        productId: input.product_id,
        movementDate: input.movement_date,
        movementType: input.movement_type,
        quantityChange,
        referenceNumber: input.reference_number || null,
        notes: input.notes || null,
        lowStockAlert: input.movement_type === "restock" ? input.low_stock_alert : null,
        netWeightPerCarton: input.movement_type === "restock" ? input.net_weight_per_carton : null,
        grossWeightPerCarton: input.movement_type === "restock" ? input.gross_weight_per_carton : null,
        clientPricePerCarton: input.movement_type === "restock" ? input.default_client_price : null,
        customsPricePerKg: input.movement_type === "restock" ? input.default_customs_price_per_kg : null,
        createdBy: req.user.id
      });
      await connection.commit();
      res.status(201).json({ stock_in_hand: updatedStock });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  })
);
