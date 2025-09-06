const express = require("express")
const rateLimit = require("express-rate-limit")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const {pool} = require("../db")

const r = express.Router()

const loginLimiter = rateLimit({
	windowMs: 10 * 60 * 1000, // 10 minutes
	max: 20, // 20 attempts / window
	standardHeaders: true,
	legacyHeaders: false,
})

/** POST /auth/login  body: { email, password } */
r.post("/login", loginLimiter, async (req, res) => {
	const {email, password} = req.body || {}
	if (!email || !password)
		return res.status(400).json({error: "email and password required"})

	const [rows] = await pool.execute(
		"SELECT id, email, password_hash, is_admin FROM users WHERE email = ? LIMIT 1",
		[email],
	)
	const user = rows[0]
	// do not reveal which part is wrong
	if (!user || !user.is_admin)
		return res.status(401).json({error: "Invalid credentials"})

	const ok = await bcrypt.compare(password, user.password_hash)
	if (!ok) return res.status(401).json({error: "Invalid credentials"})

	const token = jwt.sign(
		{sub: user.id, email: user.email, role: "admin"},
		process.env.JWT_SECRET,
		{expiresIn: process.env.JWT_EXPIRES_IN || "7d"},
	)

	res.json({accessToken: token, user: {id: user.id, email: user.email}})
})

module.exports = r
