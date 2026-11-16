// Run with Electron inside Docker; all icons derive from the unchanged source PNG.
// xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/generate-brand-icons.cjs
const {app, nativeImage} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const {deflateSync} = require('node:zlib');
const root = path.resolve(__dirname, '..');

function rgbPng(image) {
  const {width,height} = image.getSize(), bitmap = image.toBitmap();
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const at = (y*width+x)*4, to = y*(1+width*3)+1+x*3;
    if (bitmap[at+3] !== 255) throw new Error('The iOS source logo must be opaque.');
    rows[to]=bitmap[at+2]; rows[to+1]=bitmap[at+1]; rows[to+2]=bitmap[at];
  }
  const chunk = (type, data) => {
    const tag = Buffer.from(type), body = Buffer.concat([tag,data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    let crc = 0xffffffff;
    for (const byte of body) {crc ^= byte; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    head.writeUInt32BE(data.length); tail.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([head,body,tail]);
  };
  const header = Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}

async function main() {
  const original = nativeImage.createFromPath(path.join(root, 'logo/anote_logo_alpha.png'));
  const opaqueOriginal = nativeImage.createFromPath(path.join(root, 'logo/anote_logo.png'));
  const {width, height} = original.getSize();
  if (original.isEmpty() || width !== height || width < 1024)
    throw new Error('The source logo must be a square PNG of at least 1024 × 1024 pixels.');
  if (opaqueOriginal.isEmpty() || opaqueOriginal.getSize().width !== opaqueOriginal.getSize().height)
    throw new Error('A square opaque source PNG is required for iOS icons.');
  const png = size => original.resize({width:size, height:size, quality:'best'}).toPNG();
  const write = async (file, content) => {
    const destination = path.join(root, file);
    await fs.mkdir(path.dirname(destination), {recursive:true});
    await fs.writeFile(destination, content);
  };
  await write('apps/desktop/renderer/assets/anote-logo.png', png(128));
  await write('apps/desktop/assets/anote.png', png(512));
  await write('apps/web/public/favicon-32.png', png(32));
  await write('apps/web/public/apple-touch-icon.png', rgbPng(opaqueOriginal.resize({width:180,height:180,quality:'best'})));
  // Preserve the legacy /favicon.ico → /favicon.svg redirect and old bookmarks.
  await write('apps/web/public/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><image width="128" height="128" href="data:image/png;base64,${png(128).toString('base64')}"/></svg>\n`);

  // ICO accepts lossless PNG entries, preserving high DPI Windows icons.
  const sizes = [16, 24, 32, 48, 64, 128, 256], images = sizes.map(png);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const at = 6 + index * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(images[index].length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  });
  const ico = Buffer.concat([header, ...images]);
  await write('apps/desktop/assets/anote.ico', ico);
  await write('apps/web/public/favicon.ico', ico);

  const chunks = [['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024]].map(([type,size]) => {
    const data = png(size), entry = Buffer.alloc(8);
    entry.write(type, 0, 4, 'ascii'); entry.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([entry, data]);
  });
  const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns');
  icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, entry) => sum + entry.length, 0), 4);
  await write('apps/desktop/assets/anote.icns', Buffer.concat([icnsHeader, ...chunks]));

  for (const [density,size] of [['mdpi',48],['hdpi',72],['xhdpi',96],['xxhdpi',144],['xxxhdpi',192]])
    await write(`apps/mobile/android/app/src/main/res/mipmap-${density}/ic_anote.png`, png(size));
  await write('apps/mobile/harmonyos/AppScope/resources/base/media/app_icon.png', png(512));

  // Explicit iPhone/iPad sizes keep the existing iOS 15 deployment target supported.
  const icons = [];
  for (const [idiom,points,scales] of [
    ['iphone',20,[2,3]],['iphone',29,[2,3]],['iphone',40,[2,3]],['iphone',60,[2,3]],
    ['ipad',20,[1,2]],['ipad',29,[1,2]],['ipad',40,[1,2]],['ipad',76,[1,2]],['ipad',83.5,[2]],
    ['ios-marketing',1024,[1]],
  ]) for (const scale of scales) {
    const size = points * scale, filename = `icon-${size}.png`;
    // iOS rejects alpha channels, even when every alpha sample is opaque.
    const opaque = opaqueOriginal.resize({width:size,height:size,quality:'best'});
    await write(`apps/mobile/ios/ANote/Assets.xcassets/AppIcon.appiconset/${filename}`, rgbPng(opaque));
    icons.push({idiom, size:`${points}x${points}`, scale:`${scale}x`, filename});
  }
  await write('apps/mobile/ios/ANote/Assets.xcassets/Contents.json', JSON.stringify({info:{author:'xcode',version:1}}, null, 2)+'\n');
  await write('apps/mobile/ios/ANote/Assets.xcassets/AppIcon.appiconset/Contents.json', JSON.stringify({images:icons,info:{author:'xcode',version:1}}, null, 2)+'\n');
  console.log(`Generated transparent web, desktop, Android and HarmonyOS icons from ${width} × ${height} alpha source; iOS uses RGB PNGs without an alpha channel.`);
}

app.disableHardwareAcceleration();
app.whenReady().then(main).then(() => app.exit(0), error => {console.error(error); app.exit(1);});
