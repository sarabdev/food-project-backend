CREATE TABLE IF NOT EXISTS permissions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  permission_key VARCHAR(100) NOT NULL UNIQUE,
  module_name VARCHAR(60) NOT NULL,
  action_name VARCHAR(40) NOT NULL,
  description VARCHAR(255) NULL
);

CREATE TABLE IF NOT EXISTS roles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,
  description VARCHAR(255) NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_role_permission_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permission_permission FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  phone VARCHAR(40) NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_role FOREIGN KEY (role_id) REFERENCES roles(id)
);

CREATE TABLE IF NOT EXISTS parties (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  party_type ENUM('client', 'customs_consignee', 'clearing_agent') NOT NULL,
  name VARCHAR(180) NOT NULL,
  contact_person VARCHAR(120) NULL,
  business_id VARCHAR(100) NULL,
  phone VARCHAR(60) NULL,
  email VARCHAR(190) NULL,
  address_line_1 VARCHAR(255) NULL,
  address_line_2 VARCHAR(255) NULL,
  city VARCHAR(100) NULL,
  state_region VARCHAR(100) NULL,
  country VARCHAR(100) NULL,
  postal_code VARCHAR(30) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_parties_type (party_type)
);

CREATE TABLE IF NOT EXISTS products (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(80) NULL UNIQUE,
  name VARCHAR(180) NOT NULL,
  description VARCHAR(500) NULL,
  hs_code VARCHAR(40) NULL,
  package_type VARCHAR(40) NOT NULL DEFAULT 'Carton',
  units_per_carton DECIMAL(12,3) NOT NULL DEFAULT 0,
  pieces_per_unit DECIMAL(12,3) NOT NULL DEFAULT 0,
  unit_weight_grams DECIMAL(12,3) NOT NULL DEFAULT 0,
  net_weight_per_carton DECIMAL(12,3) NOT NULL DEFAULT 0,
  gross_weight_per_carton DECIMAL(12,3) NOT NULL DEFAULT 0,
  default_client_price DECIMAL(14,4) NOT NULL DEFAULT 0,
  default_customs_price_per_kg DECIMAL(14,4) NOT NULL DEFAULT 0,
  image_url VARCHAR(500) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS company_settings (
  id TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
  company_name VARCHAR(180) NOT NULL,
  tagline VARCHAR(255) NULL,
  address VARCHAR(500) NULL,
  phone VARCHAR(100) NULL,
  email VARCHAR(190) NULL,
  website VARCHAR(190) NULL,
  bank_details JSON NULL,
  default_sale_terms JSON NULL,
  invoice_prefix VARCHAR(20) NOT NULL DEFAULT 'ZAFI',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS export_orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  invoice_number VARCHAR(50) NOT NULL UNIQUE,
  sequence_number INT UNSIGNED NOT NULL,
  sequence_year SMALLINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  customs_consignee_id BIGINT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  status ENUM('draft', 'confirmed', 'in_production', 'ready_to_ship', 'shipped', 'completed', 'cancelled') NOT NULL DEFAULT 'draft',
  contract_date DATE NOT NULL,
  valid_until DATE NULL,
  sales_contract_number VARCHAR(80) NULL,
  payment_term VARCHAR(255) NULL,
  advance_percentage DECIMAL(5,2) NOT NULL DEFAULT 0,
  freight_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  port_of_loading VARCHAR(120) NULL,
  port_of_destination VARCHAR(120) NULL,
  final_destination VARCHAR(120) NULL,
  shipping_type VARCHAR(60) NULL,
  shipped_per VARCHAR(60) NULL,
  vessel_name VARCHAR(150) NULL,
  voyage_number VARCHAR(100) NULL,
  bl_number VARCHAR(100) NULL,
  bl_date DATE NULL,
  container_number VARCHAR(120) NULL,
  container_type VARCHAR(80) NULL,
  cbm DECIMAL(12,3) NOT NULL DEFAULT 0,
  freight_term VARCHAR(80) NULL,
  truck_number VARCHAR(80) NULL,
  driver_name VARCHAR(120) NULL,
  driver_phone VARCHAR(60) NULL,
  clearing_agent_id BIGINT UNSIGNED NULL,
  transporter_name VARCHAR(180) NULL,
  transporter_contact VARCHAR(120) NULL,
  transporter_phone VARCHAR(60) NULL,
  loading_address VARCHAR(255) NULL,
  delivery_address VARCHAR(255) NULL,
  seal_numbers JSON NULL,
  customer_instructions TEXT NULL,
  shipping_instructions TEXT NULL,
  notes TEXT NULL,
  confirmed_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_client FOREIGN KEY (client_id) REFERENCES parties(id),
  CONSTRAINT fk_order_customs_consignee FOREIGN KEY (customs_consignee_id) REFERENCES parties(id),
  CONSTRAINT fk_order_user FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_order_clearing_agent FOREIGN KEY (clearing_agent_id) REFERENCES parties(id),
  UNIQUE KEY uq_order_sequence (sequence_year, sequence_number),
  INDEX idx_orders_status (status),
  INDEX idx_orders_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS export_order_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  export_order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  line_number INT UNSIGNED NOT NULL,
  carton_start INT UNSIGNED NULL,
  carton_end INT UNSIGNED NULL,
  quantity DECIMAL(12,3) NOT NULL,
  quantity_unit VARCHAR(30) NOT NULL DEFAULT 'CTN',
  units_per_carton DECIMAL(12,3) NOT NULL DEFAULT 0,
  net_weight_per_carton DECIMAL(12,3) NOT NULL DEFAULT 0,
  gross_weight_per_carton DECIMAL(12,3) NOT NULL DEFAULT 0,
  client_price_per_carton DECIMAL(14,4) NOT NULL DEFAULT 0,
  customs_price_per_kg DECIMAL(14,4) NOT NULL DEFAULT 0,
  is_sample BOOLEAN NOT NULL DEFAULT FALSE,
  description_override VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_item_order FOREIGN KEY (export_order_id) REFERENCES export_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_item_product FOREIGN KEY (product_id) REFERENCES products(id),
  UNIQUE KEY uq_order_line (export_order_id, line_number)
);

CREATE TABLE IF NOT EXISTS document_audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  export_order_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  document_type ENUM(
    'sale_contract',
    'customs_packing_list',
    'customs_commercial_invoice',
    'client_packing_list',
    'client_commercial_invoice',
    'gate_pass',
    'bl_instructions',
    'certificate_of_origin'
  ) NOT NULL,
  action_name ENUM('previewed', 'printed', 'downloaded') NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_order FOREIGN KEY (export_order_id) REFERENCES export_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id)
);
