import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the React (plain JavaScript) frontend.
export default defineConfig({
  plugins: [react()],
});