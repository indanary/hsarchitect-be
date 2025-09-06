const jwt = require("jsonwebtoken")

function requireAdmin(req, res, next) {
	try {
		const hdr = req.header("Authorization") || ""
		const m = hdr.match(/^Bearer\s+(.+)$/)
		if (!m) return res.status(401).json({error: "Missing token"})

		const payload = jwt.verify(m[1], process.env.JWT_SECRET)
		if (payload.role !== "admin")
			return res.status(403).json({error: "Forbidden"})

		req.user = payload // { sub, email, role }
		next()
	} catch (_) {
		return res.status(401).json({error: "Invalid token"})
	}
}

module.exports = {requireAdmin}
