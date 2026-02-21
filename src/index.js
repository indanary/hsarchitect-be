// index.js
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
const projectImagesRoutes = require("./routes/projectImages")
const contactRoutes = require("./routes/contact")
const mailRoutes = require("./routes/mail")
const projectMediaRoutes = require("./routes/projectMedia")
const studioMediaRoutes = require("./routes/studioMedia")

const {startSupabaseKeepAlive} = require("./storage/supabase")

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

/** CORS: allow your public site and dashboard via env list */
const allowed = (process.env.CORS_ALLOW_ORIGINS || "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean)

const corsOptions = {
	origin(origin, cb) {
		// allow no-origin (curl/healthchecks) and any whitelisted
		if (!origin || allowed.includes(origin)) return cb(null, true)
		return cb(new Error("Not allowed by CORS"))
	},
	methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
	credentials: false,
}

app.use(cors(corsOptions))
// Handle preflight for all routes (path-to-regexp v6-safe)
app.options(/.*/, cors(corsOptions))

/** Body parsing (keep small so files can’t sneak in via JSON) */
app.use(express.json({limit: "2mb"}))

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

/** Healthcheck */
app.get("/health", (_req, res) => res.json({ok: true}))

/** Routes */
app.use("/auth", authRoutes)
app.use("/project-types", projectTypeRoutes)
app.use("/projects", projectRoutes)
app.use("/projects", projectImagesRoutes) // image management
app.use("/projects", projectMediaRoutes)
app.use("/studio", studioRoutes)
app.use("/contact", contactRoutes)
app.use("/mail", mailRoutes)
app.use("/studio-media", studioMediaRoutes)

/** 404 */
app.use((_req, res) => res.status(404).json({error: "Not found"}))

/** Start */
const port = Number(process.env.PORT || 8080)
app.listen(port, () => {
	console.log(`API listening on http://localhost:${port}`)
	startSupabaseKeepAlive() // <-- start Supabase keep-alive here
})
