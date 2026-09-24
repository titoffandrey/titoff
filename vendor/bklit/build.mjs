import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const dir = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2]);
const pruneList = process.argv.includes("--list-inputs");

// Отпечаток исходников Bklit: все файлы src/ по порядку имён. По нему видно, что
// в браузер уехал именно зафиксированный в README снимок, а не правленый.
async function walk(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push(path);
  }
  return out;
}
const sourceFiles = (await walk(join(dir, "src"))).sort();
const hash = createHash("sha256");
for (const file of sourceFiles) {
  hash.update(relative(dir, file).replaceAll("\\", "/"));
  hash.update(await readFile(file));
}
const sourceHash = hash.digest("hex");
const banner = `Bklit UI charts — uixmat, MIT (github.com/bklit/bklit-ui). Source tree SHA-256: ${sourceHash}. Licenses: /static/bklit-charts.LICENSE.txt`;

// Исходники не правятся: алиас `@/lib/utils` оригинала и русские форматтеры
// подставляются здесь, при сборке.
const storeAliases = {
  name: "store-aliases",
  setup(b) {
    b.onResolve({ filter: /^@\/lib\/utils$/ }, () => ({ path: join(dir, "src/lib/utils.ts") }));
    b.onResolve({ filter: /(^|\/)chart-formatters$/ }, args =>
      args.importer.includes(`${join(dir, "src")}`) ? { path: join(dir, "store-formatters.ts") } : undefined);
  },
};

const result = await build({
  absWorkingDir: dir,
  entryPoints: ["store-charts.tsx"],
  outfile: join(output, "bklit-charts.js"),
  bundle: true,
  minify: true,
  format: "iife",
  jsx: "automatic",
  target: ["es2020"],
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  banner: { js: `/*! ${banner} */` },
  plugins: [storeAliases],
  metafile: true,
  logLevel: "warning",
});

if (pruneList) {
  // Какие файлы src/ реально попали в сборку — по этому списку в репозитории
  // остаются только они (сами файлы не меняются ни на байт).
  for (const input of Object.keys(result.metafile.inputs).sort()) {
    if (input.startsWith("src/")) console.log(input);
  }
}

const compiled = await postcss([tailwind({ base: dir, optimize: { minify: false } })])
  .process(await readFile(join(dir, "charts.css"), "utf8"), { from: join(dir, "charts.css") });
const css = postcss.parse(compiled.css);
// Tailwind остаётся исходным, но preflight, переменные и утилиты действуют
// только внутри островов графиков — остальная панель их не видит.
css.walkAtRules("layer", rule => {
  if (rule.nodes) rule.replaceWith(...rule.nodes);
  else rule.remove();
});
css.walkRules(rule => {
  if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
  if (rule.selector.includes("&")) return;
  rule.selectors = rule.selectors.map(selector => {
    const s = selector.trim();
    if (/^(?::root|:host|html|body|\.studio-shell)$/.test(s)) return ".bk-root";
    if (/^\.dark\b/.test(s)) return ".bk-root.dark";
    // Тип/универсальный селектор обязан стоять в начале compound selector.
    const [, element = "", rest] = s.match(/^(\*|[-\w]+)?(.*)$/);
    return `${element}:where(.bk-root, .bk-root *)${rest}`;
  });
});
await writeFile(
  join(output, "bklit-charts.css"),
  `/*! ${banner} */\n${await readFile(join(dir, "store-reset.css"), "utf8")}${css.toString().replaceAll("--tw-", "--bk-tw-")}\n${await readFile(join(dir, "integration.css"), "utf8")}`
);

const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const path = input.replaceAll("\\", "/");
  const match = path.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) packageDirs.add(match[1]);
}
let licenses = `Bklit UI\nhttps://github.com/bklit/bklit-ui\nhttps://bklit.com\n\n${await readFile(join(dir, "LICENSE"), "utf8")}`;
packageDirs.add("tailwindcss");
for (const name of [...packageDirs].sort()) {
  const packageDir = join(dir, "node_modules", name);
  const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const files = (await readdir(packageDir)).filter(file => /^(license|licence|copying)(\.|$)/i.test(file));
  licenses += `\n\n========================================\n${pkg.name} ${pkg.version}\n`;
  for (const file of files) licenses += `\n${await readFile(join(packageDir, file), "utf8")}\n`;
}
await writeFile(join(output, "bklit-charts.LICENSE.txt"), licenses);
console.log(`Графики Bklit собраны; исходники SHA-256 ${sourceHash}`);
