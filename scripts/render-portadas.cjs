'use strict';
// Exportación automatizada del canvas ORIGINAL de r_news: no recrear su diseño.
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const ROOT = path.resolve(__dirname, '..');
const REQUESTS = path.join(ROOT, 'requests');
const OUTPUT = path.join(ROOT, 'portadas');
const GENERATOR = 'https://iniwor.github.io/r_news/';
const REF = process.env.GITHUB_REF_NAME || 'main';
const SAFE = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const TARGET_WEBP_BYTES = 700 * 1024;
const WEBP_QUALITIES = [90, 87, 84, 82];

function validate(name, data) {
  const id = path.basename(name, '.json');
  if (!SAFE.test(id) || !Array.isArray(data.items) || data.items.length < 1 || data.items.length > 3) {
    throw new Error('Solicitud inválida: ' + name);
  }
  const slugs = new Set();
  for (const item of data.items) {
    if (!item || typeof item.titulo !== 'string' || !item.titulo.trim() || item.titulo.length > 160 ||
        typeof item.imagen !== 'string' || !/^https:\/\//.test(item.imagen) ||
        typeof item.seccion !== 'string' || !item.seccion.trim() || item.seccion.length > 22 ||
        (item.imagenes_alternativas !== undefined &&
          (!Array.isArray(item.imagenes_alternativas) || item.imagenes_alternativas.length > 3 ||
           item.imagenes_alternativas.some(url => typeof url !== 'string' || !/^https:\/\//.test(url)))) ||
        typeof item.slug !== 'string' || !SAFE.test(item.slug) || slugs.has(item.slug)) {
      throw new Error('Noticia inválida en ' + name);
    }
    slugs.add(item.slug);
  }
  return id;
}

async function render(page, item, filepath) {
  await page.goto(GENERATOR, {waitUntil:'domcontentloaded', timeout:45000});
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Listo', null, {timeout:65000});
  await page.evaluate(async input => {
    await window.RotativoBatch.renderFromArray([input]);
  }, item);
  const state = await page.evaluate(() =>
    window.RotativoBatch.getRendered().map(x => ({ok:x.ok,error:x.error}))
  );
  if (state.length !== 1 || !state[0].ok) throw new Error('Fotografía no cargada: ' + JSON.stringify(state));
  await page.addStyleTag({content:[
    // Oculta avisos flotantes de la interfaz: nunca deben formar parte de la portada.
    '#toast {display:none!important}',
    '#cards .card {overflow:visible!important}',
    '#cards .stage {overflow:visible!important;width:1080px!important}',
    '#cards .stage canvas {width:1080px!important;height:1350px!important;max-width:none!important}'
  ].join('\n')});
  const canvas=page.locator('#cards .card canvas').first();
  await canvas.waitFor({state:'visible',timeout:10000});
  if (await page.locator('#toast').isVisible()) throw new Error('Aviso flotante visible: se cancela la captura.');
  await canvas.screenshot({path:filepath,animations:'disabled',timeout:45000});
  const png=await fs.readFile(filepath);
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||width!==1080||height!==1350) {
    throw new Error('PNG inválido, tamaño '+width+'x'+height);
  }
  return {width,height,bytes:png.length};
}

// Una URL que el sitio de origen bloquea no debe arruinar toda la portada.
 // Las alternativas son fotografías verificadas DEL MISMO HECHO, aportadas por el editor.
async function renderWithFallback(page, item, filepath) {
  const candidates = [...new Set([item.imagen, ...(item.imagenes_alternativas || [])])];
  const failures = [];
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    // Reintenta una vez la imagen principal ante un fallo transitorio.
    const attempts = i === 0 ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const dimensions = await render(page, { ...item, imagen: url }, filepath);
        if (i > 0) console.log('Imagen alternativa verificada utilizada para ' + item.slug + ': ' + url);
        return { dimensions, imagen_utilizada: url, alternativa_usada: i > 0, intentos_imagen: failures.length + 1 };
      } catch (err) {
        const reason = String(err.message || err);
        failures.push({ candidata: i + 1, intento: attempt, error: reason });
        console.warn('No se pudo cargar imagen ' + (i + 1) + ' de ' + item.slug + ' (intento ' + attempt + '): ' + reason);
        await fs.rm(filepath, { force: true });
        if (i === 0 && attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }
  }
  throw new Error('No se pudo generar portada ' + item.slug +
    ': agotadas ' + candidates.length + ' URL(s) verificadas. ' + JSON.stringify(failures));
}

async function compressWebp(pngPath, webpPath) {
  const original = (await fs.stat(pngPath)).size;
  let chosen = null;
  // Empieza con calidad 90; baja solo si hace falta para acercarse a 700 KiB.
  for (const quality of WEBP_QUALITIES) {
    const buffer = await sharp(pngPath).webp({ quality, effort: 6, smartSubsample: true }).toBuffer();
    chosen = { buffer, quality };
    if (buffer.length <= TARGET_WEBP_BYTES) break;
  }
  const meta = await sharp(chosen.buffer).metadata();
  if (meta.format !== 'webp' || meta.width !== 1080 || meta.height !== 1350 ||
      chosen.buffer.subarray(0,4).toString() !== 'RIFF' ||
      chosen.buffer.subarray(8,12).toString() !== 'WEBP') {
    throw new Error('WebP inválido o dimensiones inesperadas');
  }
  await fs.writeFile(webpPath, chosen.buffer);
  return {
    formato: 'webp', calidad: chosen.quality,
    bytes: chosen.buffer.length, bytes_png: original,
    ahorro_pct: Math.round((1 - chosen.buffer.length / original) * 100),
    objetivo_700kb: chosen.buffer.length <= TARGET_WEBP_BYTES
  };
}

async function main(){
  await fs.mkdir(REQUESTS,{recursive:true});
  await fs.mkdir(OUTPUT,{recursive:true});
  const files=(await fs.readdir(REQUESTS)).filter(x=>x.endsWith('.json')).sort();
  if(!files.length){console.log('Sin solicitudes.');return;}
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{
    const context=await browser.newContext({viewport:{width:1400,height:1600},deviceScaleFactor:1,locale:'es-MX'});
    const page=await context.newPage();
    for(const filename of files){
      const data=JSON.parse(await fs.readFile(path.join(REQUESTS,filename),'utf8'));
      const id=validate(filename,data);
      const dir=path.join(OUTPUT,id);
      const manifestPath=path.join(dir,'manifest.json');
      try{await fs.access(manifestPath);console.log('Ya generada: '+id);continue;}catch(_){}
      await fs.mkdir(dir,{recursive:true});
      const portadas=[];
      for(const item of data.items){
        const pngPath='portadas/'+id+'/'+item.slug+'.png';
        const webpPath='portadas/'+id+'/'+item.slug+'.webp';
        const {dimensions,imagen_utilizada,alternativa_usada,intentos_imagen}=await renderWithFallback(page,item,path.join(ROOT,pngPath));
        const optimized=await compressWebp(path.join(ROOT,pngPath),path.join(ROOT,webpPath));
        const rootUrl='https://raw.githubusercontent.com/iniwor/r_news/'+REF+'/';
        portadas.push({
          titulo:item.titulo,seccion:item.seccion,slug:item.slug,archivo:webpPath,
          archivo_png:pngPath,
          imagen_utilizada,alternativa_usada,intentos_imagen,
          url_directa:rootUrl+webpPath,
          url_webp:rootUrl+webpPath,
          url_png:rootUrl+pngPath,
          url_pages:'https://iniwor.github.io/r_news/'+webpPath,
          width:dimensions.width,height:dimensions.height,
          ...optimized
        });
        console.log('WebP listo: '+webpPath+' ('+optimized.bytes+' bytes; calidad '+optimized.calidad+')');
      }
      await fs.writeFile(manifestPath,JSON.stringify({
        ok:true,solicitud:id,plantilla:GENERATOR,ref:REF,total:portadas.length,
        generado:new Date().toISOString(),portadas
      },null,2)+'\n');
    }
    await context.close();
  }finally{await browser.close();}
}
main().catch(e=>{console.error(e.stack||String(e));process.exitCode=1;});
