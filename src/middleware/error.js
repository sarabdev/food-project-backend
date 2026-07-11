export function notFound(req, res) {
  res.status(404).json({ message: "Route not found." });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  console.error(error);

  if (error.code === "ER_DUP_ENTRY") {
    return res.status(409).json({ message: "A record with this value already exists." });
  }
  if (error.name === "ZodError") {
    return res.status(400).json({
      message: "Please correct the highlighted information.",
      errors: error.flatten()
    });
  }
  if (error.name === "MulterError") {
    return res.status(400).json({ message: error.message });
  }
  res.status(error.status || 500).json({
    message: error.status ? error.message : "Something went wrong on the server."
  });
}
