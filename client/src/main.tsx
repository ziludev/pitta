import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { initialLang, tr } from "@/i18n";
import { useStore } from "@/store";
import "@/index.css";

document.documentElement.lang = initialLang() === "zh" ? "zh-CN" : "en";
// The window title, the Dock and the menu bar should say the same thing.
document.title = "知衡 Pitta";

// Anything that escapes React still has to be visible: the log file is not in-app.
window.addEventListener("error", (event) => {
  useStore.getState().pushError(event.message || "window error");
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  useStore.getState().pushError(reason instanceof Error ? reason.message : String(reason));
});

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(<App />);

void tr;
