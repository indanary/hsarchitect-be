// src/utils/rebuild.js
import fetch from "node-fetch"

const GH_OWNER = process.env.GH_OWNER
const GH_REPO = process.env.GH_REPO
const GH_PAT = process.env.GH_PAT // classic PAT with repo + workflow scopes
const GH_REF = process.env.GH_REF || "prod"
const GH_WORKFLOW_ID = process.env.GH_WORKFLOW_ID // set this once from the curl-list output

async function triggerRebuildForSlugs(slugs = [], reason = "projects_changed") {
	if (!GH_OWNER || !GH_REPO || !GH_PAT || !GH_WORKFLOW_ID) {
		throw new Error(
			"GH_OWNER, GH_REPO, GH_PAT, GH_WORKFLOW_ID are required",
		)
	}
	const payloadSlugs = Array.isArray(slugs) ? slugs.map(String) : []
	const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW_ID}/dispatches`

	const body = {
		ref: GH_REF,
		inputs: {
			deploy: "true",
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
