require("dotenv").config()
const express = require("express")
const cors = require("cors")
const helmet = require("helmet")
const morgan = require("morgan")
const rateLimit = require("express-rate-limit")

const authRoutes = require("./routes/auth")
const projectTypeRoutes = require("./routes/projectTypes")
const projectRoutes = require("./routes/projects")
const studioRoutes = require("./routes/studio")

const app = express()

/** Render / proxies */
app.set("trust proxy", 1)

/** Security headers (allow images/files to be consumed cross-origin) */
app.use(
	helmet({
		crossOriginResourcePolicy: {policy: "cross-origin"},
	}),
)

/** Logging */
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"))

/** Body parsing */
app.use(express.json({limit: "2mb"}))

/** CORS: allow your public site and dashboard */
const allowed = (process.env.CORS_ALLOW_ORIGINS || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)

app.use(
	cors({
		origin(origin, cb) {
			// allow no-origin (curl/healthchecks) and any whitelisted
			if (!origin || allowed.includes(origin)) return cb(null, true)
			return cb(new Error("Not allowed by CORS"))
		},
		methods: ["GET", "POST", "PATCH", "DELETE"],
		credentials: false,
	}),
)

/** Basic rate limit for public APIs */
app.use(
	"/",
	rateLimit({
		windowMs: 60 * 1000,
		max: 600, // adjust as needed
		standardHeaders: true,
		legacyHeaders: false,
	}),
)

/** Static uploads (mounted disk on Render or local folder) */
// const UPLOAD_DIR =
// 	process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads")
// if (!fs.existsSync(UPLOAD_DIR)) {
// 	fs.mkdirSync(UPLOAD_DIR, {recursive: true})
// }
// app.use("/uploads", express.static(UPLOAD_DIR))

/** Healthcheck */
app.get("/health", (_req, res) => res.json({ok: true}))

/** Routes */
app.use("/auth", authRoutes)
app.use("/project-types", projectTypeRoutes)
app.use("/projects", projectRoutes)
app.use("/studio", studioRoutes)

/** 404 */
app.use((_req, res) => res.status(404).json({error: "Not found"}))

/** Start */
const port = Number(process.env.PORT || 8080)
app.listen(port, () => console.log(`API listening on http://localhost:${port}`))
