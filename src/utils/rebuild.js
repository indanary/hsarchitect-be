// somewhere in your admin backend (Node/Express)
import fetch from "node-fetch"

const GH_OWNER = process.env.GH_OWNER // e.g. "indanary"
const GH_REPO = process.env.GH_REPO // e.g. "hsarchitect-portfolio"
const GH_PAT = process.env.GH_PAT // fine-grained PAT with "workflows" + repo access

async function triggerRebuild(projectId, reason = "projects_changed") {
	const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/dispatches`
	const r = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${GH_PAT}`,
		},
		body: JSON.stringify({
			event_type: "rebuild",
			client_payload: {reason, projectId},
		}),
	})
	if (!r.ok) {
		const text = await r.text()
		throw new Error(`repository_dispatch failed: ${r.status} ${text}`)
	}
}

// Optional: debounce so many edits in a minute trigger one build
let rebuildTimer = null
export function queueRebuild(projectId) {
	if (rebuildTimer) clearTimeout(rebuildTimer)
	rebuildTimer = setTimeout(() => {
		triggerRebuild(projectId).catch(console.error)
	}, 10_000)
}
