export const FUNCTION_RUNTIME: string
export const FUNCTION_FILE: string
export const APP_BASE: string

export interface OutputRoute {
  src?: string
  dest?: string
  headers?: Record<string, string>
  continue?: boolean
  handle?: string
}

export const OUTPUT_CONFIG: { version: 3; routes: OutputRoute[] }

export function buildVercelOutput(outputDir?: string): Promise<{
  bundle: string
  bytes: number
  /** The esbuild metafile's input paths: what the function bundle was built from. */
  inputs: string[]
  /** `<out>/static/app`: the Vite build of web/. */
  staticDir: string
}>
