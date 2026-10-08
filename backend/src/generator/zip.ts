import JSZip from "jszip";

/** Zip entry timestamp used for every generated Office file, so the same seed gives the same bytes. */
export const FIXED_ZIP_DATE = new Date("2026-09-21T10:00:00Z");

/**
 * Rewrites a zip (an .xlsx or .docx) with fixed entry timestamps, keeping entry order and content.
 * Without this, the bytes change on every run even though the content does not (spec 17.10).
 */
export async function normalizeZip(input: Buffer, documentDate?: Date): Promise<Buffer> {
  const source = await JSZip.loadAsync(input);
  const out = new JSZip();
  for (const [name, entry] of Object.entries(source.files)) {
    if (entry.dir) continue;
    let content = await entry.async("nodebuffer");
    // Office core properties carry the time the file was written; pin them too.
    if (documentDate && name === "docProps/core.xml") {
      const iso = documentDate.toISOString().replace(/\.\d{3}Z$/, "Z");
      content = Buffer.from(
        content.toString("utf8").replace(/(<dcterms:(created|modified)[^>]*>)[^<]*(<\/dcterms:\2>)/g, `$1${iso}$3`),
        "utf8",
      );
    }
    out.file(name, content, { date: FIXED_ZIP_DATE, createFolders: false });
  }
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
