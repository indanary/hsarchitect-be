// src/utils/rebuild.js
// Clean, minimal version — only what `projects.js` needs.

const fetchFn = global.fetch
	? global.fetch.bind(global)
	: (...args) => import("node-fetch").then((m) => m.default(...args))

const GH_OWNER = process.env.GH_OWNER
const GH_REPO = process.env.GH_REPO
const GH_PAT = process.env.GH_PAT // Classic PAT: repo + workflow
const GH_REF = process.env.GH_REF || "prod"
const GH_WORKFLOW_ID = process.env.GH_WORKFLOW_ID // Numeric workflow ID (recommended)
const GH_WORKFLOW_FILE = process.env.GH_WORKFLOW_FILE || "deploy.yml"

// Build correct API URL for workflow_dispatch
function apiUrl() {
	if (GH_WORKFLOW_ID) {
		return `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW_ID}/dispatches`
	}
	return `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${GH_WORKFLOW_FILE}/dispatches`
}

// Sends workflow_dispatch to GitHub (not exported)
async function triggerRebuildForSlugs(slugs = [], deploy = true) {
	if (!GH_OWNER || !GH_REPO || !GH_PAT) {
		throw new Error(
			"Missing GH_OWNER, GH_REPO, or GH_PAT environment variables",
		)
	}

	const url = apiUrl()
	const body = {
		ref: GH_REF,
		inputs: {
			deploy: deploy ? "true" : "false",
			slugs: JSON.stringify(slugs.map(String)),
		},
	}

	const res = await fetchFn(url, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `token ${GH_PAT}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	})

	if (res.status !== 204) {
		const text = await res.text()
		throw new Error(`workflow_dispatch failed: ${res.status} ${text}`)
	}
}

// Debounce & batch multiple rebuild calls
let timer = null
let pendingIds = new Set()

function queueRebuild(idOrList, {deploy = true, debounceMs = 5000} = {}) {
	const ids = Array.isArray(idOrList) ? idOrList : [idOrList]
	ids.forEach((id) => pendingIds.add(String(id)))

	if (timer) clearTimeout(timer)

	timer = setTimeout(() => {
		const slugs = [...pendingIds]
		pendingIds.clear()
		timer = null

		triggerRebuildForSlugs(slugs, deploy).catch((err) =>
			console.error("[rebuild] failed:", err.message),
		)
	}, debounceMs)
}

module.exports = {
	queueRebuild,
}
