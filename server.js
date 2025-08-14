import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Serve static files from /public
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : __dirname;

app.use(express.static(PUBLIC_DIR));

// Default route
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(3000, () => {
  console.log("🚀 Ghost Sniper running on port 3000");
});