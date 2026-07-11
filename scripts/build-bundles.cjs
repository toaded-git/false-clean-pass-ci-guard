const { execFileSync } = require("node:child_process");
const { copyFileSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const rootDir = join(__dirname, "..");
const distDir = join(rootDir, "dist");
const cliTempDir = join(rootDir, ".verify-tmp", "ncc-cli");

rmSync(distDir, { recursive: true, force: true });
rmSync(cliTempDir, { recursive: true, force: true });
mkdirSync(join(rootDir, ".verify-tmp"), { recursive: true });

runNcc(["build", "build/index.js", "-o", "dist"]);
runNcc(["build", "build/cli.js", "-o", ".verify-tmp/ncc-cli"]);

let cliBundle = readFileSync(join(cliTempDir, "index.js"), "utf8");
cliBundle = cliBundle.replace(
  'return "" + chunkId + ".index.js";',
  'return "cli-" + chunkId + ".index.js";'
);
for (const filename of readdirSync(cliTempDir)) {
  if (filename === "index.js") {
    continue;
  }

  const outputFilename = `cli-${filename}`;
  cliBundle = cliBundle.replaceAll(`./${filename}`, `./${outputFilename}`);
  copyFileSync(join(cliTempDir, filename), join(distDir, outputFilename));
}
writeFileSync(join(distDir, "cli.js"), cliBundle);
rmSync(cliTempDir, { recursive: true, force: true });
try {
  rmdirSync(join(rootDir, ".verify-tmp"));
} catch {
  // Keep the directory when other verification artifacts are present.
}

function runNcc(args) {
  execFileSync("ncc", args, {
    cwd: rootDir,
    stdio: "inherit"
  });
}
