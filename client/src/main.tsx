import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { initialLang, tr } from "@/i18n";
import { useStore } from "@/store";
import "@/index.css";

document.documentElement.lang = initialLang() === "zh" ? "zh-CN" : "en";
document.title = "Agent";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(<App />);

void tr;
void useStore;
