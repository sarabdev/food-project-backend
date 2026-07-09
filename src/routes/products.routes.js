import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const productSchema = z.object({
  sku: z.string().trim().optional().nullable(),
  name: z.string().trim().min(2),
  description: z.string().trim().optional().nullable(),
  hs_code: z.string().trim().optional().nullable(),
  package_type: z.string().trim().default("Carton"),
  units_per_carton: z.coerce.number().min(0).default(0),
  pieces_per_unit: z.coerce.number().min(0).default(0),
  unit_weight_grams: z.coerce.number().min(0).default(0),
  net_weight_per_carton: z.coerce.number().min(0),
  gross_weight_per_carton: z.coerce.number().min(0),
  default_client_price: z.coerce.number().min(0).default(0),
  default_customs_price_per_kg: z.coerce.number().min(0).default(0),
  image_url: z.string().trim().optional().nullable()
});

export const productsRouter = Router();
productsRouter.use(authenticate);

productsRouter.get(
  "/",
  requirePermission("products.view"),
  asyncHandler(async (req, res) => {
    const [products] = await pool.query(
      "SELECT * FROM products WHERE is_active = TRUE ORDER BY name"
    );
    res.json({ products });
  })
);

productsRouter.post(
  "/",
  requirePermission("products.create"),
  asyncHandler(async (req, res) => {
    const input = productSchema.parse(req.body);
    const [result] = await pool.execute(
      `INSERT INTO products (
        sku, name, description, hs_code, package_type, units_per_carton,
        pieces_per_unit, unit_weight_grams, net_weight_per_carton,
        gross_weight_per_carton, default_client_price,
        default_customs_price_per_kg, image_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Object.values(input)
    );
    res.status(201).json({ id: result.insertId });
  })
);

productsRouter.put(
  "/:id",
  requirePermission("products.edit"),
  asyncHandler(async (req, res) => {
    const input = productSchema.parse(req.body);
    await pool.execute(
      `UPDATE products SET
        sku=?, name=?, description=?, hs_code=?, package_type=?, units_per_carton=?,
        pieces_per_unit=?, unit_weight_grams=?, net_weight_per_carton=?,
        gross_weight_per_carton=?, default_client_price=?,
        default_customs_price_per_kg=?, image_url=?
       WHERE id=?`,
      [...Object.values(input), req.params.id]
    );
    res.json({ message: "Product updated." });
  })
);

productsRouter.delete(
  "/:id",
  requirePermission("products.delete"),
  asyncHandler(async (req, res) => {
    await pool.execute("UPDATE products SET is_active = FALSE WHERE id = ?", [req.params.id]);
    res.status(204).end();
  })
);

