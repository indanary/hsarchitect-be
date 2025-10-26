// src/utils/rebuild.js
import fetch from "node-fetch"

const GH_OWNER = process.env.GH_OWNER
const GH_REPO = process.env.GH_REPO
const GH_PAT = process.env.GH_PAT // classic PAT with repo + workflow
const GH_REF = process.env.GH_REF || "prod"
const GH_WORKFLOW_ID = process.env.GH_WORKFLOW_ID // numeric id

async function triggerRebuildForSlugs(
	slugs = [],
	_reason = "projects_changed",
) {
	const payloadSlugs = Array.isArray(slugs) ? slugs.map(String) : []
	const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW_ID}/dispatches`

	const body = {
		ref: GH_REF,
		inputs: {
			deploy: "true",
			slugs: JSON.stringify(payloadSlugs), // must be string
			// reason: <REMOVE THIS>               // ✖ don't send reason unless YAML defines it
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

export {triggerRebuildForSlugs as triggerRebuild}
