import { Router } from "express";
import fs from "fs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const productImageDir = path.resolve(__dirname, "../../uploads/products");
fs.mkdirSync(productImageDir, { recursive: true });

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: productImageDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const basename = path
        .basename(file.originalname, extension)
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase() || "product";
      callback(null, `${Date.now()}-${basename}${extension}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    if (file.mimetype.startsWith("image/")) return callback(null, true);
    const error = new Error("Only image files can be uploaded.");
    error.status = 400;
    callback(error);
  },
  limits: { fileSize: 5 * 1024 * 1024 }
});

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
  imageUpload.single("image"),
  asyncHandler(async (req, res) => {
    const input = productSchema.parse({
      ...req.body,
      image_url: req.file ? `/api/uploads/products/${req.file.filename}` : req.body.image_url
    });
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
  imageUpload.single("image"),
  asyncHandler(async (req, res) => {
    const input = productSchema.parse({
      ...req.body,
      image_url: req.file ? `/api/uploads/products/${req.file.filename}` : req.body.image_url
    });
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
