import { execSync } from "child_process";
import fs from "fs-extra";
import { r } from "./utils";

// Zips ./extension into ./dist/<name>-<version>.zip (used for the Chrome packages)
const name = process.argv[2];
if (!name) throw new Error("Usage: esno scripts/pack-zip.ts <name>");

const pkg = fs.readJSONSync(r("package.json"));
const output = `./dist/${name}-${pkg.version}.zip`;

fs.removeSync(output);
execSync(`jszip-cli add extension/* -o ${output}`, { stdio: "inherit" });
