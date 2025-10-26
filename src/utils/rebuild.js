// src/utils/rebuild.js
import fetch from "node-fetch"

const GH_OWNER = process.env.GH_OWNER // e.g. "indanary"
const GH_REPO = process.env.GH_REPO // e.g. "hsarchitect-portfolio"
const GH_PAT = process.env.GH_PAT // PAT with Actions (workflows) write
const GH_REF = process.env.GH_REF || "prod" // branch where your workflow file lives
const WORKFLOW_FILE = process.env.GH_WORKFLOW_FILE || "deploy.yml" // .github/workflows/deploy.yml

async function triggerRebuildForSlugs(slugs = [], reason = "projects_changed") {
	if (!GH_OWNER || !GH_REPO || !GH_PAT) {
		throw new Error("GH_OWNER, GH_REPO, GH_PAT are required")
	}
	const payloadSlugs = Array.isArray(slugs) ? slugs.map(String) : []

	const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`
	const body = {
		ref: GH_REF, // branch to run on (e.g., "prod")
		inputs: {
			deploy: "true", // or "false" to build only
			// pass slugs JSON as a string; workflow picks this up into PRERENDER_SLUGS/.prerender_payload.json
			slugs: JSON.stringify(payloadSlugs),
			reason,
		},
	}

	const r = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `token ${GH_PAT}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	})

	if (!r.ok) {
		const text = await r.text()
		throw new Error(`workflow_dispatch failed: ${r.status} ${text}`)
	}
	return true
}

// Optional debounce for multiple edits
let rebuildTimer = null
export function queueRebuild(projectId) {
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

export {triggerRebuildForSlugs as triggerRebuild}
