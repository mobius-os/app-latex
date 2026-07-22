export const PDF_WORKER_PATH = '/vendor/pdfjs/pdf.worker.mjs'

// Mini-app modules execute from a blob URL inside an opaque sandboxed frame.
// PDF.js first tries a real Worker and, when the sandbox rejects that worker,
// falls back to importing workerSrc on the main thread. A root-relative string
// cannot be resolved from the blob module during that fallback. Always hand
// PDF.js an absolute HTTP(S) URL derived from the frame's real document URL so
// both the worker attempt and the main-thread fallback have a valid target.
export function resolvePdfWorkerUrl(locationHref) {
  let url
  try {
    url = new URL(PDF_WORKER_PATH, locationHref)
  } catch {
    throw new Error('Could not resolve the PDF worker from this app frame.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported PDF worker URL protocol: ${url.protocol}`)
  }
  return url.href
}

export function configurePdfJsWorker(pdfjs, locationHref) {
  if (!pdfjs?.GlobalWorkerOptions) {
    throw new Error('PDF.js worker options are unavailable.')
  }
  pdfjs.GlobalWorkerOptions.workerSrc = resolvePdfWorkerUrl(locationHref)
  return pdfjs
}
