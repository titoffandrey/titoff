import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const dir = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2]);
const source = await readFile(join(dir, "basic-toast.tsx"));
const sourceHash = createHash("sha256").update(source).digest("hex");
const banner = `SmoothUI Basic Toast — Eduardo Calvo, MIT. Original component SHA-256: ${sourceHash}. Licenses: /static/smoothui-toast.LICENSE.txt`;
const result = await build({
  absWorkingDir: dir,
  entryPoints: ["store-toast.tsx"],
  outfile: join(output, "smoothui-toast.js"),
  bundle: true,
  minify: true,
  format: "iife",
  jsx: "automatic",
  target: ["es2020"],
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  banner: { js: `/*! ${banner} */` },
  metafile: true,
  logLevel: "warning",
});

const compiled = await postcss([tailwind({ base: dir, optimize: { minify: false } })])
  .process(await readFile(join(dir, "toast.css"), "utf8"), { from: join(dir, "toast.css") });
const css = postcss.parse(compiled.css);
// Tailwind остаётся исходным. Ограничиваем preflight, variables и utilities тостом.
css.walkAtRules("layer", rule => {
  if (rule.nodes) rule.replaceWith(...rule.nodes);
  else rule.remove();
});
css.walkRules(rule => {
  if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
  if (rule.selector.includes("&")) return;
  rule.selectors = rule.selectors.map(selector => {
    if (/^(?::root|:host|html|body)$/.test(selector.trim())) return ".store-toast-card";
    // Тип/универсальный селектор обязан стоять в начале compound selector.
    const [, element = "", rest] = selector.match(/^(\*|[-\w]+)?(.*)$/);
    return `${element}:where(.store-toast-card, .store-toast-card *)${rest}`;
  });
});
await writeFile(join(output, "smoothui-toast.css"), `/*! ${banner} */\n${css.toString().replaceAll("--tw-", "--store-toast-tw-")}\n${await readFile(join(dir, "integration.css"), "utf8")}`);

const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const path = input.replaceAll("\\", "/");
  const match = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packageDirs.add(match[1]);
}
let licenses = `SmoothUI Basic Toast\nhttps://github.com/educlopez/smoothui\nhttps://smoothui.dev/docs/components/basic-toast\n\n${await readFile(join(dir, "LICENSE"), "utf8")}`;
packageDirs.add("tailwindcss");
for (const name of [...packageDirs].sort()) {
  const packageDir = join(dir, "node_modules", name);
  const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const files = (await readdir(packageDir)).filter(name => /^(license|licence|copying)(\.|$)/i.test(name));
  licenses += `\n\n========================================\n${pkg.name} ${pkg.version}\n`;
  for (const file of files) licenses += `\n${await readFile(join(packageDir, file), "utf8")}\n`;
}
await writeFile(join(output, "smoothui-toast.LICENSE.txt"), licenses);
console.log(`SmoothUI Basic Toast собран; исходник SHA-256 ${sourceHash}`);
