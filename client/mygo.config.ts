import { defineConfig } from "mygo-cli";

export default defineConfig({
  // Both names, because the Dock and the menu bar are read by people who call it either.
  name: "知衡 Pitta",
  // Kept so the webview keeps its stored state: a new identifier is a new app to macOS.
  identifier: "com.example.agent",
  version: "0.1.0",
  // `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
  // buildCommand and embeds frontendDist into the app.
  devUrl: "http://localhost:5173",
  devCommand: "npm run dev:web",
  buildCommand: "npm run build:web",
  frontendDist: "dist",
  bindings: "src/mygo.ts",
  out: "build",
});
