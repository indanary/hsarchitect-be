require("dotenv").config()
const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const morgan = require("morgan")

const authRoutes = require("./routes/auth")

const app = express()

app.use(helmet())
app.use(morgan("tiny"))
app.use(express.json())

app.use(
	cors({
		origin: [process.env.DASHBOARD_ORIGIN || "http://localhost:9000"],
		credentials: false, // we use Authorization header, not cookies
	}),
)

app.get("/health", (_req, res) => res.json({ok: true}))

app.use("/auth", authRoutes)

// 404
app.use((_req, res) => res.status(404).json({error: "Not found"}))

const port = Number(process.env.PORT || 8080)
app.listen(port, () => console.log(`API listening on http://localhost:${port}`))
