/**
 * Print animation names from a GLB file.
 * Usage: node scripts/inspect-glb-animations.mjs <path-to.glb>
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const path = process.argv[2] || join(root, "public", "claw-shooter", "G_1.glb");
const buf = readFileSync(path);

// GLB: 12-byte header, then chunks (length (4) + type (4) + data)
const magic = buf.toString("utf8", 0, 4);
if (magic !== "glTF") {
  console.error("Not a GLB file");
  process.exit(1);
}
const totalLength = buf.readUInt32LE(8);
let offset = 12;
while (offset < totalLength) {
  const chunkLength = buf.readUInt32LE(offset);
  const chunkType = buf.readUInt32LE(offset + 4);
  offset += 8;
  if (chunkType === 0x4e4f534a) {
    // 0x4E4F534A = "JSON" as uint32 LE
    // JSON chunk
    const jsonStr = buf.toString("utf8", offset, offset + chunkLength);
    const json = JSON.parse(jsonStr);

    const anims = json.animations || [];
    console.log("=== Animation names ===");
    console.log(anims.length ? anims.map((a, i) => `${i}: ${a.name || "(unnamed)"}`).join("\n") : "(none)");

    const nodes = json.nodes || [];
    console.log("\n=== Node names (index: name) ===");
    nodes.forEach((n, i) => {
      const name = n.name != null ? String(n.name) : "(unnamed)";
      console.log(`${i}: ${name}`);
    });

    const meshNames = new Set();
    const meshes = json.meshes || [];
    meshes.forEach((m, i) => {
      const name = m.name != null ? String(m.name) : "(unnamed)";
      meshNames.add(name);
    });
    console.log("\n=== Mesh names ===");
    console.log([...meshNames].sort().join(", ") || "(none)");

    process.exit(0);
  }
  offset += chunkLength;
}
console.error("No JSON chunk found");
process.exit(1);
