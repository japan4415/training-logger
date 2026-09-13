import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const skillDir = path.join(rootDir, "skills", "log-workout");
const publicSkillDir = path.join(rootDir, "public", "skills", "log-workout");
const publicZipPath = path.join(rootDir, "public", "skills", "log-workout.zip");

// 固定日時: 2026-01-01 00:00:00 (再現可能な決定論的 ZIP 生成のため)
const FIXED_DOS_TIME = 0; // 00:00:00
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01 -> 0x5C21

function collectFiles(dir, baseRel = "") {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	// 再現性のため名前順ソート
	entries.sort((a, b) => a.name.localeCompare(b.name));
	let results = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		const relPath = baseRel ? `${baseRel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			results = results.concat(collectFiles(fullPath, relPath));
		} else if (entry.isFile()) {
			results.push({ fullPath, relPath });
		}
	}
	return results;
}

function createStoreZip(entries) {
	// entries: array of { zipPath: string, data: Buffer }
	const localChunks = [];
	const centralChunks = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.zipPath, "utf8");
		const data = entry.data;
		const checksum = crc32(data);
		const size = data.length;
		const localHeaderOffset = offset;

		// Local File Header (30 bytes + nameBuf.length)
		const localHeader = Buffer.alloc(30 + nameBuf.length);
		localHeader.writeUInt32LE(0x04034b50, 0); // Local header signature
		localHeader.writeUInt16LE(20, 4); // Version needed (2.0)
		localHeader.writeUInt16LE(0, 6); // Flags
		localHeader.writeUInt16LE(0, 8); // Compression method: 0 (STORE)
		localHeader.writeUInt16LE(FIXED_DOS_TIME, 10);
		localHeader.writeUInt16LE(FIXED_DOS_DATE, 12);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(size, 18); // Compressed size
		localHeader.writeUInt32LE(size, 22); // Uncompressed size
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28); // Extra field length
		nameBuf.copy(localHeader, 30);

		localChunks.push(localHeader);
		localChunks.push(data);
		offset += localHeader.length + data.length;

		// Central Directory File Header (46 bytes + nameBuf.length)
		const centralHeader = Buffer.alloc(46 + nameBuf.length);
		centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
		centralHeader.writeUInt16LE(20, 4); // Version made by (2.0)
		centralHeader.writeUInt16LE(20, 6); // Version needed (2.0)
		centralHeader.writeUInt16LE(0, 8); // Flags
		centralHeader.writeUInt16LE(0, 10); // Compression method: 0 (STORE)
		centralHeader.writeUInt16LE(FIXED_DOS_TIME, 12);
		centralHeader.writeUInt16LE(FIXED_DOS_DATE, 14);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(size, 20); // Compressed size
		centralHeader.writeUInt32LE(size, 24); // Uncompressed size
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt16LE(0, 30); // Extra field length
		centralHeader.writeUInt16LE(0, 32); // File comment length
		centralHeader.writeUInt16LE(0, 34); // Disk number start
		centralHeader.writeUInt16LE(0, 36); // Internal file attributes
		centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // External file attributes (regular file rw-r--r--)
		centralHeader.writeUInt32LE(localHeaderOffset, 42); // Relative offset of local header
		nameBuf.copy(centralHeader, 46);

		centralChunks.push(centralHeader);
	}

	const centralDirOffset = offset;
	const centralDirBuf = Buffer.concat(centralChunks);
	const centralDirSize = centralDirBuf.length;

	// End of Central Directory Record (22 bytes)
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
	eocd.writeUInt16LE(0, 4); // Disk number
	eocd.writeUInt16LE(0, 6); // Disk with central directory
	eocd.writeUInt16LE(entries.length, 8); // Total entries on this disk
	eocd.writeUInt16LE(entries.length, 10); // Total entries
	eocd.writeUInt32LE(centralDirSize, 12); // Central directory size
	eocd.writeUInt32LE(centralDirOffset, 16); // Central directory offset
	eocd.writeUInt16LE(0, 20); // Comment length

	return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}

function main() {
	if (!fs.existsSync(skillDir)) {
		console.error(`Skill source directory not found: ${skillDir}`);
		process.exit(1);
	}

	// 1. public/skills/log-workout への同期コピー
	fs.mkdirSync(publicSkillDir, { recursive: true });
	fs.cpSync(skillDir, publicSkillDir, { recursive: true });
	console.log(`Copied skill files to: ${publicSkillDir}`);

	// 2. ZIP アーカイブ作成用のエントリ収集
	const files = collectFiles(skillDir);
	const zipEntries = files.map((file) => ({
		zipPath: `log-workout/${file.relPath}`,
		data: fs.readFileSync(file.fullPath),
	}));

	const zipBuffer = createStoreZip(zipEntries);
	fs.mkdirSync(path.dirname(publicZipPath), { recursive: true });
	fs.writeFileSync(publicZipPath, zipBuffer);
	console.log(`Generated zip archive at: ${publicZipPath} (${zipBuffer.length} bytes)`);
}

main();
