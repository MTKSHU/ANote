import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash,randomUUID} from "node:crypto";

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const digest=value=>createHash("sha256").update(value).digest("hex");
export function patchYTipTapText(source,helper){
  const start=source.indexOf("const findMovedPosition = ("),end=source.indexOf("const mapCharacterPosition = (",start);
  if(start<0||end<=start)throw new Error("Pinned y-tiptap position mapper was not found");
  const embedded=helper.replace("export function createANoteMovedPositionFinder", "function createANoteMovedPositionFinder");
  if(embedded===helper||/^\s*(?:import|export)\s/m.test(embedded))throw new Error("Position mapper helper must be a standalone factory");
  const replacement="/* ANote y-tiptap 3.0.10 bounded position lookup v1. */\n"+embedded.trim()+"\nconst findMovedPosition = createANoteMovedPositionFinder(findMovedNode);\n";
  // The distributed map describes the original line/column positions. The
  // normal application bundlers will generate maps from this patched source.
  return (source.slice(0,start)+replacement+source.slice(end)).replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm,"").trimEnd()+"\n";
}

export function embeddedMigrationCodec(helper){
  const end=helper.indexOf('// Public module interface;');
  if(end<0)throw new Error('Migration codec public-interface marker is missing');
  const factory=helper.slice(0,end).replace('export function createANoteMigrationCodec','function createANoteMigrationCodec').trim();
  if(/^\s*(?:import|export)\s/m.test(factory)||!factory.includes('function createANoteMigrationCodec'))throw new Error('Migration codec must be a standalone factory');
  return factory;
}
export function patchYTipTapMigrationText(source,helper){
  if(source.includes('const anoteMigrationCodec = createANoteMigrationCodec();'))throw new Error('Migration codec patch is already embedded');
  const factory=embeddedMigrationCodec(helper),marker='//#region src/lib/utils/positions/migrations/getPositionMigrationStore.ts';
  if(!source.includes(marker))throw new Error('Pinned migration store region was not found');
  source=source.replace(marker,'/* ANote lossless position migration encoding v2. */\n'+factory+'\nconst anoteMigrationCodec = createANoteMigrationCodec();\n'+marker);
  const candidatesStart=source.indexOf('//#region src/lib/utils/positions/migrations/getPositionMigrationCandidates.ts'),candidatesEnd=source.indexOf('//#endregion',candidatesStart);
  if(candidatesStart<0||candidatesEnd<0)throw new Error('Pinned migration candidates region was not found');
  source=source.slice(0,candidatesStart)+'//#region src/lib/utils/positions/migrations/getPositionMigrationCandidates.ts\nconst getPositionMigrationCandidates = (store, position) => anoteMigrationCodec.candidates(store, position);\n'+source.slice(candidatesEnd);
  const writerStart=source.indexOf('//#region src/lib/utils/positions/migrations/writePositionMigration.ts'),writerEnd=source.indexOf('//#endregion',writerStart);
  if(writerStart<0||writerEnd<0)throw new Error('Pinned migration writer region was not found');
  const writer=source.slice(writerStart,writerEnd),start='\tstore.set(`${doc.clientID}:${clock}`, {',end='\n\t});\n};';
  if(!writer.includes(start)||!writer.includes(end))throw new Error('Pinned migration writer shape changed');
  const updated=writer.replace(start,'\tconst migration = {').replace(end,'\n\t};\n\tstore.set(`${doc.clientID}:${clock}`, anoteMigrationCodec.documentEncoding(doc) === 2 ? anoteMigrationCodec.encode(migration) : migration);\n};');
  source=source.slice(0,writerStart)+updated+source.slice(writerEnd);
  const restore='store.forEach((migration) => migration.transfers.forEach(({ source, target }) => {';
  if(source.split(restore).length!==2)throw new Error('Pinned migration restore path changed');
  return source.replace(restore,'store.forEach((migration) => anoteMigrationCodec.decode(migration).transfers.forEach(({ source, target }) => {').replace(/^\/\/# sourceMappingURL=.*(?:\r?\n|$)/gm,'').trimEnd()+'\n';
}

export async function applyYTipTapPatch({check=false}={}){
  const manifest=JSON.parse(await fs.readFile(path.join(root,"patches/y-tiptap-3.0.10-position-index.json"),"utf8")),directory=path.join(root,"node_modules/@tiptap/y-tiptap");
  if(manifest.package!=="@tiptap/y-tiptap"||manifest.version!=="3.0.10")throw new Error("Invalid pinned performance patch manifest");
  if(manifest.helperFile!=="patches/y-tiptap-position-lookup.mjs"||manifest.files?.length!==2||new Set(manifest.files.map(item=>item.path)).size!==2)throw new Error("Performance patch must cover the pinned helper and both module formats");
  const installed=JSON.parse(await fs.readFile(path.join(directory,"package.json"),"utf8"));
  if(installed.version!==manifest.version)throw new Error("Position lookup patch requires exactly @tiptap/y-tiptap "+manifest.version);
  const helper=await fs.readFile(path.join(root,manifest.helperFile),"utf8");
  if(digest(helper)!==manifest.helperSha256)throw new Error("Position lookup helper changed; review and regenerate pinned patch hashes");
  if(manifest.migrationHelperFile!=='patches/y-tiptap-migration-codec.mjs')throw new Error('Pinned migration codec helper is missing');
  const migrationHelper=await fs.readFile(path.join(root,manifest.migrationHelperFile),'utf8');
  if(digest(migrationHelper)!==manifest.migrationHelperSha256)throw new Error('Migration codec helper changed; review and regenerate pinned patch hashes');
  const plans=[];
  for(const item of manifest.files){
    if(!["dist/index.js","dist/index.cjs"].includes(item.path))throw new Error("Unexpected performance patch target");
    const file=path.join(directory,item.path),source=await fs.readFile(file,"utf8"),current=digest(source);
    if(current===item.patchedSha256){
      if(!source.includes(helper.replace("export function createANoteMovedPositionFinder","function createANoteMovedPositionFinder").trim())||!source.includes("const findMovedPosition = createANoteMovedPositionFinder(findMovedNode);"))throw new Error("Embedded performance helper does not match the pinned helper in "+item.path);
      if(!source.includes(embeddedMigrationCodec(migrationHelper))||!source.includes('const getPositionMigrationCandidates = (store, position) => anoteMigrationCodec.candidates(store, position);')||!source.includes('anoteMigrationCodec.decode(migration).transfers'))throw new Error('Embedded migration codec does not match the pinned helper in '+item.path);
      continue;
    }
    if(current!==item.originalSha256&&current!==item.previousPatchedSha256)throw new Error("Unexpected upstream or modified "+item.path+"; refusing to apply performance patch");
    if(check)throw new Error("Performance patch has not been applied to "+item.path);
    const patched=patchYTipTapMigrationText(current===item.originalSha256?patchYTipTapText(source,helper):source,migrationHelper);
    if(digest(patched)!==item.patchedSha256)throw new Error("Pinned patched hash does not match "+item.path);
    plans.push({file,patched});
  }
  for(const {file,patched} of plans){const temporary=file+".anote-"+randomUUID()+".tmp";try{await fs.writeFile(temporary,patched,{mode:(await fs.stat(file)).mode});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}
  return {package:manifest.package,version:manifest.version,patch:"bounded-position-lookup-v1-and-migration-encoding-v2",appliedFiles:plans.map(item=>path.relative(directory,item.file)),verifiedFiles:manifest.files.map(item=>({path:item.path,sha256:item.patchedSha256})),upstreamSourceMapsRemoved:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.slice(2).some(value=>value!=="--check")){console.error("Usage: node scripts/apply-y-tiptap-performance-patch.mjs [--check]");process.exitCode=1;}
  else applyYTipTapPatch({check:process.argv.includes("--check")}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
