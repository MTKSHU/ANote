import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {version}=JSON.parse(await fs.readFile(path.join(root,'apps/desktop/package.json'),'utf8'));
if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw new Error('Mobile builds require a numeric desktop release version');
const [major,minor,patch]=version.split('.').map(Number);
if(major>999||minor>99||patch>99)throw new Error('Mobile version components exceed the supported build-number range');
const versionCode=major*10000+minor*100+patch;
const metadata={format:'anote-mobile-build-version',version,versionCode};
if(process.argv[2]==='--prepare'){
  const target=path.resolve(process.argv[3]||'');
  if(!process.argv[3])throw new Error('Mobile artifact directory is required');
  await fs.mkdir(target,{recursive:true});
  const names=await fs.readdir(target);
  if(names.some(name=>/^ANote-\d+\.\d+\.\d+-/.test(name)&&!name.startsWith('ANote-'+version+'-')))throw new Error('Do not overwrite another mobile release directory');
  const file=path.join(target,'mobile-version.json'),previous=await fs.readFile(file,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(previous&&(previous.version!==version||previous.versionCode!==versionCode))throw new Error('Mobile artifact version differs from desktop');
  await fs.writeFile(file,JSON.stringify(metadata,null,2)+'\n');
}else{
  const updates=[
    ['apps/mobile/android/app/build.gradle',text=>text.replace(/versionCode \d+/,`versionCode ${versionCode}`).replace(/versionName '\d+\.\d+\.\d+'/,`versionName '${version}'`)],
    ...['apps/mobile/harmonyos/AppScope/app.json5','apps/mobile/harmonyos/oh-package.json5','apps/mobile/harmonyos/entry/oh-package.json5'].map(file=>[file,text=>text.replace(/"versionCode":\s*\d+/,`"versionCode": ${versionCode}`).replace(/"(versionName|version)":\s*"\d+\.\d+\.\d+"/g,(_,key)=>`"${key}": "${version}"`)]),
    ...['Info.plist','Info.Debug.plist'].map(file=>['apps/mobile/ios/ANote/'+file,text=>text.replace(/(<key>CFBundleShortVersionString<\/key><string>)[^<]+/,(_,prefix)=>prefix+version).replace(/(<key>CFBundleVersion<\/key><string>)[^<]+/,(_,prefix)=>prefix+versionCode)]),
  ];
  for(const [relative,transform] of updates){
    const file=path.join(root,relative),before=await fs.readFile(file,'utf8'),after=transform(before);
    if(process.argv[2]==='--check'){if(before!==after)throw new Error('Mobile version is out of sync: '+relative);}
    else if(before!==after)await fs.writeFile(file,after);
  }
  if(process.argv[2]==='--print')console.log(version+' '+versionCode);
}
