export async function recordStockMovement(connection, {
  productId,
  movementDate = null,
  movementType,
  quantityChange,
  exportOrderId = null,
  referenceNumber = null,
  notes = null,
  lowStockAlert = null,
  netWeightPerCarton = null,
  grossWeightPerCarton = null,
  clientPricePerCarton = null,
  customsPricePerKg = null,
  createdBy
}) {
  if (!Number(quantityChange)) return;
  await connection.execute(
    `INSERT INTO stock_movements (
      product_id, movement_date, movement_type, quantity_change,
      export_order_id, reference_number, notes, low_stock_alert,
      net_weight_per_carton, gross_weight_per_carton,
      client_price_per_carton, customs_price_per_kg, created_by
    ) VALUES (?, COALESCE(?, CURDATE()), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      productId,
      movementDate,
      movementType,
      quantityChange,
      exportOrderId,
      referenceNumber,
      notes,
      lowStockAlert,
      netWeightPerCarton,
      grossWeightPerCarton,
      clientPricePerCarton,
      customsPricePerKg,
      createdBy
    ]
  );
}
