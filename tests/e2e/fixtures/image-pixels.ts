import type { ElectronApplication, Page } from '@playwright/test'

interface FrameColors { width: number; height: number; orange: number; blue: number }

async function decodeFrameColors(encoded: string): Promise<FrameColors> {
  const image = new Image()
  image.src = `data:${encoded.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'};base64,${encoded}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')!
  context.drawImage(image, 0, 0)
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  let orange = 0
  let blue = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset] > 220 && data[offset + 1] > 75 && data[offset + 1] < 145 && data[offset + 2] < 40) orange++
    if (data[offset] < 40 && data[offset + 1] > 120 && data[offset + 2] > 200) blue++
  }
  return { width: canvas.width, height: canvas.height, orange, blue }
}

/** NativeImage's raw channel order differs across codecs; canvas decoding defines RGBA. */
export async function browserFrameColors(page: Page, encoded: string): Promise<FrameColors> {
  return page.evaluate(decodeFrameColors, encoded)
}

/** The minimal hidden host forbids data images; decode the fixture frame inside its unprivileged guest. */
export async function browserGuestFrameColors(app: ElectronApplication, contentsId: number, encoded: string): Promise<FrameColors> {
  const script = `(${decodeFrameColors.toString()})(${JSON.stringify(encoded)})`
  return app.evaluate(async ({ webContents }, { contentsId, script }) => webContents.fromId(contentsId)!.executeJavaScript(script), { contentsId, script })
}
