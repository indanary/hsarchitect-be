const {createClient} = require("@supabase/supabase-js")

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const bucket = process.env.SUPABASE_BUCKET || "projects"
const publicBase = (process.env.SUPABASE_PUBLIC_BASE || "").replace(/\/+$/, "")

if (!url || !serviceKey) {
	console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
}

const supabaseAdmin = createClient(url, serviceKey, {
	auth: {persistSession: false},
})

/** Build an object path for a project image */
function objectKeyForProject(projectId, originalName) {
	const safe = `${Date.now()}-${(originalName || "file").replace(
		/\s+/g,
		"-",
	)}`
	return `projects/${projectId}/${safe}` // subfolder inside bucket
}

/** Get a public URL for an object path */
function toPublicFileUrl(objectPath) {
	// Option A: build manually using the well-known public URL format:
	if (publicBase)
		return `${publicBase}/${bucket}/${encodeURIComponent(objectPath)}`

	// Option B: ask Supabase to generate it:
	const {data} = supabaseAdmin.storage.from(bucket).getPublicUrl(objectPath)
	return data.publicUrl
}

// export with the rest
async function createSignedUploadForProject(projectId, originalName) {
	const key = objectKeyForProject(projectId, originalName)
	const {data, error} = await supabaseAdmin.storage
		.from(bucket)
		.createSignedUploadUrl(key) // returns { token }
	if (error) throw error
	return {key, token: data.token}
}

function toPublicTransformedUrl(objectPath, _transform = {width: 800}) {
	// Fallback: no actual transform, just use regular public URL
	return toPublicFileUrl(objectPath)
}

// -------- SUPABASE STORAGE KEEP-ALIVE --------
function startSupabaseKeepAlive(intervalMs = 10 * 60 * 1000) {
	if (!url) {
		console.warn("SUPABASE_URL not set — skipping Supabase keep-alive")
		return
	}

	const ping = async () => {
		try {
			// Touch storage to keep the bucket active
			await supabaseAdmin.storage.listBuckets()
			console.log("Supabase Storage keep-alive OK")
		} catch (err) {
			console.error("Supabase keep-alive failed:", err.message)
		}
	}

	// Run once immediately
	ping()

	// Then every 5 minutes
	setInterval(ping, intervalMs)
}

module.exports = {
	supabaseAdmin,
	bucket,
	objectKeyForProject,
	toPublicFileUrl,
	createSignedUploadForProject,
	toPublicTransformedUrl,
	startSupabaseKeepAlive,
}
