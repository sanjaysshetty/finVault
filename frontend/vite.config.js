import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  // ✅ Dev: "/"  |  Build (prod): "/app/"
  base: command === "serve" ? "/" : "/app/",
  plugins: [react()],
}));
