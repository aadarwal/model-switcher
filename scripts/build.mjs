import { build } from "esbuild";
await build({
  entryPoints: ["src/cli.ts"], outfile: "dist/ms.js", bundle: true, platform: "node",
  format: "esm", target: "node22", banner: { js: "// model-switcher — built bundle" },
  external: ["node:*"],
});
console.log("built dist/ms.js");
