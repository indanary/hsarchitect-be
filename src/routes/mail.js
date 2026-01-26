const express = require("express")
const {getUnreadCount} = require("../mail/imapClient")

const router = express.Router()

router.get("/unread-count", async (_req, res) => {
	try {
		const unread = await getUnreadCount()
		res.json({unread})
	} catch (err) {
		res.status(500).json({
			error: "MAIL_SERVICE_ERROR",
			message: "Failed to connect to mail server",
		})
	}
})

module.exports = router
