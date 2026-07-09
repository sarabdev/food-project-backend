import { Router } from "express";
import { z } from "zod";
import { pool } from "../database/pool.js";
import { authenticate, requireAnyPermission, requirePermission } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

export const rolesRouter = Router();
rolesRouter.use(authenticate);

rolesRouter.get(
  "/",
  requireAnyPermission("users.view", "roles.manage"),
  asyncHandler(async (req, res) => {
    const [roles] = await pool.query(
      `SELECT r.*, GROUP_CONCAT(p.permission_key ORDER BY p.permission_key) AS permission_keys
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       GROUP BY r.id
       ORDER BY r.name`
    );
    const [permissions] = await pool.query(
      "SELECT * FROM permissions ORDER BY module_name, action_name"
    );
    res.json({
      roles: roles.map((role) => ({
        ...role,
        permissions: role.permission_keys ? role.permission_keys.split(",") : []
      })),
      permissions
    });
  })
);

rolesRouter.post(
  "/",
  requirePermission("roles.manage"),
  asyncHandler(async (req, res) => {
    const input = z.object({
      name: z.string().trim().min(2),
      description: z.string().trim().optional().nullable(),
      permission_ids: z.array(z.coerce.number().int().positive()).default([])
    }).parse(req.body);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        "INSERT INTO roles (name, description) VALUES (?, ?)",
        [input.name, input.description]
      );
      for (const permissionId of input.permission_ids) {
        await connection.execute(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
          [result.insertId, permissionId]
        );
      }
      await connection.commit();
      res.status(201).json({ id: result.insertId });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  })
);

rolesRouter.put(
  "/:id/permissions",
  requirePermission("roles.manage"),
  asyncHandler(async (req, res) => {
    const input = z.object({
      permission_ids: z.array(z.coerce.number().int().positive())
    }).parse(req.body);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM role_permissions WHERE role_id = ?", [req.params.id]);
      for (const permissionId of input.permission_ids) {
        await connection.execute(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)",
          [req.params.id, permissionId]
        );
      }
      await connection.commit();
      res.json({ message: "Role access updated." });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  })
);
