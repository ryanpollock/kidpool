import sharp from "sharp";
import { readFileSync, writeFileSync } from "fs";

const pub = "public";

async function rasterize(svgPath, pngPath, size) {
  const svg = readFileSync(svgPath);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain" })
    .png()
    .toFile(pngPath);
  console.log(`  ${pngPath} (${size}x${size})`);
}

async function main() {
  console.log("Rasterizing app icons from icon.svg...");
  await rasterize(`${pub}/icon.svg`, `${pub}/icon-512.png`, 512);
  await rasterize(`${pub}/icon.svg`, `${pub}/icon-192.png`, 192);
  await rasterize(`${pub}/icon.svg`, `${pub}/apple-touch-icon.png`, 180);

  console.log("Rasterizing favicons from favicon.svg...");
  await rasterize(`${pub}/favicon.svg`, `${pub}/favicon-32.png`, 32);
  await rasterize(`${pub}/favicon.svg`, `${pub}/favicon-16.png`, 16);

  console.log("Rasterizing push badge from badge.svg...");
  await rasterize(`${pub}/badge.svg`, `${pub}/badge-96.png`, 96);

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});