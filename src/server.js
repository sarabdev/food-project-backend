import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { pool } from "./database/pool.js";
import { authRouter } from "./routes/auth.routes.js";
import { dashboardRouter } from "./routes/dashboard.routes.js";
import { productsRouter } from "./routes/products.routes.js";
import { partiesRouter } from "./routes/parties.routes.js";
import { rolesRouter } from "./routes/roles.routes.js";
import { usersRouter } from "./routes/users.routes.js";
import { ordersRouter } from "./routes/orders.routes.js";
import { errorHandler, notFound } from "./middleware/error.js";

const app = express();

app.use(cors({ origin: env.clientUrl }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok", service: "za-food-api" });
});

app.use("/api/auth", authRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/products", productsRouter);
app.use("/api/parties", partiesRouter);
app.use("/api/roles", rolesRouter);
app.use("/api/users", usersRouter);
app.use("/api/orders", ordersRouter);

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`ZA Food API listening on http://localhost:${env.port}`);
});

