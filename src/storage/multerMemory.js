const multer = require("multer")
const uploadMemory = multer({
	storage: multer.memoryStorage(),
	limits: {fileSize: 50 * 1024 * 1024}, // 50 MB
})
module.exports = {uploadMemory}
