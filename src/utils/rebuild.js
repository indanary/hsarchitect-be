// src/utils/rebuild.js
// backend utility to trigger a repository_dispatch that includes an array of slugs
import fetch from "node-fetch"

const GH_OWNER = process.env.GH_OWNER // e.g. "indanary"
const GH_REPO = process.env.GH_REPO // e.g. "hsarchitect-portfolio"
const GH_PAT = process.env.GH_PAT // fine-grained PAT with workflows + repo access

async function triggerRebuildForSlugs(slugs = [], reason = "projects_changed") {
	if (!GH_OWNER || !GH_REPO || !GH_PAT) {
		throw new Error(
			"GH_OWNER, GH_REPO, and GH_PAT environment variables are required",
		)
	}

	// normalize slugs array
	const payloadSlugs = Array.isArray(slugs) ? slugs.map(String) : []
	const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/dispatches`

	const body = {
		event_type: "rebuild",
		client_payload: {
			reason,
			slugs: payloadSlugs,
		},
	}

	const r = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			// use 'token' authorization which is broadly supported
			Authorization: `token ${GH_PAT}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	})

	if (!r.ok) {
		const text = await r.text()
		throw new Error(`repository_dispatch failed: ${r.status} ${text}`)
	}

	return true
}

// Optional: keep the convenience wrapper that single-updates call-sites may use
let rebuildTimer = null
export function queueRebuild(projectId) {
	// projectId can be string/number or an array of ids
	const ids =
		projectId == null
			? []
			: Array.isArray(projectId)
			? projectId
			: [projectId]

	if (rebuildTimer) clearTimeout(rebuildTimer)
	rebuildTimer = setTimeout(() => {
		triggerRebuildForSlugs(ids).catch(console.error)
	}, 10_000)
}

// Also export the explicit function for direct usage
export {triggerRebuildForSlugs as triggerRebuild}
