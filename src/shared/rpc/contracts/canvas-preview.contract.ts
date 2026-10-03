/**
 * HTML preview origin RPC contract. The canvas asks the main process to serve
 * an HTML file's directory under its own `halo-preview://<host>` origin and
 * releases it when the preview goes away. Only for a file inside a space;
 * other files are refused and preview with srcdoc. Desktop only: a remote
 * client has no local file and previews with srcdoc instead.
 */
import { rpcMethod } from '../define'

export const canvasPreviewRpc = {
  openHtmlPreview: rpcMethod<[filePath: string], { url: string; host: string }>('canvas-preview:open'),
  closeHtmlPreview: rpcMethod<[host: string], void>('canvas-preview:close'),
}
