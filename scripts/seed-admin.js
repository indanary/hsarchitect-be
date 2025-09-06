require("dotenv").config()
const bcrypt = require("bcryptjs")
const mysql = require("mysql2/promise")

;(async () => {
	const email = process.env.SEED_ADMIN_EMAIL || "admin@example.com"
	const password = process.env.SEED_ADMIN_PASSWORD || "secret123"

	const hash = await bcrypt.hash(password, 12)

	const conn = await mysql.createConnection({
		host: process.env.DB_HOST,
		port: process.env.DB_PORT,
		user: process.env.DB_USER,
		password: process.env.DB_PASS,
		database: process.env.DB_NAME,
	})

	await conn.execute(
		"INSERT INTO users (email, password_hash, is_admin) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash), is_admin=1",
		[email, hash],
	)

	console.log("Seeded admin:", email)
	await conn.end()
})().catch((e) => {
	console.error(e)
	process.exit(1)
})
