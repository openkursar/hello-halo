import JSZip from 'jszip'

export interface PreviewDocument {
  name: string
  bytes: Buffer
  marker: string
}

export interface PreviewPatternPdf extends PreviewDocument {
  pattern: number[]
  palette: number[][]
}

export function previewPdf(marker: string): PreviewPatternPdf {
  if (!/^[\da-f]{32}$/i.test(marker)) throw new Error('The PDF pattern requires a 32-digit hexadecimal marker')
  const palette = [[224, 24, 48], [16, 144, 80], [24, 96, 224], [232, 184, 16]]
  const pattern = [...marker].flatMap(character => {
    const value = parseInt(character, 16)
    return [value >> 2, value & 3]
  })
  const cells = pattern.map((color, index) => {
    const x = 72 + index % 8 * 32
    const y = 400 - 72 - (Math.floor(index / 8) + 1) * 32
    return `${palette[color].map(channel => (channel / 255).toFixed(8)).join(' ')} rg\n${x} ${y} 32 32 re f`
  })
  const stream = `BT\n/F1 10 Tf\n36 372 Td\n(Preview marker ${marker}) Tj\n0 -18 Td\n(Quantity 87261345.25) Tj\nET\n${cells.join('\n')}\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return { name: 'preview-pattern.pdf', bytes: Buffer.from(pdf), marker, pattern, palette }
}

function xmlText(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error('Presentation text cannot contain XML control characters')
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

export async function previewPresentation(marker: string): Promise<PreviewDocument> {
  const zip = new JSZip()
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
  const officeRelationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main'
  const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main'
  const namespaces = `xmlns:a="${drawing}" xmlns:r="${officeRelationships}" xmlns:p="${presentation}"`
  const file = (name: string, xml: string) => zip.file(name, declaration + xml, { date: new Date('2026-01-01T00:00:00Z') })
  const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  const partTypes: Record<string, string> = {
    '/ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    '/ppt/slides/slide1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    '/ppt/slideLayouts/slideLayout1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
    '/ppt/slideMasters/slideMaster1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    '/ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
    '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml',
    '/docProps/app.xml': 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  }
  file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(partTypes).map(([PartName, ContentType]) => `<Override PartName="${PartName}" ContentType="${ContentType}"/>`).join('')}</Types>`)
  file('_rels/.rels', `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="${relationships}/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${officeRelationships}/extended-properties" Target="docProps/app.xml"/></Relationships>`)
  file('docProps/core.xml', `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Preview presentation ${xmlText(marker)}</dc:title><dc:creator>Synthetic acceptance document</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created></cp:coreProperties>`)
  file('docProps/app.xml', '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Acceptance fixture</Application><PresentationFormat>On-screen Show (4:3)</PresentationFormat><Slides>1</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides></Properties>')
  file('ppt/presentation.xml', `<p:presentation ${namespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`)
  file('ppt/_rels/presentation.xml.rels', `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${officeRelationships}/slide" Target="slides/slide1.xml"/></Relationships>`)
  const paragraphs = ['Preview presentation', marker, 'Quantity 87261345.25'].map(line => `<a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>${xmlText(line)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>`).join('')
  file('ppt/slides/slide1.xml', `<p:sld ${namespaces}><p:cSld><p:spTree>${group}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Preview evidence"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="5486400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`)
  file('ppt/slides/_rels/slide1.xml.rels', `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`)
  file('ppt/slideLayouts/slideLayout1.xml', `<p:sldLayout ${namespaces} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
  file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`)
  file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster ${namespaces}><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`)
  file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${officeRelationships}/theme" Target="../theme/theme1.xml"/></Relationships>`)
  const colors: Record<string, string> = { dk1: '000000', lt1: 'FFFFFF', dk2: '202020', lt2: 'EEEEEE', accent1: 'E01830', accent2: '109050', accent3: '1860E0', accent4: 'E8B810', accent5: '7848A0', accent6: '20B8B8', hlink: '0000FF', folHlink: '800080' }
  const fonts = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>'
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  const line = `<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`
  file('ppt/theme/theme1.xml', `<a:theme xmlns:a="${drawing}" name="Acceptance"><a:themeElements><a:clrScheme name="Acceptance">${Object.entries(colors).map(([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join('')}</a:clrScheme><a:fontScheme name="Acceptance"><a:majorFont>${fonts}</a:majorFont><a:minorFont>${fonts}</a:minorFont></a:fontScheme><a:fmtScheme name="Acceptance"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${line.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`)
  return { name: 'preview-presentation.pptx', bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), marker }
}
