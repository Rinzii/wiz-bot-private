import { setTimeout as wait } from "node:timers/promises";

const API_BASE = "https://www.virustotal.com/api/v3";

function ensurePositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

export class VirusTotalService {
  #apiKey;
  #pollIntervalMs;
  #maxPolls;
  #maxFileBytes;
  #logger;

  constructor(options = {}, logger = null) {
    this.#apiKey = options.apiKey || "";
    this.#pollIntervalMs = ensurePositiveInt(options.pollIntervalMs, 5000);
    this.#maxPolls = ensurePositiveInt(options.maxPolls, 12);
    this.#maxFileBytes = ensurePositiveInt(options.maxFileBytes, 32 * 1024 * 1024);
    this.#logger = logger;
  }

  get enabled() {
    return Boolean(this.#apiKey);
  }

  get maxFileBytes() {
    return this.#maxFileBytes;
  }

  async submitFileFromUrl({ url, filename = "attachment", size = 0 }) {
    if (!this.enabled) {
      return { submitted: false, error: "VirusTotal API key not configured." };
    }
    if (!url) {
      return { submitted: false, error: "Missing attachment URL." };
    }
    if (this.#maxFileBytes && size && size > this.#maxFileBytes) {
      const errMsg = `Attachment exceeds VirusTotal upload limit (${size} > ${this.#maxFileBytes}).`;
      this.#logger?.warn?.("virustotal.file_too_large", { filename, size, limit: this.#maxFileBytes });
      return { submitted: false, error: errMsg };
    }

    try {
      const downloadRes = await fetch(url);
      if (!downloadRes.ok) {
        throw new Error(`Download failed with status ${downloadRes.status}`);
      }
      const arrayBuffer = await downloadRes.arrayBuffer();
      if (this.#maxFileBytes && arrayBuffer.byteLength > this.#maxFileBytes) {
        const errMsg = `Attachment exceeds VirusTotal upload limit after download (${arrayBuffer.byteLength} > ${this.#maxFileBytes}).`;
        this.#logger?.warn?.("virustotal.file_too_large_post_download", { filename, size: arrayBuffer.byteLength, limit: this.#maxFileBytes });
        return { submitted: false, error: errMsg };
      }

      const blob = new Blob([arrayBuffer]);
      const form = new FormData();
      form.append("file", blob, filename);

      const uploadRes = await fetch(`${API_BASE}/files`, {
        method: "POST",
        headers: { "x-apikey": this.#apiKey },
        body: form
      });

      if (!uploadRes.ok) {
        const text = await uploadRes.text().catch(() => "");
        throw new Error(`VirusTotal upload failed (${uploadRes.status}): ${text || "no body"}`);
      }

      const uploadJson = await uploadRes.json().catch(() => null);
      const analysisId = uploadJson?.data?.id;
      if (!analysisId) {
        throw new Error("VirusTotal response missing analysis id");
      }

      const analysis = await this.#pollAnalysis(analysisId);
      return { submitted: true, analysisId, analysis };
    } catch (error) {
      this.#logger?.error?.("virustotal.submit_failed", {
        filename,
        error: String(error?.message || error)
      });
      return { submitted: false, error: String(error?.message || error) };
    }
  }

  async #pollAnalysis(id) {
    let lastError = null;
    for (let attempt = 0; attempt < this.#maxPolls; attempt += 1) {
      try {
        const res = await fetch(`${API_BASE}/analyses/${id}`, {
          headers: { "x-apikey": this.#apiKey }
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Analysis fetch failed (${res.status}): ${body || "no body"}`);
        }
        const json = await res.json().catch(() => null);
        const status = json?.data?.attributes?.status;
        if (status === "completed") {
          const stats = json?.data?.attributes?.stats || {};
          const fileHash = json?.meta?.file_info?.sha256 || json?.data?.id || null;
          const link = fileHash ? `https://www.virustotal.com/gui/file/${fileHash}` : null;
          return { status, stats, link, raw: json };
        }
        lastError = null;
      } catch (error) {
        lastError = error;
        this.#logger?.warn?.("virustotal.poll_failed", {
          analysisId: id,
          attempt: attempt + 1,
          error: String(error?.message || error)
        });
      }
      await wait(this.#pollIntervalMs);
    }
    if (lastError) {
      throw lastError;
    }
    throw new Error("VirusTotal analysis polling timed out");
  }
}
