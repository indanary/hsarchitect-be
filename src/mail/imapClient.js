const Imap = require("imap-simple")

const config = {
	imap: {
		user: process.env.MAIL_USER,
		password: process.env.MAIL_PASS,
		host: process.env.MAIL_HOST,
		port: Number(process.env.MAIL_PORT),
		tls: true,
		authTimeout: 5000,

		// ✅ FIX for Rumahweb shared cert
		tlsOptions: {
			rejectUnauthorized: false,
		},
	},
}

async function getUnreadCount() {
	let connection

	try {
		connection = await Imap.connect(config)
		await connection.openBox("INBOX")

		const searchCriteria = ["UNSEEN"]
		const fetchOptions = {
			bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)"],
			markSeen: false,
		}

		const messages = await connection.search(searchCriteria, fetchOptions)

		return messages.length
	} catch (err) {
		console.error("MAIL IMAP ERROR:", err.message)
		throw err
	} finally {
		if (connection) {
			await connection.end()
		}
	}
}

module.exports = {getUnreadCount}
