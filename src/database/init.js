import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";

const directory = path.dirname(fileURLToPath(import.meta.url));

const permissions = [
  ["dashboard.view", "dashboard", "view"],
  ["orders.view", "orders", "view"],
  ["orders.create", "orders", "create"],
  ["orders.edit", "orders", "edit"],
  ["orders.delete", "orders", "delete"],
  ["orders.confirm", "orders", "confirm"],
  ["documents.preview", "documents", "preview"],
  ["documents.print", "documents", "print"],
  ["gate_pass.view", "gate_pass", "view"],
  ["gate_pass.edit", "gate_pass", "edit"],
  ["gate_pass.print", "gate_pass", "print"],
  ["products.view", "products", "view"],
  ["products.create", "products", "create"],
  ["products.edit", "products", "edit"],
  ["products.delete", "products", "delete"],
  ["parties.view", "parties", "view"],
  ["parties.create", "parties", "create"],
  ["parties.edit", "parties", "edit"],
  ["parties.delete", "parties", "delete"],
  ["ledger.view", "ledger", "view"],
  ["ledger.record_payment", "ledger", "record_payment"],
  ["reports.view", "reports", "view"],
  ["users.view", "users", "view"],
  ["users.create", "users", "create"],
  ["users.edit", "users", "edit"],
  ["roles.manage", "roles", "manage"],
  ["settings.manage", "settings", "manage"]
];

async function initialize() {
  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    multipleStatements: true
  });

  await connection.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.db.database}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await connection.query(`USE \`${env.db.database}\``);
  const schema = await fs.readFile(path.join(directory, "schema.sql"), "utf8");
  await connection.query(schema);
  await ensureColumn(connection, "export_orders", "transporter_name", "VARCHAR(180) NULL AFTER clearing_agent_id");
  await ensureColumn(connection, "export_orders", "transporter_contact", "VARCHAR(120) NULL AFTER transporter_name");
  await ensureColumn(connection, "export_orders", "transporter_phone", "VARCHAR(60) NULL AFTER transporter_contact");
  await ensureColumn(connection, "products", "packaging_details", "JSON NULL AFTER pieces_per_unit");
  await migrateLegacyCartonPacking(connection);

  for (const [key, moduleName, actionName] of permissions) {
    await connection.execute(
      `INSERT INTO permissions (permission_key, module_name, action_name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE module_name = VALUES(module_name), action_name = VALUES(action_name)`,
      [key, moduleName, actionName]
    );
  }

  await connection.execute(
    `INSERT INTO roles (name, description, is_system)
     VALUES ('Administrator', 'Complete system access', TRUE)
     ON DUPLICATE KEY UPDATE description = VALUES(description)`
  );
  await connection.execute(
    `INSERT INTO roles (name, description, is_system)
     VALUES
       ('Documentation Officer', 'Creates orders and export documents', TRUE),
       ('Shipping Officer', 'Manages shipment and gate pass information', TRUE),
       ('Gate Pass Officer', 'Can view export orders and manage only gate pass information', TRUE),
       ('Viewer', 'Read-only access', TRUE)
     ON DUPLICATE KEY UPDATE description = VALUES(description)`
  );

  const [[adminRole]] = await connection.execute("SELECT id FROM roles WHERE name = 'Administrator'");
  await connection.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT ?, id FROM permissions`,
    [adminRole.id]
  );

  const [[docsRole]] = await connection.execute("SELECT id FROM roles WHERE name = 'Documentation Officer'");
  await connection.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT ?, id FROM permissions
     WHERE permission_key IN (
       'dashboard.view','orders.view','orders.create','orders.edit',
       'documents.preview','documents.print','products.view','parties.view',
       'ledger.view','ledger.record_payment','reports.view'
     )`,
    [docsRole.id]
  );

  const [[shippingRole]] = await connection.execute("SELECT id FROM roles WHERE name = 'Shipping Officer'");
  await connection.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT ?, id FROM permissions
     WHERE permission_key IN (
       'dashboard.view','orders.view','orders.edit',
       'documents.preview','documents.print','products.view','parties.view',
       'ledger.view','reports.view'
     )`,
    [shippingRole.id]
  );

  const [[viewerRole]] = await connection.execute("SELECT id FROM roles WHERE name = 'Viewer'");
  await connection.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT ?, id FROM permissions
     WHERE permission_key IN (
       'dashboard.view','orders.view','documents.preview','products.view','parties.view',
       'ledger.view','reports.view'
     )`,
    [viewerRole.id]
  );

  const [[gatePassRole]] = await connection.execute("SELECT id FROM roles WHERE name = 'Gate Pass Officer'");
  await connection.execute(
    `INSERT IGNORE INTO role_permissions (role_id, permission_id)
     SELECT ?, id FROM permissions
     WHERE permission_key IN (
       'orders.view','gate_pass.view','gate_pass.edit','gate_pass.print'
     )`,
    [gatePassRole.id]
  );

  const passwordHash = await bcrypt.hash("Admin@123", 12);
  await connection.execute(
    `INSERT INTO users (role_id, name, email, password_hash)
     VALUES (?, 'System Administrator', 'admin@zafood.local', ?)
     ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
    [adminRole.id, passwordHash]
  );
  await connection.execute(
    `INSERT INTO company_settings (
      id, company_name, tagline, address, phone, email, website,
      bank_details, default_sale_terms, invoice_prefix
    ) VALUES (
      1,
      'Z.A Food Industries',
      'Manufacturer & Exporter of Lollipop, Candies, Toffees, Bubble Gum, Chocolate, Jellies, Biscuit & Cookies',
      'P-61, School Stop, Marzi Pura, Narwala Road, Faisalabad, Pakistan',
      '+92 41 2690996',
      'zafoodindustry@hotmail.com',
      'www.zafood.net',
      JSON_OBJECT('bank', 'Standard Chartered Bank', 'currency', 'USD'),
      JSON_ARRAY(
        'Delivery and production schedules are subject to confirmation.',
        'Payment must be made according to the agreed payment terms.',
        'Shipping documents will be prepared from the confirmed order details.',
        'Any amendment after confirmation may affect delivery time and cost.'
      ),
      'ZAFI'
    )
    ON DUPLICATE KEY UPDATE company_name = VALUES(company_name)`
  );

  await connection.end();
  console.log("Database initialized.");
}

initialize().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function ensureColumn(connection, tableName, columnName, definition) {
  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [env.db.database, tableName, columnName]
  );
  if (!columns.length) {
    await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

async function migrateLegacyCartonPacking(connection) {
  const [products] = await connection.query(
    `SELECT id, units_per_carton, pieces_per_unit, packaging_details
     FROM products
     WHERE package_type = 'Carton'`
  );
  for (const product of products) {
    const details = typeof product.packaging_details === "string"
      ? JSON.parse(product.packaging_details || "{}")
      : product.packaging_details || {};
    const piecesPerPack = Number(details.pieces_per_pack ?? details.pieces_per_box ?? product.units_per_carton ?? 0);
    const packsPerCarton = Number(details.packs_per_carton ?? details.jars_per_carton ?? product.pieces_per_unit ?? 0);
    await connection.execute(
      `UPDATE products
       SET package_type = 'Jar', pieces_per_unit = ?, units_per_carton = ?,
         packaging_details = ?
       WHERE id = ?`,
      [
        piecesPerPack,
        packsPerCarton,
        JSON.stringify({ pieces_per_pack: piecesPerPack, packs_per_carton: packsPerCarton }),
        product.id
      ]
    );
  }
}
