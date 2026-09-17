// `tsc` emits JavaScript only, so the numbered .sql files the migration runner
// reads have to be copied into dist/ by hand after a build.
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(pkg, "dist"), { recursive: true });
cpSync(join(pkg, "src", "migrations"), join(pkg, "dist", "migrations"), { recursive: true });
