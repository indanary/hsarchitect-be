async function startAivenKeepAlive(intervalMs = 5 * 60 * 1000) {
	const ping = async () => {
		try {
			// simple lightweight query
			await db.query("SELECT 1")
			console.log("Aiven keep-alive OK")
		} catch (err) {
			console.error("Aiven keep-alive failed:", err.message)
		}
	}

	// run immediately
	ping()

	// repeat
	setInterval(ping, intervalMs)
}

module.exports = {
	startAivenKeepAlive,
}
