const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const WORK_DIR = path.join(ROOT, ".work");
const DOWNLOAD_DIR = path.join(WORK_DIR, "downloads");
const CONFIG_PATH = path.join(ROOT, "audiveris.config.json");
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_PDF_PAGES = 10;
const AUDIVERIS_NO_PIXEL_LIMIT = "org.audiveris.omr.step.LoadStep.maxPixelCount=0";
const AUDIVERIS_PDF_DPI = "org.audiveris.omr.image.ImageLoading.pdfResolution";
const PDF_SCALE_RETRY_DPI = 72;
const PAGE_EXPORT_DPI = 72;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "content-type": "application/json; charset=utf-8"
  });
}

function safeBasename(value) {
  const name = path.basename(String(value || "score.pdf"));
  return name.replace(/[^a-z0-9._ -]/gi, "_").slice(0, 120) || "score.pdf";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        reject(new Error("Plik jest za duzy. Limit tej aplikacji to 5 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function commandExists(command) {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [command] : ["-v", command];
    const child = childProcess.spawn(probe, args, { stdio: "ignore", shell: process.platform !== "win32" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function parseCommandLine(value) {
  const input = String(value || "").trim();
  if (!input) return null;

  const parts = [];
  let current = "";
  let quote = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  if (!parts.length) return null;
  return { command: parts[0], args: parts.slice(1) };
}

function readAudiverisConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;

  const raw = fs.readFileSync(CONFIG_PATH, "utf8").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const commandLine = parsed.command || parsed.path || parsed.audiveris || "";
    const extraArgs = Array.isArray(parsed.args) ? parsed.args.map(String) : [];
    if (typeof commandLine === "string" && fs.existsSync(commandLine)) {
      return { command: commandLine, args: extraArgs, source: "config" };
    }
    const spec = parseCommandLine(commandLine);
    if (!spec) return null;
    return { ...spec, args: [...spec.args, ...extraArgs], source: "config" };
  } catch {
    const spec = parseCommandLine(raw);
    if (!spec) return null;
    return { ...spec, source: "config" };
  }
}

function normalizeAudiverisSpec(spec) {
  if (!spec) return null;
  const extension = path.extname(spec.command).toLowerCase();
  if (extension === ".jar") {
    return {
      command: "java",
      args: ["-jar", spec.command, ...spec.args],
      source: spec.source,
      display: spec.command
    };
  }
  return {
    command: spec.command,
    args: spec.args,
    source: spec.source,
    display: spec.command
  };
}

async function findAudiverisCommand() {
  const configSpec = readAudiverisConfig();
  if (configSpec) return normalizeAudiverisSpec(configSpec);

  const envSpec = parseCommandLine(process.env.AUDIVERIS_CMD);
  if (envSpec) return normalizeAudiverisSpec({ ...envSpec, source: "env" });

  if (await commandExists("audiveris")) {
    return { command: "audiveris", args: [], source: "path", display: "audiveris" };
  }
  return null;
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const extension = path.extname(command).toLowerCase();
    const child = childProcess.spawn(command, args, {
      cwd,
      shell: process.platform === "win32" && [".bat", ".cmd"].includes(extension),
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || stdout || `Proces zakonczyl sie kodem ${code}.`));
    });
  });
}

function listFilesDeep(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFilesDeep(full));
    else found.push(full);
  }
  return found;
}

function hasOmrWorkPath(file) {
  return file.split(path.sep).some((part) => part.toLowerCase().endsWith(".omr"));
}

function findMusicXmlExport(outputDir) {
  const files = listFilesDeep(outputDir).filter((file) => !hasOmrWorkPath(file));
  const byExtension = (extensions) =>
    files.find((file) => extensions.includes(path.extname(file).toLowerCase()));

  return byExtension([".mxl", ".musicxml"]) || byExtension([".xml"]);
}

async function runAudiverisExport(audiveris, inputPath, jobDir, outputDir, extraArgs = []) {
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  await run(
    audiveris.command,
    [...audiveris.args, ...extraArgs, "-batch", "-transcribe", "-export", "-output", outputDir, inputPath],
    jobDir
  );

  return findMusicXmlExport(outputDir);
}

function parseSheetCount(error) {
  const text = String(error?.message || error || "");
  const match = text.match(/\|\s*(\d+)\s+sheets?\s+in\s+/i) || text.match(/\b(\d+)\s+sheets?\s+in\s+/i);
  const count = match ? Number(match[1]) : 0;
  return Number.isInteger(count) && count > 1 && count <= 200 ? count : 0;
}

function countPdfPages(buffer) {
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 0;
}

function isTooLargeImageError(error) {
  return /too large image|flagged as invalid|20,000,000|20000000/i.test(String(error?.message || error));
}

function isTooHighInterlineError(error) {
  return /too high interline|interline value is not reliable|does not seem to contain multi-line staves/i.test(
    String(error?.message || error)
  );
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const content = Buffer.isBuffer(entry.buffer) ? entry.buffer : Buffer.from(entry.buffer);
    const compressed = zlib.deflateRawSync(content);
    const crc = crc32(content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function convertPdfByPages(audiveris, inputPath, jobDir, originalName, sheetCount) {
  const baseName = safeBasename(originalName).replace(/\.[^.]+$/, "") || "score";
  const exported = [];
  const errors = [];

  for (let page = 1; page <= sheetCount; page += 1) {
    const pageDir = path.join(jobDir, `audiveris-page-${String(page).padStart(3, "0")}`);
    try {
      const candidate = await runAudiverisExport(audiveris, inputPath, jobDir, pageDir, [
        "-constant",
        AUDIVERIS_NO_PIXEL_LIMIT,
        "-constant",
        `${AUDIVERIS_PDF_DPI}=${PAGE_EXPORT_DPI}`,
        "-sheets",
        String(page)
      ]);
      if (candidate) {
        exported.push({
          name: `${baseName}-strona-${String(page).padStart(2, "0")}${path.extname(candidate)}`,
          buffer: fs.readFileSync(candidate)
        });
      } else {
        errors.push(`strona ${page}: brak pliku MusicXML`);
      }
    } catch (error) {
      errors.push(`strona ${page}: ${String(error.message || error).slice(0, 500)}`);
    }
  }

  if (!exported.length) {
    throw new Error(`Nie udalo sie wyeksportowac zadnej strony z ${sheetCount}. ${errors.join(" | ")}`);
  }

  if (exported.length === 1) {
    return {
      buffer: exported[0].buffer,
      filename: exported[0].name,
      engine: "audiveris"
    };
  }

  return {
    buffer: createZip(exported),
    filename: `${baseName}-strony-musicxml.zip`,
    engine: "audiveris",
    pages: exported.length,
    pageErrors: errors
  };
}

async function convertWithAudiveris(inputPath, jobDir, originalName) {
  const audiveris = await findAudiverisCommand();
  if (!audiveris) return null;

  const isPdf = path.extname(inputPath).toLowerCase() === ".pdf";
  let candidate = null;
  let firstError = null;
  let lastError = null;

  try {
    candidate = await runAudiverisExport(audiveris, inputPath, jobDir, path.join(jobDir, "audiveris-output"));
  } catch (error) {
    firstError = error;
    lastError = error;
  }

  if (!candidate && isPdf && (!lastError || isTooLargeImageError(lastError))) {
    try {
      candidate = await runAudiverisExport(
        audiveris,
        inputPath,
        jobDir,
        path.join(jobDir, "audiveris-output-full-resolution"),
        ["-constant", AUDIVERIS_NO_PIXEL_LIMIT]
      );
    } catch (error) {
      lastError = error;
    }
  }

  if (!candidate && isPdf && lastError && isTooHighInterlineError(lastError)) {
    try {
      candidate = await runAudiverisExport(
        audiveris,
        inputPath,
        jobDir,
        path.join(jobDir, "audiveris-output-normal-scale"),
        ["-constant", AUDIVERIS_NO_PIXEL_LIMIT, "-constant", `${AUDIVERIS_PDF_DPI}=${PDF_SCALE_RETRY_DPI}`]
      );
    } catch (error) {
      lastError = error;
    }
  }

  if (!candidate && isPdf) {
    const sheetCount = parseSheetCount(lastError || firstError);
    if (sheetCount > MAX_PDF_PAGES) {
      throw new Error(`Ten PDF ma ${sheetCount} stron. Limit aplikacji to ${MAX_PDF_PAGES} stron.`);
    }
    if (sheetCount) {
      return convertPdfByPages(audiveris, inputPath, jobDir, originalName, sheetCount);
    }
  }

  if (!candidate) {
    if (lastError || firstError) throw lastError || firstError;
    throw new Error(
      "Audiveris zakonczyl prace, ale nie znaleziono pliku MusicXML. Jesli PDF ma bardzo duze strony, sprobuj wyeksportowac go jako zwykly PDF A4/A3 albo obraz PNG/JPG."
    );
  }

  return {
    buffer: fs.readFileSync(candidate),
    filename: `${safeBasename(originalName).replace(/\.[^.]+$/, "") || "score"}${path.extname(candidate)}`,
    engine: "audiveris"
  };
}

function demoMusicXml(originalName) {
  const title = safeBasename(originalName).replace(/\.[^.]+$/, "") || "Converted score";
  const generated = new Date().toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>${escapeXml(title)}</work-title>
  </work>
  <identification>
    <creator type="software">PDF to MusicXML Web App</creator>
    <encoding>
      <software>Demo fallback - install Audiveris for real OMR</software>
      <encoding-date>${generated.slice(0, 10)}</encoding-date>
    </encoding>
  </identification>
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
    </score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key>
          <fifths>-4</fifths>
        </key>
        <time>
          <beats>4</beats>
          <beat-type>4</beat-type>
        </time>
        <clef>
          <sign>G</sign>
          <line>2</line>
        </clef>
      </attributes>
      <direction placement="above">
        <direction-type>
          <words>OMR engine not connected yet</words>
        </direction-type>
      </direction>
      <note>
        <pitch><step>A</step><alter>-1</alter><octave>4</octave></pitch>
        <duration>4</duration>
        <type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>
`;
  return Buffer.from(xml, "utf8");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function contentTypeForDownload(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".mxl")) return "application/vnd.recordare.musicxml";
  return "application/vnd.recordare.musicxml+xml; charset=utf-8";
}

function analyzeMusicXml(buffer, filename) {
  if (!/\.(musicxml|xml)$/i.test(filename)) return {};
  const xml = buffer.toString("utf8");
  const signatures = [];
  const pattern = /<measure\b[^>]*\bnumber="([^"]*)"[\s\S]*?<time\b[^>]*>[\s\S]*?<beats>([^<]+)<\/beats>[\s\S]*?<beat-type>([^<]+)<\/beat-type>[\s\S]*?<\/time>/gi;
  let match = null;

  while ((match = pattern.exec(xml))) {
    const signature = `${match[2].trim()}/${match[3].trim()}`;
    const previous = signatures[signatures.length - 1];
    if (!previous || previous.signature !== signature) {
      signatures.push({ measure: match[1], signature });
    }
  }

  return {
    timeSignatures: signatures,
    timeSignatureChanges: Math.max(0, signatures.length - 1)
  };
}

async function handleConvert(req, res) {
  try {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("application/pdf") && !contentType.startsWith("image/")) {
      sendJson(res, 415, { error: "Wgraj PDF, PNG albo JPG z nutami." });
      return;
    }

    const originalName = safeBasename(decodeURIComponent(String(req.headers["x-file-name"] || "score.pdf")));
    const extension = path.extname(originalName) || (contentType.includes("pdf") ? ".pdf" : ".png");
    const jobId = crypto.randomUUID();
    const jobDir = path.join(WORK_DIR, jobId);
    fs.mkdirSync(jobDir, { recursive: true });

    const input = await readBody(req);
    if (!input.length) {
      sendJson(res, 400, { error: "Nie otrzymalem pliku." });
      return;
    }

    if (extension.toLowerCase() === ".pdf") {
      const pageCount = countPdfPages(input);
      if (pageCount > MAX_PDF_PAGES) {
        sendJson(res, 400, { error: `Ten PDF ma ${pageCount} stron. Limit aplikacji to ${MAX_PDF_PAGES} stron.` });
        return;
      }
    }

    const inputPath = path.join(jobDir, `input${extension}`);
    fs.writeFileSync(inputPath, input);

    let result = await convertWithAudiveris(inputPath, jobDir, originalName);
    if (!result) {
      result = {
        buffer: demoMusicXml(originalName),
        filename: `${originalName.replace(/\.[^.]+$/, "") || "score"}.musicxml`,
        engine: "demo"
      };
    }

    const downloadDir = path.join(DOWNLOAD_DIR, jobId);
    fs.mkdirSync(downloadDir, { recursive: true });
    const outputFilename = safeBasename(result.filename);
    fs.writeFileSync(path.join(downloadDir, outputFilename), result.buffer);

    sendJson(res, 200, {
      engine: result.engine,
      filename: outputFilename,
      downloadUrl: `/api/download/${jobId}/${encodeURIComponent(outputFilename)}`,
      pages: result.pages || null,
      pageErrors: result.pageErrors || [],
      analysis: analyzeMusicXml(result.buffer, outputFilename)
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Konwersja nie powiodla sie." });
  }
}

function handleDownload(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);
  const jobId = parts[2];
  const filename = safeBasename(decodeURIComponent(parts.slice(3).join("/") || ""));

  if (!/^[a-f0-9-]{36}$/i.test(jobId) || !filename) {
    sendJson(res, 400, { error: "Nieprawidlowy link pobierania." });
    return;
  }

  const filePath = path.normalize(path.join(DOWNLOAD_DIR, jobId, filename));
  const expectedRoot = path.join(DOWNLOAD_DIR, jobId);
  if (!filePath.startsWith(expectedRoot)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "Plik wygasl albo nie istnieje. Przekonwertuj nuty ponownie." });
      return;
    }
    send(res, 200, content, {
      "content-type": contentTypeForDownload(filename),
      "content-disposition": `attachment; filename="${filename}"`
    });
  });
}

async function handleEngineStatus(res) {
  const audiveris = await findAudiverisCommand();
  sendJson(res, 200, {
    engine: audiveris ? "audiveris" : "demo",
    ready: Boolean(audiveris),
    source: audiveris?.source || null,
    command: audiveris?.display || null,
    configPath: CONFIG_PATH
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestPath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, content, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream"
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/convert") {
    handleConvert(req, res);
    return;
  }
  if (req.method === "GET" && req.url === "/api/engine") {
    handleEngineStatus(res);
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/download/")) {
    handleDownload(req, res);
    return;
  }
  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }
  send(res, 405, "Method not allowed");
});

server.listen(PORT, () => {
  console.log(`PDF to MusicXML app: http://localhost:${PORT}`);
});
