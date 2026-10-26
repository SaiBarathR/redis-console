import "./lib/csp.ts";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { applyTheme, initialTheme } from "./lib/theme.ts";
const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing.");
// Apply the theme before the first paint so sign-in and loading screens match it.
applyTheme(initialTheme());
// Configure Zod before App or a lazy page can instantiate shared schemas,
// irrespective of bundler chunk grouping.
void import("./App.tsx").then(({ default: App }) =>
  createRoot(root).render(<App />),
);
