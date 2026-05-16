declare module "pdf-parse" {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
    text: string;
  }

  function pdfParse(
    dataBuffer: Buffer | Uint8Array,
    options?: {
      pagerender?: (pageData: unknown) => string;
      max?: number;
      version?: string;
    },
  ): Promise<PdfParseResult>;

  export = pdfParse;
}
