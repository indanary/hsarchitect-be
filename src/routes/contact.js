// routes/contact.js
const express = require("express")
const rateLimit = require("express-rate-limit")
const nodemailer = require("nodemailer")
const {isLength, escape} = require("validator")

const r = express.Router()

// rate limiter: e.g. 5 requests per minute per IP
const limiter = rateLimit({
	windowMs: 60 * 1000, // 1 minute
	max: 5,
	message: {
		success: false,
		error: "Too many requests, please try again later.",
	},
})

// Apply to this router only
r.use(limiter)

// Helper: sanitize and trim
function cleanInput(value) {
	if (typeof value !== "string") return ""
	const trimmed = value.trim()
	return escape(trimmed) // simple HTML escape
}

// POST /contact
r.post("/", async (req, res) => {
	try {
		// If you use body-parser JSON + urlencoded, FormData will be parsed as urlencoded
		const name = cleanInput(req.body?.name ?? "")
		const company = cleanInput(req.body?.company ?? "")
		const subject = cleanInput(req.body?.subject ?? "Contact from website")
		const message = cleanInput(req.body?.message ?? "")

		// basic validation
		if (!name || !message) {
			return res
				.status(400)
				.json({success: false, error: "Name and message are required."})
		}
		if (
			!isLength(name, {min: 1, max: 200}) ||
			!isLength(message, {min: 1, max: 5000})
		) {
			return res
				.status(400)
				.json({success: false, error: "Invalid input length."})
		}

		// Create nodemailer transporter (SMTP) - read config from env
		// Set these env vars in your production env: SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
		const transporter = nodemailer.createTransport({
			host: process.env.SMTP_HOST || "mail.hsarchitect.id",
			port: Number(process.env.SMTP_PORT || 587),
			secure: false, // STARTTLS on 587
			auth: {
				user: process.env.SMTP_USER || "hsas1579@hsarchitect.id",
				pass: process.env.SMTP_PASS || "", // make sure this is set in env
			},
			tls: {
				// allow self-signed / cPanel cert mismatch if any
				rejectUnauthorized: false,
			},
			connectionTimeout: 10_000, // optional, 10 seconds
		})

		// Build email
		const toAddress =
			process.env.CONTACT_TO ||
			process.env.SMTP_USER ||
			"hsas1579@hsarchitect.id"
		const fromAddress =
			process.env.FROM_ADDRESS ||
			process.env.SMTP_USER ||
			"hsas1579@hsarchitect.id"

		const htmlBody = `
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Company:</strong> ${company}</p>
      <p><strong>Message:</strong><br/>${message.replace(/\n/g, "<br/>")}</p>
      <hr/>
      <p>Sent from hsarchitect website</p>
    `

		const mailOptions = {
			from: `"hsarchitect website" <${fromAddress}>`,
			to: toAddress,
			subject: subject,
			html: htmlBody,
			text: `Name: ${name}\nCompany: ${company}\n\nMessage:\n${message}\n`,
			replyTo: name ? `${name} <${req.body?.email || ""}>` : undefined, // if you capture visitor email, set it
		}

		// send mail
		await transporter.sendMail(mailOptions)

		return res.json({success: true})
	} catch (err) {
		console.error("Contact send error:", err)
		return res
			.status(500)
			.json({success: false, error: "Failed to send message"})
	}
})

module.exports = r
