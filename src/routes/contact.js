// routes/contact.js
const express = require("express")
const rateLimit = require("express-rate-limit")
const {isLength, escape} = require("validator")
const {Resend} = require("resend")

const r = express.Router()

// init Resend client with API key from env
const resend = new Resend(process.env.RESEND_API_KEY)

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
		const name = cleanInput(req.body?.name ?? "")
		const company = cleanInput(req.body?.company ?? "")
		const subject = cleanInput(req.body?.subject ?? "Contact from website")
		const message = cleanInput(req.body?.message ?? "")
		const visitorEmail = cleanInput(req.body?.email ?? "")

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

		const toAddress = process.env.CONTACT_TO || "hsas1579@hsarchitect.id"

		// IMPORTANT:
		// `from` must be a sender allowed by Resend.
		// For first test, you can use something like:
		// "Acme <onboarding@resend.dev>" or a verified domain sender.
		const fromAddress =
			process.env.FROM_ADDRESS || "hsarchitect <onboarding@resend.dev>"

		const htmlBody = `
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Company:</strong> ${company}</p>
      <p><strong>Message:</strong><br/>${message.replace(/\n/g, "<br/>")}</p>
      ${
			visitorEmail
				? `<p><strong>Visitor Email:</strong> ${visitorEmail}</p>`
				: ""
		}
      <hr/>
      <p>Sent from hsarchitect website</p>
    `

		const textBody =
			`Name: ${name}\n` +
			`Company: ${company}\n` +
			(visitorEmail ? `Visitor Email: ${visitorEmail}\n\n` : "\n") +
			`Message:\n${message}\n`

		const {data, error} = await resend.emails.send({
			from: fromAddress,
			to: [toAddress],
			subject,
			html: htmlBody,
			text: textBody,
			// replyTo: if you want direct reply to visitor email
			...(visitorEmail ? {replyTo: visitorEmail} : {}),
		})

		if (error) {
			console.error("Resend send error:", error)
			return res
				.status(500)
				.json({success: false, error: "Failed to send message"})
		}

		// you can log data.id if you want
		// console.log("Resend email id:", data.id)

		return res.json({success: true})
	} catch (err) {
		console.error("Contact send error:", err)
		return res
			.status(500)
			.json({success: false, error: "Failed to send message"})
	}
})

module.exports = r
