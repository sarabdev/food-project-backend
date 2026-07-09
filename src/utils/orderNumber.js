export async function reserveInvoiceNumber(connection, prefix = "ZAFI") {
  const year = new Date().getFullYear();
  const [[latest]] = await connection.execute(
    `SELECT COALESCE(MAX(sequence_number), 0) AS current_sequence
     FROM export_orders
     WHERE sequence_year = ?
     FOR UPDATE`,
    [year]
  );
  const sequence = latest.current_sequence + 1;
  return {
    sequence,
    year,
    invoiceNumber: `${prefix}-${String(sequence).padStart(3, "0")}/${year}`
  };
}

